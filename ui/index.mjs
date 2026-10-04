// Zens Local Inferencing - dashboard page bundle.
//
// Hand-written ESM (no build step): the Kiro Crew host loads this module and
// renders the default-exported component. React, lucide-react and the app SDK
// are injected by the host on window.__kirocrew_modules before the import.

import {
  getState,
  createProfile,
  updateProfile,
  deleteProfile,
  startProcess,
  stopProcess,
  subscribeLogs,
  fmtDur,
  fmtTime,
} from "./lib.mjs"

// Side-effect import: the persistent "everywhere" bar. bar.mjs mounts itself
// on document.body (outside the React tree) when its localStorage flag is on,
// which is what the "everywhere" toggle in the header below controls.
import "./bar.mjs"

const React = window.__kirocrew_modules.react
const { useState, useEffect, useRef, useCallback } = React
const h = React.createElement
const { Cpu, Play, Square, Plus, Pencil, Trash2, Terminal, RefreshCw, X } =
  window.__kirocrew_modules["lucide-react"]

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

const EXAMPLE_COMMAND =
  "./ninfer/build/apps/ninfer-serve models/qwen3_8_27b_nvfp4_v3.ninfer " +
  "--host 127.0.0.1 --port 1234 --max-context 131072 --kv-capacity 212992 " +
  "--prefill-chunk 16384 --max-concurrency 2 --spec mtp --draft-tokens 3 " +
  "--lm-head-draft --kv-dtype nvfp4 --preserve-thinking --device-state-slots 3 " +
  "--host-kv-mib 4096 --temperature 1.0 --top-p 0.95 --top-k 20 --min-p 0.0 " +
  "--pending-timeout-ms 180000 --vision"

const SHELLS = [
  ["login", "login — bash -lc (login shell env)"],
  ["interactive", "interactive — bash -ilc (full terminal env, reads .bashrc)"],
  ["plain", "plain — sh -c"],
  ["exec", "exec — run directly, no shell (command is shlex-split)"],
]

const BAR_STORAGE_KEY = "zli.bar"
const PERSIST_FLAG_KEY = "zli.persistBar"
const PERSIST_FLAG_EVENT = "zli:persist-flag"

function readPersistFlag() {
  try {
    return window.localStorage.getItem(PERSIST_FLAG_KEY) === "1"
  } catch {
    return false
  }
}

function btnStyle(kind) {
  if (kind === "ok")
    return {
      background: "rgba(52,211,153,.12)",
      color: "#34d399",
      border: "1px solid rgba(52,211,153,.4)",
    }
  if (kind === "danger")
    return {
      background: "rgba(248,113,113,.1)",
      color: "#f87171",
      border: "1px solid rgba(248,113,113,.35)",
    }
  return {
    background: "rgba(148,163,184,.08)",
    color: "#cbd5e1",
    border: "1px solid rgba(148,163,184,.25)",
  }
}

function Dot({ tone }) {
  return h("span", {
    style: {
      width: 9,
      height: 9,
      borderRadius: "50%",
      background: tone || "#6b7280",
      display: "inline-block",
      flexShrink: 0,
    },
  })
}

function describeExit(le) {
  if (!le) return ""
  if (le.detached) return "stopped (detached — exit status unknown)"
  if (le.signal) return `signal ${le.signal}`
  if (le.code !== null && le.code !== undefined) return `code ${le.code}`
  return "unknown exit"
}

