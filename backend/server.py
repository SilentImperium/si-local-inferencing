#!/usr/bin/env python3
"""SI Local Inferencing - Kiro Crew app backend.

A managed shell-command runner. The dashboard defines named *profiles*
(verbatim shell command + working dir + env + shell mode) and this backend
runs at most one profile at a time as a child in its own process group,
capturing everything it prints. The Kiro Crew gateway reverse-proxies
``/apps/{name}/api/*`` to this server; the UI talks to the gateway, and the
gateway signs every proxied request with an HMAC we verify here before
touching anything.

Endpoints (as seen by the gateway, which prepends /api/):
  GET    /health            open liveness probe (must stay unauthenticated)
  GET    /api/state         profiles + process + last exit + log cursor
  POST   /api/profiles      create profile
  PUT    /api/profiles/<id> update profile
  DELETE /api/profiles/<id> delete profile
  POST   /api/process/start {profile_id, stop_current?}
  POST   /api/process/stop  {grace_ms?}
  GET    /api/logs/tail     ?after=<seq>&limit=<n>
  GET    /api/logs/stream   SSE: seed of lines after ?after= (or Last-Event-ID)
                            then live "line" / "exit" events, 15s heartbeats

Stdlib only - the gateway spawns this with a scrubbed env and no
requirements.txt, so nothing may need provisioning.

Env set by the gateway at spawn:
  PORT                   loopback port to bind (allocated from 9100-9200)
  KIROCREW_APP_NAME      the app name
  KIROCREW_HOME          the Kiro Crew config directory
  KIROCREW_PROXY_SECRET  shared secret for X-KiroCrew-Proxy verification
"""

import hashlib
import hmac
import json
import os
import queue
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_NAME = os.environ.get("KIROCREW_APP_NAME", "si-local-inferencing")
APP_VERSION = "0.1.0"
PROXY_SECRET = os.environ.get("KIROCREW_PROXY_SECRET", "")
MAX_SKEW_S = 60
LOG_RING_SIZE = 2000
LOG_FILE_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_STOP_GRACE_S = 8.0
SHELL_MODES = ("login", "interactive", "plain", "exec")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

DATA_DIR = Path(os.environ.get("KIROCREW_HOME", str(Path.home() / ".kiro" / "crew"))) / "apps" / APP_NAME / "data"
LOG_DIR = DATA_DIR / "logs"
STATE_FILE = DATA_DIR / "state.json"
RUN_FILE = DATA_DIR / "run.json"
LOG_FILE = LOG_DIR / "process.log"
LOG_BACKUP = LOG_DIR / "process.log.1"

LOCK = threading.RLock()
RING = deque(maxlen=LOG_RING_SIZE)          # (seq, text)
WATCHERS = []                               # queue.Queue per SSE client
SEQ = 0
RUN = None                                  # managed process record or None
SERVER = None
STATE = {"profiles": [], "last_started_profile_id": None, "last_exit": None}


class ApiError(Exception):
    def __init__(self, status, msg, extra=None):
        super().__init__(msg)
        self.status = status
        self.msg = msg
        self.extra = extra or {}


# ---------------------------------------------------------------------------
# state persistence


def _load_state():
    global STATE
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    STATE = {"profiles": [], "last_started_profile_id": None, "last_exit": None}
    if STATE_FILE.exists():
        try:
            d = json.loads(STATE_FILE.read_text())
            if isinstance(d, dict):
                STATE["profiles"] = [p for p in d.get("profiles", []) if isinstance(p, dict)]
                STATE["last_started_profile_id"] = d.get("last_started_profile_id")
                STATE["last_exit"] = d.get("last_exit")
        except Exception:
            print("[si] state.json unreadable; starting fresh", flush=True)


def _save_state():
    """Caller must hold LOCK."""
    tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
    tmp.write_text(json.dumps(STATE, indent=2))
    tmp.replace(STATE_FILE)


# ---------------------------------------------------------------------------
# log buffer


def _append_line(text):
    global SEQ
    with LOCK:
        SEQ += 1
        seq = SEQ
        RING.append((seq, text))
        try:
            if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_FILE_MAX_BYTES:
                LOG_FILE.replace(LOG_BACKUP)
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(text + "\n")
        except Exception:
            pass
        for q in list(WATCHERS):
            try:
                q.put_nowait(("line", {"seq": seq, "text": text}))
            except Exception:
                pass


