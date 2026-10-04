# SI Local Inferencing — Kiro Crew app

A managed **shell-command runner** for the machine (this WSL) that Kiro Crew's
gateway runs on. Its flagship use is cycling your local LLM backend — the
`ninfer-serve` line — but any shell command works: a profile is a verbatim
command line plus a working directory, extra environment and a shell mode.

> **Trust note.** Enabling this app runs its backend with the same privileges
> as Kiro Crew itself, and the backend can run **any shell command you put in a
> profile**. It is only as safe as the profiles you write. Only enable it if you
> trust it — which is the same rule Kiro Crew applies to all third-party apps.

## What it does

- **Profiles** — named, editable command definitions: `command`, `cwd`,
  `env`, `shell`. Add as many as you like.
- **Know what's loaded** — the profile that is running is badged **RUNNING**
  (and its pid/uptime show in the header and bottom bar); the most recently
  started one is badged **LAST LOADED** when nothing is running.
- **Start / stop / cycle** — one process at a time. Start on a different
  profile while one runs offers to stop the current one first (that's the
  backend-swap workflow). Stop sends SIGTERM to the whole process group,
  waits 8 s, then SIGKILL.
- **Live output** — everything the process prints (stdout + stderr merged) is
  captured and streamed (SSE with an automatic 2 s polling fallback) to:
  - the app page's **Live output** panel,
  - a **switchable full-width bottom bar** — a toggle in the bar hides it and a
    small floating pill restores it; the choice is remembered per browser. The
    **everywhere** toggle in the app page's header makes the bar *persistent*
    — it stays on every dashboard page, not just the app's (see
    [Persistent bottom bar (everywhere)](#persistent-bottom-bar-everywhere)),
  - the **Ninfer Log** side-panel tab, so the output is visible from anywhere
    in the dashboard.
- **Exit tracking** — the last exit (code or signal) and time are persisted.

## Persistent bottom bar (everywhere)

The **everywhere** toggle in the app page's header (next to the status pill,
`everywhere: on/off`) shows the bottom bar on *every* Kiro Crew dashboard
page — settings, chat, anything — not just the app's page. The bar shows the
status dot, the running profile, pid and uptime, and the last line of
process output, plus **Open app** (jump to the app page) and **Hide** (turn
the persistent bar off).

- The choice is remembered per browser (localStorage) and survives
  navigation: the dashboard is a single-page app, and the bar is a plain-DOM
  node mounted on the page body outside the React tree, so it simply stays
  put while you move between pages.
- Turn it off again from the bar's **Hide** button or the app page's toggle.
  While it's on, the app page shows only the persistent bar — the page-local
  bar/pill are suppressed so you never see two bars.

**Full page reloads.** The bar is injected by the app's own UI module, which
loads when you open the app page (or the Ninfer Log side panel). After a hard
reload (F5) of some *other* page it hasn't been loaded yet, so the bar stays
off until you next open the app. An optional userscript closes that gap:

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or
   [Violentmonkey](https://violentmonkey.github.io/)) in the browser you use
   for the dashboard.
2. New script → paste the contents of `scripts/persistent-bar.user.js` →
   save. It matches `http://localhost:5476/`; if your dashboard runs on a
   different host or port, edit the `@match` lines to match.
3. Done — with the flag on, the bar reappears on every full page load.

The script only adds a `<script>` tag for the app's own `ui/bar.mjs`; all
data still flows through the gateway proxy with your normal dashboard
session.

## Install (local directory)

```bash
kirocrew app install /home/stormlrd/dev/silent-imperium-organisation/kirocrew-apps/si-local-inferencing
kirocrew app enable si-local-inferencing
```

The first enable shows a consent dialog naming what the app receives — confirm
it to grant trust to this app only. (App Store equivalent: **Discover →
Sources (gear) → local path → Enable**.)

While developing, `kirocrew app dev si-local-inferencing` toggles dev mode
(live reload on file change).

## Your ninfer profile

Create one profile in the app with:

- **Name:** `ninfer qwen3-27b`
- **Working directory:** the directory the command is run from — the ninfer
  repo root (the command uses the relative path `./ninfer/build/...`)
- **Shell mode:** `login` normally; use `interactive` if ninfer only starts
  under a login/interactive shell (e.g. it needs something `.bashrc` sets up)
- **Command (verbatim):**

  ```
  ./ninfer/build/apps/ninfer-serve models/qwen3_8_27b_nvfp4_v3.ninfer --host 127.0.0.1 --port 1234 --max-context 131072 --kv-capacity 212992 --prefill-chunk 16384 --max-concurrency 2 --spec mtp --draft-tokens 3 --lm-head-draft --kv-dtype nvfp4 --preserve-thinking --device-state-slots 3 --host-kv-mib 4096 --temperature 1.0 --top-p 0.95 --top-k 20 --min-p 0.0 --pending-timeout-ms 180000 --vision
  ```

The command textarea placeholder already contains this exact line, so you can
paste it straight in. Kiro Crew's dashboard keeps working normally while
ninfer runs or restarts — the app is a separate backend process; the only
shared resource is the GPU.

### Shell modes

| Mode | How it runs | Use when |
|---|---|---|
| `login` (default) | `bash -lc "<command>"` | normal scripts; reads `.bash_profile`/`.profile` |
| `interactive` | `bash -ilc "<command>"` | the tool only starts in a full interactive terminal (reads `.bashrc` too) |
| `plain` | `sh -c "<command>"` | minimal POSIX shell |
| `exec` | the command line is shlex-split and run directly | no shell semantics wanted |

### Extra environment

Per-profile `KEY=VALUE` lines (up to 32) are added on top of the backend's own
environment. Typical use: `CUDA_VISIBLE_DEVICES=0`. Note the backend is
spawned by the gateway with a scrubbed environment, so anything the command
needs from your login shell must come from the shell mode above or be set
explicitly here.

## Where things live

- App data: `~/.kiro/crew/apps/si-local-inferencing/data/`
  - `state.json` — profiles, last-started profile, last exit
  - `run.json` — written while a process is managed (used for re-adoption
    after a backend restart)
  - `logs/process.log` (and `.log.1`) — the captured process output, rotated
    at ~5 MiB; the UI's ring buffer holds the most recent 2000 lines
- Backend stdout: `~/.kiro/crew/apps/si-local-inferencing/data/logs/backend.log`

Disabling or uninstalling the app keeps this data directory; `kirocrew app
uninstall si-local-inferencing --purge-data` deletes it.

## Known limitation

The backend (and therefore your ninfer process) runs inside Kiro Crew's app
sandbox — the gateway's cgroup/rlimit ceiling applies to it. If a large
`--host-kv-mib` setting is killed by the OOM killer, the app will show the
exit as **signal 9** (SIGKILL). If that bites, drop the host KV size or run
ninfer outside the app.