function ProfileForm({ initial, busy, errors, onClose, onSave }) {
  const [name, setName] = useState(initial?.name || "")
  const [command, setCommand] = useState(initial?.command || "")
  const [cwd, setCwd] = useState(initial?.cwd || "~")
  const [shell, setShell] = useState(initial?.shell || "login")
  const [envText, setEnvText] = useState(
    Object.entries(initial?.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
  )

  const submit = () => {
    const env = {}
    for (const raw of envText.split("\n")) {
      const line = raw.trim()
      if (!line) continue
      const i = line.indexOf("=")
      if (i <= 0) {
        setErrors ? null : null
        onSave(null, "bad env line (expected KEY=VALUE): " + line)
        return
      }
      env[line.slice(0, i).trim()] = line.slice(i + 1)
    }
    onSave({ name: name.trim(), command: command.trim(), cwd: cwd.trim() || "~", shell, env })
  }

  const inputStyle = {
    width: "100%",
    fontFamily: MONO,
    fontSize: 13,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid rgba(148,163,184,.3)",
    background: "rgba(15,23,42,.5)",
    color: "#e2e8f0",
    outline: "none",
    boxSizing: "border-box",
  }

  return h(
    "div",
    {
      key: "profile-form",
      style: {
        gridColumn: "1 / -1",
        border: "1px solid rgba(148,163,184,.3)",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      },
    },
    h("div", { style: { fontWeight: 600, fontSize: 14 } }, initial ? "Edit profile" : "New profile"),
    h(
      "div",
      null,
      h("label", { style: { fontSize: 12, color: "#94a3b8" } }, "Name"),
      h("input", {
        style: inputStyle,
        value: name,
        maxLength: 64,
        placeholder: "e.g. ninfer qwen3-27b",
        onChange: (e) => setName(e.target.value),
      })
    ),
    h(
      "div",
      null,
      h(
        "label",
        { style: { fontSize: 12, color: "#94a3b8" } },
        "Command — exactly as you would type it in the terminal"
      ),
      h("textarea", {
        style: { ...inputStyle, minHeight: 96, resize: "vertical" },
        value: command,
        placeholder: EXAMPLE_COMMAND,
        onChange: (e) => setCommand(e.target.value),
      })
    ),
    h(
      "div",
      { style: { display: "flex", gap: 10 } },
      h(
        "div",
        { style: { flex: 2 } },
        h("label", { style: { fontSize: 12, color: "#94a3b8" } }, "Working directory"),
        h("input", {
          style: inputStyle,
          value: cwd,
          placeholder: "~",
          onChange: (e) => setCwd(e.target.value),
        })
      ),
      h(
        "div",
        { style: { flex: 2 } },
        h("label", { style: { fontSize: 12, color: "#94a3b8" } }, "Shell mode"),
        h(
          "select",
          { style: inputStyle, value: shell, onChange: (e) => setShell(e.target.value) },
          SHELLS.map(([v, label]) => h("option", { key: v, value: v }, label))
        )
      )
    ),
    h(
      "div",
      null,
      h(
        "label",
        { style: { fontSize: 12, color: "#94a3b8" } },
        "Extra environment (one KEY=VALUE per line) — optional"
      ),
      h("textarea", {
        style: { ...inputStyle, minHeight: 56, resize: "vertical" },
        value: envText,
        placeholder: "CUDA_VISIBLE_DEVICES=0",
        onChange: (e) => setEnvText(e.target.value),
      })
    ),
    h(
      "div",
      { style: { display: "flex", gap: 8, marginTop: 4 } },
      h(
        "button",
        {
          style: { ...btnStyle("ok"), padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
          disabled: busy,
          onClick: submit,
        },
        "Save profile"
      ),
      h(
        "button",
        {
          style: { ...btnStyle("ghost"), padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
          onClick: onClose,
        },
        "Cancel"
      )
    )
  )
}

export default function ZensApp() {
  const [state, setState] = useState(null)
  const [lines, setLines] = useState([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null) // null | "new" | profile object
  const [barVisible, setBarVisible] = useState(() => {
    try {
      return window.localStorage.getItem(BAR_STORAGE_KEY) !== "0"
    } catch {
      return true
    }
  })
  const [persistOn, setPersistOn] = useState(readPersistFlag)
  const [autoScroll, setAutoScroll] = useState(true)

  const logRef = useRef(null)
  const lastSeq = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const s = await getState()
      setState(s)
      setError("")
    } catch (e) {
      setError(e.message || String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  const onLine = useCallback((d) => {
    if (!d || !d.seq || d.seq <= lastSeq.current) return
    lastSeq.current = d.seq
    setLines((prev) => {
      const next = prev.length >= 1500 ? prev.slice(-1200) : prev.slice()
      next.push(d)
      return next
    })
  }, [])

  const onExit = useCallback(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const sub = subscribeLogs({ after: 0, onLine, onExit })
    return () => sub.close()
  }, [onLine, onExit, refresh])

  // Keep the "everywhere" toggle in sync with writes from elsewhere: the
  // persistent bar's own Hide button (ui/bar.mjs), another browser tab, etc.
  useEffect(() => {
    const sync = () => setPersistOn(readPersistFlag())
    const onStorage = (e) => {
      if (e.key === PERSIST_FLAG_KEY || e.key === null) sync()
    }
    window.addEventListener(PERSIST_FLAG_EVENT, sync)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener(PERSIST_FLAG_EVENT, sync)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines, autoScroll])

  const act = async (fn) => {
    setBusy(true)
    setError("")
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const proc = (state && state.process) || { running: false }
  const tone = proc.running ? (proc.attached === false ? "#fbbf24" : "#34d399") : "#6b7280"
  const profiles = (state && state.profiles) || []
  const lastExit = state && state.last_exit
  const uptime =
    proc.running && proc.started_at
      ? ((state && state.now) || Date.now() / 1000) - proc.started_at
      : 0

  const doStart = (p) => {
    const switching = proc.running && proc.profile_id !== p.id
    const msg = switching
      ? `Start "${p.name}"? The currently running process (${
          proc.profile_name || proc.command || proc.pid
        }) will be stopped first.`
      : `Start "${p.name}"?\n\n${p.command}`
    if (!window.confirm(msg)) return
    act(async () => {
      await startProcess(p.id, switching)
    })
  }

  const doStop = () => {
    if (!window.confirm(`Stop "${proc.profile_name || "the running process"}" (pid ${proc.pid})?`))
      return
    act(() => stopProcess(8000))
  }

  const doDelete = (p) => {
    if (!window.confirm(`Delete profile "${p.name}"?`)) return
    act(() => deleteProfile(p.id))
  }

  const saveProfile = (data, clientErr) => {
    if (clientErr) {
      setError(clientErr)
      return
    }
    if (!data) return
    act(async () => {
      if (editing === "new") await createProfile(data)
      else await updateProfile(editing.id, data)
      setEditing(null)
    })
  }

  const setBar = (v) => {
    setBarVisible(v)
    try {
      window.localStorage.setItem(BAR_STORAGE_KEY, v ? "1" : "0")
    } catch {
      /* ignore */
    }
  }

  const setPersist = (v) => {
    setPersistOn(v)
    try {
      window.localStorage.setItem(PERSIST_FLAG_KEY, v ? "1" : "0")
    } catch {
      /* ignore */
    }
    try {
      window.dispatchEvent(new CustomEvent(PERSIST_FLAG_EVENT))
    } catch {
      /* ignore */
    }
  }

  const scrollLogIntoView = () => {
    if (logRef.current) logRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }

  const lastLine = lines.length ? lines[lines.length - 1].text : ""
  // When "everywhere" is on, the persistent bar (ui/bar.mjs, mounted on
  // document.body) already covers this page — suppress the page-local bar and
  // the restore pill so only one bar is ever visible.
  const showPageBar = barVisible && !persistOn
  const showPill = !barVisible && !persistOn

  const bar = showPageBar
    ? h(
        "div",
        {
          key: "bar",
          style: {
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            background: "rgba(10,14,23,.96)",
            borderTop: `1px solid ${proc.running ? "rgba(52,211,153,.5)" : "rgba(148,163,184,.25)"}`,
            fontFamily: MONO,
            fontSize: 12,
            color: "#cbd5e1",
          },
        },
        h(Dot, { tone }),
        h(
          "span",
          { style: { fontWeight: 600, whiteSpace: "nowrap" } },
          proc.running ? proc.profile_name || "process" : "idle"
        ),
        proc.running && h("span", { style: { whiteSpace: "nowrap", opacity: 0.7 } }, `pid ${proc.pid} · ${fmtDur(uptime)}`),
        h(
          "span",
          {
            style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 },
            title: lastLine,
          },
          lastLine || (proc.running ? "no output yet" : "nothing running")
        ),
        h(
          "button",
          {
            style: { ...btnStyle("ghost"), padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 },
            onClick: scrollLogIntoView,
          },
          "Show log"
        ),
        h(
          "button",
          {
            style: { ...btnStyle("ghost"), padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 },
            title: "Hide the bottom bar",
            onClick: () => setBar(false),
          },
          "Hide"
        )
      )
    : showPill
    ? h(
        "div",
        {
          key: "bar-pill",
          style: {
            position: "fixed",
            right: 16,
            bottom: 14,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 12px",
            borderRadius: 999,
            background: "rgba(10,14,23,.95)",
            border: "1px solid rgba(148,163,184,.35)",
            cursor: "pointer",
            fontSize: 12,
            color: "#cbd5e1",
          },
          title: "Show the Ninfer bottom bar",
          onClick: () => setBar(true),
        },
        h(Terminal, { size: 14, style: { color: "#94a3b8" } }),
        "Ninfer bar",
        h(Dot, { tone })
      )
    : null

  return h(
    "div",
    {
      className: "px-6 pt-4 pb-8",
      style: {
        paddingBottom: barVisible || persistOn ? 76 : 48, // room for the bar (page-local or persistent)
        maxWidth: 1100,
        margin: "0 auto",
      },
    },
    // header
    h(
      "div",
      { key: "hdr", className: "flex items-center gap-3 mb-4" },
      h("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderRadius: 10,
          background: "rgba(96,165,250,.1)",
          border: "1px solid rgba(96,165,250,.3)",
          color: "#93c5fd",
        },
      },
        h(Cpu, { size: 18 }),
        h("span", { style: { fontSize: 13, fontWeight: 600 } }, "local inferencing")),
      h("div", { style: { flex: 1 } },
        h("h1", { className: "text-2xl font-bold tracking-tight" }, "Zens Local Inferencing"),
        h("p", { className: "text-sm text-muted", style: { marginTop: 2 } },
          "Managed shell-command runner — start/stop your local LLM backend and watch its live output.")),
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 999,
            border: "1px solid rgba(148,163,184,.3)",
            fontSize: 13,
          },
        },
        h(Dot, { tone }),
        proc.running
          ? h(
              "span",
              { style: { whiteSpace: "nowrap" } },
              `${proc.profile_name || "process"} · pid ${proc.pid} · ${fmtDur(uptime)}${
                proc.attached === false ? " · detached" : ""
              }`
            )
          : h("span", null, "idle"),
        h(
          "button",
          {
            style: { ...btnStyle("ghost"), padding: "3px 8px", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center" },
            title: "Refresh",
            onClick: refresh,
          },
          h(RefreshCw, { size: 13 })
        ),
        h("span", { style: { width: 1, height: 16, background: "rgba(148,163,184,.3)" } }),
        h(
          "button",
          {
            style: {
              ...btnStyle(persistOn ? "ok" : "ghost"),
              padding: "3px 10px",
              borderRadius: 999,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: MONO,
            },
            title: persistOn
              ? "The ninfer bar shows on every dashboard page — click to limit it to this page"
              : "Show the ninfer bar on every dashboard page (remembered in this browser)",
            onClick: () => setPersist(!persistOn),
          },
          persistOn ? "everywhere: on" : "everywhere: off"
        )
      )
    ),
    // error banner
    error &&
      h(
        "div",
        {
          key: "err",
          className: "mb-3",
          style: {
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(248,113,113,.08)",
            border: "1px solid rgba(248,113,113,.35)",
            color: "#fca5a5",
            fontSize: 13,
          },
        },
        error
      ),
    // profiles
    h("div", { key: "profiles-h", className: "text-sm font-semibold mb-2", style: { color: "#94a3b8" } },
      "Command profiles"),
    h(
      "div",
      {
        key: "grid",
        className: "grid gap-3.5",
        style: { gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" },
      },
      profiles.map((p) => {
        const isRunning = proc.running && proc.profile_id === p.id
        const isLast = !proc.running && state && state.last_started_profile_id === p.id
        return h(
          "div",
          {
            key: p.id,
            style: {
              border: `1px solid ${isRunning ? "rgba(52,211,153,.55)" : "rgba(148,163,184,.25)"}`,
              borderRadius: 12,
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              background: isRunning ? "rgba(52,211,153,.05)" : "rgba(15,23,42,.35)",
            },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8 } },
            isRunning && h(Dot, { tone: "#34d399" }),
            h("span", { style: { fontWeight: 600, fontSize: 14, flex: 1 } }, p.name),
            isRunning
              ? h(
                  "span",
                  {
                    style: {
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1,
                      color: "#34d399",
                      border: "1px solid rgba(52,211,153,.5)",
                      borderRadius: 999,
                      padding: "2px 8px",
                    },
                  },
                  "RUNNING"
                )
              : isLast
              ? h(
                  "span",
                  {
                    style: {
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1,
                      color: "#94a3b8",
                      border: "1px solid rgba(148,163,184,.4)",
                      borderRadius: 999,
                      padding: "2px 8px",
                    },
                  },
                  "LAST LOADED"
                )
              : null
          ),
          h(
            "div",
            {
              style: {
                fontFamily: MONO,
                fontSize: 11,
                color: "#94a3b8",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
              title: p.command,
            },
            p.command
          ),
          h(
            "div",
            { style: { fontSize: 11, color: "#64748b" } },
            `cwd ${p.cwd || "~"} · shell ${p.shell}${p.env && Object.keys(p.env).length ? ` · ${Object.keys(p.env).length} env` : ""}`
          ),
          h(
            "div",
            { style: { display: "flex", gap: 8, marginTop: 4 } },
            h(
              "button",
              {
                style: { ...btnStyle("ok"), padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", gap: 6 },
                disabled: busy,
                onClick: () => doStart(p),
              },
              h(Play, { size: 13 }),
              isRunning ? "Restart" : "Start"
            ),
            isRunning
              ? h(
                  "button",
                  {
                    style: { ...btnStyle("danger"), padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", gap: 6 },
                    disabled: busy,
                    onClick: doStop,
                  },
                  h(Square, { size: 13 }),
                  "Stop"
                )
              : null,
            h(
              "button",
              {
                style: { ...btnStyle("ghost"), padding: "6px 10px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center" },
                title: "Edit profile",
                disabled: isRunning,
                onClick: () => setEditing(p),
              },
              h(Pencil, { size: 13 })
            ),
            h(
              "button",
              {
                style: { ...btnStyle("ghost"), padding: "6px 10px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center" },
                title: "Delete profile",
                disabled: isRunning || busy,
                onClick: () => doDelete(p),
              },
              h(Trash2, { size: 13 })
            )
          )
        )
      }),
      editing === null
        ? h(
            "div",
            {
              key: "new-tile",
              style: {
                border: "1px dashed rgba(148,163,184,.35)",
                borderRadius: 12,
                padding: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                cursor: "pointer",
                fontSize: 13,
                color: "#94a3b8",
                minHeight: 110,
              },
              onClick: () => setEditing("new"),
            },
            h(Plus, { size: 16 }),
            "New profile"
          )
        : h(ProfileForm, {
            key: "profile-form-wrap",
            initial: editing === "new" ? null : editing,
            busy,
            onClose: () => setEditing(null),
            onSave: saveProfile,
          })
    ),
    // process output
    h(
      "div",
      {
        key: "log-panel",
        ref: logRef,
        style: {
          marginTop: 20,
          border: "1px solid rgba(148,163,184,.25)",
          borderRadius: 12,
          overflow: "hidden",
          background: "rgba(2,6,16,.6)",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            borderBottom: "1px solid rgba(148,163,184,.2)",
            fontSize: 12,
            color: "#94a3b8",
          },
        },
        h("span", { style: { fontWeight: 700, letterSpacing: 1 } }, "LIVE OUTPUT"),
        proc.running && h("span", { style: { color: "#34d399" } }, "● streaming"),
        h("span", { style: { flex: 1 } }),
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 5, cursor: "pointer" } },
          h("input", { type: "checkbox", checked: autoScroll, onChange: (e) => setAutoScroll(e.target.checked) }),
          "auto-scroll"
        ),
        h("span", null, `${lines.length} lines`),
        h(
          "button",
          {
            style: { ...btnStyle("ghost"), padding: "2px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 },
            onClick: () => setLines([]),
          },
          "Clear view"
        )
      ),
      h(
        "pre",
        {
          style: {
            margin: 0,
            padding: "10px 14px",
            height: 320,
            overflowY: "auto",
            fontFamily: MONO,
            fontSize: 12,
            lineHeight: 1.5,
            color: "#d1e0f0",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          },
        },
        lines.length ? lines.map((l) => l.text).join("\n") : "— no output captured yet —"
      ),
      lastExit &&
        h(
          "div",
          {
            style: {
              padding: "6px 14px",
              borderTop: "1px solid rgba(148,163,184,.2)",
              fontSize: 11,
              color: lastExit.code === 0 ? "#34d399" : "#f87171",
            },
          },
          `last exit: ${lastExit.profile_name || lastExit.profile_id || "?"} — ${describeExit(lastExit)} at ${fmtTime(lastExit.at)}`
        )
    ),
    bar
  )
}