def tail_logs(qs):
    try:
        after = int((qs.get("after") or ["0"])[0])
    except (ValueError, IndexError):
        after = 0
    try:
        limit = int((qs.get("limit") or ["300"])[0])
    except (ValueError, IndexError):
        limit = 300
    limit = max(1, min(limit, 1000))
    with LOCK:
        lines = [list(it) for it in RING if it[0] > after][-limit:]
        seq = SEQ
    return {"lines": lines, "next": seq}


# ---------------------------------------------------------------------------
# /proc helpers (linux)


def _pid_alive(pid):
    return os.path.isdir("/proc/%d" % pid)


def _read_stat_field(pid, field):
    """Read field N of /proc/<pid>/stat (comm may contain spaces/parens)."""
    try:
        data = Path("/proc/%d/stat" % pid).read_text()
    except Exception:
        return None
    try:
        tail = data.rsplit(")", 1)[1].split()
        return int(tail[field - 3])
    except (IndexError, ValueError):
        return None


# ---------------------------------------------------------------------------
# process lifecycle


def _proc_alive(run):
    if run.get("attached") and run.get("proc") is not None:
        try:
            return run["proc"].poll() is None
        except Exception:
            return False
    return _pid_alive(run["pid"])


def _describe_exit(info):
    if info.get("signal"):
        return "signal %d" % info["signal"]
    if info.get("code") is not None:
        return "code %d" % info["code"]
    return "unknown exit"


def _record_exit(run, code):
    """Caller must hold LOCK."""
    if code is None:
        sig, c = None, None
    elif code < 0:
        sig, c = -code, None
    else:
        sig, c = None, code
    info = {
        "profile_id": run.get("profile_id"),
        "profile_name": run.get("profile_name"),
        "code": c,
        "signal": sig,
        "at": time.time(),
    }
    # A detached process (re-adopted after a backend crash) is not our child,
    # so we can never read its wait status; say so instead of guessing.
    if c is None and sig is None and not run.get("attached"):
        info["detached"] = True
    STATE["last_exit"] = info
    _save_state()
    for q in list(WATCHERS):
        try:
            q.put_nowait(("exit", info))
        except Exception:
            pass
    return info


def _stop_locked(grace_s):
    """Stop the managed process. Caller must hold LOCK. Returns exit info or None."""
    global RUN
    run = RUN
    if run is None:
        return None
    pid, pgid = run["pid"], run["pgid"]
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    deadline = time.time() + grace_s
    while time.time() < deadline and _proc_alive(run):
        time.sleep(0.1)
    killed = False
    if _proc_alive(run):
        killed = True
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        deadline = time.time() + 3.0
        while time.time() < deadline and _proc_alive(run):
            time.sleep(0.1)
    code = None
    proc = run.get("proc")
    if run.get("attached") and proc is not None:
        try:
            proc.wait(timeout=3.0)
        except Exception:
            pass
        code = proc.returncode
    info = _record_exit(run, code)
    RUN = None
    _delete_run_file()
    _save_state()
    _append_line(
        "[si] stopped '%s' (pid %d)%s"
        % (run.get("profile_name") or "process", pid, " - SIGKILL after grace" if killed else "")
    )
    return info


def stop_process(grace_s=DEFAULT_STOP_GRACE_S):
    with LOCK:
        if RUN is None:
            return {"stopped": False, "running": False}
        info = _stop_locked(grace_s)
    return {"stopped": True, "running": False, "exit": info}


