// Zens Local Inferencing - "Ninfer Log" side-panel tab bundle.
//
// A compact live view of the managed process: status dot, profile name,
// uptime, a small stop/start button, and the scrolling output. Hand-written
// ESM, same host-module pattern as index.mjs.

import {
  getState,
  startProcess,
  stopProcess,
  subscribeLogs,
  fmtDur,
} from "./lib.mjs"

// Side-effect import: keeps the persistent "everywhere" bar alive for users
// who reach the dashboard via the side panel before ever opening the app page.
import "./bar.mjs"

const React = window.__kirocrew_modules.react
const { useState, useEffect, useRef, useCallback } = React
const h = React.createElement
const { Terminal, Square, Play } = window.__kirocrew_modules["lucide-react"]

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

export default function NinferLogPanel() {
  const [state, setState] = useState(null)
  const [lines, setLines] = useState([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const logRef = useRef(null)
  const lastSeq = useRef(0)

  const refresh = useCallback(async () => {
    try {
      setState(await getState())
      setError("")
    } catch (e) {
      setError(e.message || String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2500)
    return () => clearInterval(t)
  }, [refresh])

  const onLine = useCallback((d) => {
    if (!d || !d.seq || d.seq <= lastSeq.current) return
    lastSeq.current = d.seq
    setLines((prev) => {
      const next = prev.length >= 300 ? prev.slice(-240) : prev.slice()
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

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  const proc = (state && state.process) || { running: false }
  const tone = proc.running ? (proc.attached === false ? "#fbbf24" : "#34d399") : "#6b7280"
  const uptime =
    proc.running && proc.started_at
      ? ((state && state.now) || Date.now() / 1000) - proc.started_at
      : 0
  const lastProfile =
    state &&
    (state.profiles || []).find((p) => p.id === state.last_started_profile_id)

  const doStop = () => {
    setBusy(true)
    stopProcess(8000)
      .then(refresh)
      .catch((e) => setError(e.message || String(e)))
      .finally(() => setBusy(false))
  }

  const doStart = () => {
    if (!lastProfile) return
    setBusy(true)
    startProcess(lastProfile.id, true)
      .then(refresh)
      .catch((e) => setError(e.message || String(e)))
      .finally(() => setBusy(false))
  }

  return h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 220,
        fontFamily: "inherit",
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid rgba(148,163,184,.2)",
          fontSize: 12,
        },
      },
      h(Terminal, { size: 13, style: { color: "#94a3b8", flexShrink: 0 } }),
      h(
        "span",
        {
          style: {
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: tone,
            display: "inline-block",
            flexShrink: 0,
          },
        }
      ),
      h("span", { style: { fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        proc.running
          ? proc.profile_name || "process"
          : lastProfile
          ? `${lastProfile.name} (stopped)`
          : "nothing running"),
      proc.running && h("span", { style: { opacity: 0.7, whiteSpace: "nowrap" } }, fmtDur(uptime)),
      proc.running
        ? h(
            "button",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 10px",
                borderRadius: 6,
                fontSize: 11,
                cursor: "pointer",
                background: "rgba(248,113,113,.1)",
                color: "#f87171",
                border: "1px solid rgba(248,113,113,.35)",
              },
              disabled: busy,
              onClick: doStop,
            },
            h(Square, { size: 11 }),
            "Stop"
          )
        : lastProfile
        ? h(
            "button",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 10px",
                borderRadius: 6,
                fontSize: 11,
                cursor: "pointer",
                background: "rgba(52,211,153,.12)",
                color: "#34d399",
                border: "1px solid rgba(52,211,153,.4)",
              },
              disabled: busy,
              onClick: doStart,
            },
            h(Play, { size: 11 }),
            "Start"
          )
        : null
    ),
    h(
      "pre",
      {
        ref: logRef,
        style: {
          flex: 1,
          margin: 0,
          padding: "10px 12px",
          overflowY: "auto",
          fontFamily: MONO,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: "#d1e0f0",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        },
      },
      lines.length ? lines.map((l) => l.text).join("\n") : "— no output yet —"
    ),
    error &&
      h(
        "div",
        {
          style: {
            padding: "6px 12px",
            borderTop: "1px solid rgba(248,113,113,.3)",
            color: "#fca5a5",
            fontSize: 11,
          },
        },
        error
      )
  )
}
