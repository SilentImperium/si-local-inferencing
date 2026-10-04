// SI Local Inferencing - shared UI helpers.
//
// Imported by both UI bundles (index.mjs page, panel.mjs side-panel tab).
// All traffic goes to the Kiro Crew gateway at /apps/{name}/api/* with the
// dashboard session cookie; the gateway HMAC-signs and proxies to the app
// backend. Plain fetch - no host SDK needed.

const APP = "si-local-inferencing"

export const apiPath = (p) => `/apps/${APP}/api/${p}`

export async function http(method, path, body) {
  const res = await fetch(apiPath(path), {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.detail)) || `request failed: HTTP ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export const getState = () => http("GET", "state")
export const createProfile = (p) => http("POST", "profiles", p)
export const updateProfile = (id, p) => http("PUT", `profiles/${id}`, p)
export const deleteProfile = (id) => http("DELETE", `profiles/${id}`)
export const startProcess = (profile_id, stop_current) =>
  http("POST", "process/start", { profile_id, stop_current: !!stop_current })
export const stopProcess = (grace_ms) =>
  http("POST", "process/stop", grace_ms ? { grace_ms } : {})
export const tailLogs = (after, limit) =>
  http("GET", `logs/tail?after=${encodeURIComponent(after || 0)}&limit=${limit || 300}`)

// Live log stream.
//
// Opens an EventSource against /logs/stream. The gateway's per-request timeout
// cuts the proxied stream every ~30s, so we rely on EventSource reconnecting
// (the server sends `retry: 500`); the backend reseeds from the Last-Event-ID
// header / ?after= cursor, so no lines are lost (ring buffer holds 2000).
// If the stream dies repeatedly (backend down), fall back to tail polling.
//
// Returns { close() }.
export function subscribeLogs({ after = 0, onLine, onExit } = {}) {
  let seq = after
  let es = null
  let closed = false
  let failCount = 0
  let openedAt = 0
  let timer = null
  let pollTimer = null

  function clearTimers() {
    if (timer) clearTimeout(timer)
    timer = null
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function startPolling() {
    // backend appears down - poll the tail instead
    const poll = async () => {
      try {
        const r = await tailLogs(seq)
        for (const [s, text] of r.lines) {
          if (s > seq) {
            seq = s
            onLine && onLine({ seq: s, text })
          }
        }
        failCount = 0
      } catch {
        /* keep polling */
      }
    }
    if (pollTimer) return
    poll()
    pollTimer = setInterval(poll, 2000)
  }

  function open() {
    if (closed) return
    openedAt = Date.now()
    try {
      es = new EventSource(`${apiPath("logs/stream")}?after=${seq}`)
    } catch {
      startPolling()
      return
    }
    es.addEventListener("line", (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d && d.seq) seq = Math.max(seq, d.seq)
        onLine && onLine(d)
      } catch {
        /* ignore malformed */
      }
    })
    es.addEventListener("exit", (e) => {
      try {
        onExit && onExit(JSON.parse(e.data))
      } catch {
        /* ignore malformed */
      }
    })
    es.onerror = () => {
      try {
        es.close()
      } catch {
        /* already closed */
      }
      const instantFail = Date.now() - openedAt < 500
      if (instantFail) failCount += 1
      else failCount = 0
      if (closed) return
      if (failCount >= 3) {
        startPolling()
        return
      }
      timer = setTimeout(open, 800)
    }
  }

  open()

  return {
    close() {
      closed = true
      clearTimers()
      try {
        es && es.close()
      } catch {
        /* ignore */
      }
    },
  }
}

export function fmtDur(seconds) {
  if (seconds == null || !isFinite(seconds)) return ""
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function fmtTime(epoch) {
  if (!epoch) return ""
  try {
    return new Date(epoch * 1000).toLocaleString()
  } catch {
    return ""
  }
}