def start_process(profile_id, stop_current):
    """Returns (run_record, ApiError-or-None)."""
    global RUN
    with LOCK:
        if RUN is not None:
            if not stop_current:
                return None, ApiError(
                    409,
                    "a process is already running (%s)"
                    % (RUN.get("profile_name") or RUN.get("command") or "pid %d" % RUN["pid"]),
                    {"running_profile_id": RUN.get("profile_id"), "pid": RUN["pid"]},
                )
            _stop_locked(DEFAULT_STOP_GRACE_S)
        prof = next((p for p in STATE["profiles"] if p.get("id") == profile_id), None)
        if prof is None:
            return None, ApiError(404, "no such profile: %s" % profile_id)
        cwd = prof.get("cwd") or "~"
        if not os.path.isdir(cwd):
            return None, ApiError(400, "working directory does not exist: %s" % cwd)
        cmd = prof["command"]
        shell = prof.get("shell") or "login"
        if shell == "login":
            argv = ["bash", "-lc", cmd]
        elif shell == "interactive":
            argv = ["bash", "-ilc", cmd]
        elif shell == "plain":
            argv = ["sh", "-c", cmd]
        else:
            try:
                argv = shlex.split(cmd)
            except ValueError as e:
                return None, ApiError(400, "cannot parse command for exec mode: %s" % e)
            if not argv:
                return None, ApiError(400, "command is empty")
        env = dict(os.environ)
        env.update(prof.get("env") or {})
        try:
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as e:
            return None, ApiError(400, "failed to start process: %s" % e)
        run = {
            "proc": proc,
            "pid": proc.pid,
            "pgid": proc.pid,
            "attached": True,
            "profile_id": prof["id"],
            "profile_name": prof.get("name"),
            "command": cmd,
            "started_at": time.time(),
            "start_ticks": _read_stat_field(proc.pid, 22),
        }
        RUN = run
        STATE["last_started_profile_id"] = prof["id"]
        _save_state()
        _write_run_file(run)
    threading.Thread(target=_reader, args=(run,), daemon=True).start()
    threading.Thread(target=_watcher, args=(run,), daemon=True).start()
    _append_line(
        "[si] started '%s' (pid %d, cwd %s, shell %s): %s"
        % (run["profile_name"], run["pid"], cwd, shell, cmd)
    )
    return run, None


def _reader(run):
    proc = run.get("proc")
    if proc is None or proc.stdout is None:
        return
    try:
        while True:
            line = proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip("\n")
            if text:
                _append_line(text)
    except Exception:
        pass
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass


def _watcher(run):
    global RUN
    proc = run.get("proc")
    if proc is None:
        return
    try:
        proc.wait()
    except Exception:
        pass
    time.sleep(0.2)  # give the reader a moment to drain the pipe
    with LOCK:
        if RUN is not run:
            return  # already finalized (e.g. by stop)
        info = _record_exit(run, proc.returncode)
        RUN = None
        _delete_run_file()
    _append_line("[si] '%s' exited: %s" % (run.get("profile_name") or "process", _describe_exit(info)))


def _write_run_file(run):
    try:
        RUN_FILE.write_text(
            json.dumps(
                {
                    "pid": run["pid"],
                    "pgid": run["pgid"],
                    "start_ticks": run.get("start_ticks"),
                    "profile_id": run.get("profile_id"),
                    "profile_name": run.get("profile_name"),
                    "command": run.get("command"),
                    "started_at": run.get("started_at"),
                    "created_by": APP_NAME,
                }
            )
        )
    except Exception:
        pass


def _delete_run_file():
    try:
        RUN_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def reconcile():
    """Re-adopt a managed process still alive after a backend restart."""
    global RUN
    if not RUN_FILE.exists():
        return
    try:
        data = json.loads(RUN_FILE.read_text())
    except Exception:
        _delete_run_file()
        return
    try:
        pid = int(data.get("pid") or 0)
    except (TypeError, ValueError):
        _delete_run_file()
        return
    if not pid or not _pid_alive(pid):
        _delete_run_file()
        return
    ticks = _read_stat_field(pid, 22)
    if data.get("start_ticks") not in (None, ticks):
        print("[si] run.json pid %d belongs to another process; discarding" % pid, flush=True)
        _delete_run_file()
        return
    with LOCK:
        RUN = {
            "proc": None,
            "pid": pid,
            "pgid": _read_stat_field(pid, 5) or pid,
            "attached": False,
            "profile_id": data.get("profile_id"),
            "profile_name": data.get("profile_name"),
            "command": data.get("command"),
            "started_at": data.get("started_at") or time.time(),
            "start_ticks": ticks,
        }
    _append_line(
        "[si] backend restarted; managed process still running (pid %d) - "
        "output not attached, stop still available" % pid
    )


# ---------------------------------------------------------------------------
# state snapshot


def proc_status_locked():
    r = RUN
    if not r:
        return {"running": False}
    return {
        "running": True,
        "attached": r.get("attached", False),
        "pid": r["pid"],
        "pgid": r["pgid"],
        "profile_id": r.get("profile_id"),
        "profile_name": r.get("profile_name"),
        "command": r.get("command"),
        "started_at": r.get("started_at"),
        "uptime_s": round(time.time() - (r.get("started_at") or time.time()), 1),
    }


def state_snapshot():
    with LOCK:
        s = {
            "profiles": list(STATE["profiles"]),
            "last_started_profile_id": STATE["last_started_profile_id"],
            "last_exit": STATE["last_exit"],
            "process": proc_status_locked(),
            "log_seq": SEQ,
        }
    return {
        "app": APP_NAME,
        "version": APP_VERSION,
        "now": time.time(),
        **s,
        "log_file": str(LOG_FILE),
    }


# ---------------------------------------------------------------------------
# profiles


def _validate_profile(d, existing_id=None):
    errors = []
    name = str(d.get("name") or "").strip()
    if not name or len(name) > 64:
        errors.append("name must be 1-64 characters")
    command = str(d.get("command") or "").strip()
    if not command or len(command) > 8192:
        errors.append("command must be 1-8192 characters")
    shell = str(d.get("shell") or "login")
    if shell not in SHELL_MODES:
        errors.append("shell must be one of: %s" % ", ".join(SHELL_MODES))
    cwd = str(d.get("cwd") or "~").strip() or "~"
    if len(cwd) > 512:
        errors.append("cwd too long (max 512)")
    env = d.get("env") or {}
    if not isinstance(env, dict):
        errors.append("env must be an object of KEY=string")
    else:
        if len(env) > 32:
            errors.append("too many env vars (max 32)")
        for k, v in env.items():
            if not _ENV_KEY_RE.match(str(k)):
                errors.append("bad env key: %s" % k)
            if not isinstance(v, str):
                errors.append("env value must be a string: %s" % k)
    if errors:
        raise ApiError(400, "; ".join(errors))
    with LOCK:
        for p in STATE["profiles"]:
            if p.get("id") != existing_id and str(p.get("name", "")).lower() == name.lower():
                raise ApiError(409, "a profile named '%s' already exists" % name)
    return {
        "name": name,
        "command": command,
        "cwd": os.path.expanduser(cwd),
        "env": {str(k): str(v) for k, v in env.items()},
        "shell": shell,
    }


def create_profile(d):
    clean = _validate_profile(d)
    import uuid

    slug = re.sub(r"[^a-z0-9]+", "-", clean["name"].lower()).strip("-") or "profile"
    prof = {
        "id": "%s-%s" % (slug[:32], uuid.uuid4().hex[:6]),
        **clean,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    with LOCK:
        STATE["profiles"].append(prof)
        _save_state()
    return prof


def update_profile(pid, d):
    clean = _validate_profile(d, existing_id=pid)
    with LOCK:
        prof = next((p for p in STATE["profiles"] if p.get("id") == pid), None)
        if prof is None:
            raise ApiError(404, "no such profile: %s" % pid)
        prof.update(clean)
        prof["updated_at"] = time.time()
        _save_state()
    return prof


def delete_profile(pid):
    with LOCK:
        if RUN is not None and RUN.get("profile_id") == pid:
            raise ApiError(409, "cannot delete the running profile; stop the process first")
        before = len(STATE["profiles"])
        STATE["profiles"] = [p for p in STATE["profiles"] if p.get("id") != pid]
        if len(STATE["profiles"]) == before:
            raise ApiError(404, "no such profile: %s" % pid)
        if STATE["last_started_profile_id"] == pid:
            STATE["last_started_profile_id"] = None
        _save_state()
    return {"ok": True}


# ---------------------------------------------------------------------------
# HTTP


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SILocalInferencing/" + APP_VERSION
    timeout = 60

    # -- plumbing ------------------------------------------------------------

    def log_message(self, fmt, *args):
        # keep backend.log quiet: only record errors
        if "%s" in fmt:
            pass
        print("[si-http] %s %s" % (self.address_string(), fmt % args), file=sys.stderr, flush=True)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def _json(self, status, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _authorized(self, body):
        if not PROXY_SECRET:
            return False
        header = self.headers.get("X-KiroCrew-Proxy", "")
        parts = header.split(":", 1)
        if len(parts) != 2:
            return False
        ts, sig = parts
        try:
            ts_i = int(ts)
        except ValueError:
            return False
        if abs(time.time() - ts_i) > MAX_SKEW_S:
            return False
        body_hash = hashlib.sha256(body).hexdigest()
        msg = "%s:%s:%s:%s" % (ts, self.command, self.path, body_hash)
        expected = hmac.new(PROXY_SECRET.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig)

    # -- routing -------------------------------------------------------------

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        body = self._body()
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/health":
                return self._json(
                    200,
                    {"ok": True, "app": APP_NAME, "version": APP_VERSION, "pid": os.getpid()},
                )
            if not path.startswith("/api/"):
                return self._json(404, {"error": "not found"})
            if not self._authorized(body):
                return self._json(401, {"error": "proxy authentication failed"})
            api = path[len("/api/"):]
            qs = parse_qs(parsed.query)

            if method == "GET" and api == "state":
                return self._json(200, state_snapshot())
            if method == "POST" and api == "profiles":
                return self._json(201, create_profile(_json_body(body)))
            m = re.fullmatch(r"profiles/([^/]+)", api)
            if m:
                if method == "PUT":
                    return self._json(200, update_profile(m.group(1), _json_body(body)))
                if method == "DELETE":
                    return self._json(200, delete_profile(m.group(1)))
            if method == "POST" and api == "process/start":
                d = _json_body(body)
                run, err = start_process(str(d.get("profile_id") or ""), bool(d.get("stop_current")))
                if err:
                    raise err
                return self._json(
                    202,
                    {"ok": True, "pid": run["pid"], "pgid": run["pgid"], "profile_id": run["profile_id"]},
                )
            if method == "POST" and api == "process/stop":
                d = _json_body(body)
                try:
                    grace = max(1.0, min(30.0, float(d.get("grace_ms", 8000)) / 1000.0))
                except (TypeError, ValueError):
                    grace = DEFAULT_STOP_GRACE_S
                return self._json(200, stop_process(grace))
            if method == "GET" and api == "logs/tail":
                return self._json(200, tail_logs(qs))
            if method == "GET" and api == "logs/stream":
                return self._sse(qs)
            return self._json(404, {"error": "no such api: %s %s" % (method, api)})
        except ApiError as e:
            return self._json(e.status, {"error": e.msg, **e.extra})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            traceback.print_exc()
            try:
                self._json(500, {"error": "internal error"})
            except Exception:
                pass

    # -- SSE -----------------------------------------------------------------

    def _sse(self, qs):
        try:
            after = int((qs.get("after") or ["0"])[0])
        except (ValueError, IndexError):
            after = 0
        last_event_id = self.headers.get("Last-Event-ID")
        if last_event_id:
            try:
                after = max(after, int(last_event_id))
            except ValueError:
                pass
        q = queue.Queue()
        with LOCK:
            seed = [it for it in RING if it[0] > after][-500:]
            WATCHERS.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "keep-alive")
        self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(b"retry: 500\n\n")
            for seq, text in seed:
                self._sse_event("line", {"seq": seq, "text": text}, seq)
            while True:
                try:
                    kind, payload = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                if kind == "line":
                    self._sse_event("line", payload, payload.get("seq"))
                else:
                    self._sse_event("exit", payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LOCK:
                if q in WATCHERS:
                    WATCHERS.remove(q)
            self.close_connection = True

    def _sse_event(self, event, payload, event_id=None):
        out = ""
        if event_id is not None:
            out += "id: %d\n" % event_id
        out += "event: %s\ndata: %s\n\n" % (event, json.dumps(payload))
        self.wfile.write(out.encode("utf-8"))
        self.wfile.flush()


def _json_body(body):
    if not body:
        return {}
    try:
        d = json.loads(body)
    except Exception:
        raise ApiError(400, "invalid JSON body")
    if not isinstance(d, dict):
        raise ApiError(400, "JSON object expected")
    return d


# ---------------------------------------------------------------------------
# shutdown


def _handle_term(signum, frame):
    threading.Thread(target=_shutdown, daemon=True).start()


def _shutdown():
    try:
        stop_process(grace_s=5.0)
    except Exception:
        pass
    if SERVER is not None:
        try:
            SERVER.shutdown()
        except Exception:
            pass


def main():
    global SERVER
    port = int(os.environ.get("PORT") or "9147")
    _load_state()
    reconcile()
    SERVER = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    SERVER.daemon_threads = True
    print(
        "[si] %s v%s listening on 127.0.0.1:%d (pid %d, data %s)"
        % (APP_NAME, APP_VERSION, port, os.getpid(), DATA_DIR),
        flush=True,
    )
    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)
    try:
        SERVER.serve_forever(poll_interval=0.5)
    finally:
        try:
            with LOCK:
                if RUN is not None:
                    _stop_locked(3.0)
        except Exception:
            pass
        SERVER.server_close()
        print("[si] stopped", flush=True)


if __name__ == "__main__":
    main()
