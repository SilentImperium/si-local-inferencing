// SI Local Inferencing — persistent bottom bar ("show everywhere" mode).
//
// Plain-DOM ES module (no React, no build step). When its flag is on it
// mounts a full-width bar on document.body, pinned to the bottom of the
// viewport. The Kiro Crew dashboard is a single-page app, so a node outside
// the React tree survives every route change — the bar is visible on all
// pages, not just the app's.
//
// The bar occupies its OWN block: it is a position:fixed element, so the
// dashboard lays out as if it weren't there — reserve() reclaims the bar's
// band by padding the app shell (and any other scroller that dips under the
// bar) down by the overlap, so the UI is pushed up above the bar instead of
// being overlaid by it. A terminal's prompt line, a chat composer, log
// panels: their bottom edge always ends above the bar.
//
// Two load paths, same URL, so the module evaluates once per page load
// (ES module singleton) no matter which hits first:
//   1. `import "./bar.mjs"` from index.mjs / panel.mjs — the app page's
//      "everywhere" toggle flips the flag.
//   2. scripts/persistent-bar.user.js injects
//      <script type="module" src="/apps/si-local-inferencing/ui/bar.mjs">
//      on full page loads (closes the reload gap: the app bundles only load
//      when the app page or side panel is opened).
//
// On/off state: localStorage "zli.persistBar" === "1" (shared with the app
// page). The "zli.*" keys are deliberately stable across app renames so a
// user's saved bar preference survives. Changes propagate via the
// "zli:persist-flag" CustomEvent (same tab),
// the "storage" event (other tabs), and a 1 s poll as a backstop.
//
// Data: GET /api/state every 2.5 s plus subscribeLogs()' live stream (SSE
// with a built-in polling fallback) — the same gateway-proxy routes the app
// page uses, with the dashboard session cookie.

import { getState, subscribeLogs, fmtDur } from "./lib.mjs"

const FLAG_KEY = "zli.persistBar"
const FLAG_EVENT = "zli:persist-flag"
const BAR_ID = "zli-pbar"
const APP_ROUTE = "/apps/si-local-inferencing"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

let root = null // <div id="zli-pbar">
let els = null // { dot, name, meta, line }
let sub = null // { close() } from subscribeLogs()
let pollTimer = null
let lastLine = ""
let stateCache = null
let apiDown = false
let mounted = false
let padStore = new Map() // node -> its inline paddingBottom before we padded
let domObserver = null
let reserveTimer = null

function flagOn() {
  try {
    return window.localStorage.getItem(FLAG_KEY) === "1"
  } catch {
    return false
  }
}

function el(tag, style, text) {
  const n = document.createElement(tag)
  if (style) Object.assign(n.style, style)
  if (text != null) n.textContent = text
  return n
}

const BTN = {
  background: "rgba(148,163,184,.08)",
  color: "#cbd5e1",
  border: "1px solid rgba(148,163,184,.25)",
  padding: "3px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 11,
  fontFamily: MONO,
}

function makeBar() {
  root = el(
    "div",
    {
      position: "fixed",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 2147483000,
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 14px",
      background: "rgba(10,14,23,.97)",
      borderTop: "1px solid rgba(148,163,184,.25)",
      fontFamily: MONO,
      fontSize: 12,
      color: "#cbd5e1",
      boxSizing: "border-box",
    }
  )
  root.id = BAR_ID

  els = {
    dot: el("span", {
      width: 9,
      height: 9,
      borderRadius: "50%",
      background: "#6b7280",
      display: "inline-block",
      flexShrink: 0,
    }),
    name: el("span", { fontWeight: 600, whiteSpace: "nowrap" }, "…"),
    meta: el("span", { whiteSpace: "nowrap", opacity: 0.7 }),
    line: el("span", {
      flex: 1,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      opacity: 0.85,
    }),
  }

  const openBtn = el("button", { ...BTN }, "Open app")
  openBtn.title = "Open the SI Local Inferencing page"
  openBtn.addEventListener("click", () => {
    window.location.assign(APP_ROUTE)
  })

  const hideBtn = el("button", { ...BTN }, "Hide")
  hideBtn.title =
    "Turn the persistent bar off (the app page's 'everywhere' toggle turns it back on)"
  hideBtn.addEventListener("click", () => setFlag(false))

  root.appendChild(els.dot)
  root.appendChild(els.name)
  root.appendChild(els.meta)
  root.appendChild(els.line)
  root.appendChild(openBtn)
  root.appendChild(hideBtn)
}

// --- reserving the bar's band ("its own block") ----------------------------
// The bar is position:fixed, so the dashboard lays out as if the bar weren't
// there and the bar floats over whatever sits at the bottom of the viewport.
// reserve() reclaims the bar's band from the layout so the UI is pushed up
// above the bar instead of being overlaid by it:
//   * the dashboard's root shell — the largest element child of <body>, its
//     overflow-hidden h-dvh root — gets padding-bottom = the bar's height, so
//     the whole UI re-lays-out in the space above the bar;
//   * every other element that actually scrolls (overflow-y auto|scroll with
//     overflowing content) gets padding-bottom = how far its box dips under
//     the bar, so its scrollable content — a terminal's prompt line, chat
//     history, logs — ends above the bar. Elements inside the padded shell
//     already end at the bar's top edge, so their overlap is 0 and they get
//     nothing: each node is padded by exactly the amount it is covered.
// Pads are per-node inline styles, saved and restored on unmount.

function onResize() {
  scheduleReserve()
}

function scheduleReserve() {
  if (reserveTimer) clearTimeout(reserveTimer)
  reserveTimer = setTimeout(() => {
    reserveTimer = null
    reserve()
  }, 150)
}

function clearAllPads() {
  for (const [node, prev] of padStore) {
    node.style.paddingBottom = prev
    node.removeAttribute("data-zli-reserve")
  }
  padStore.clear()
}

function applyPad(node, px) {
  const key = String(px)
  if (node.getAttribute("data-zli-reserve") === key) return
  if (!padStore.has(node)) padStore.set(node, node.style.paddingBottom)
  node.style.paddingBottom = px + "px"
  node.setAttribute("data-zli-reserve", key)
}

function findShell() {
  let best = null
  let bestArea = 0
  for (const node of document.body.children) {
    if (node === root || node.nodeType !== Node.ELEMENT_NODE) continue
    const r = node.getBoundingClientRect()
    const area = r.width * r.height
    if (area > bestArea) {
      bestArea = area
      best = node
    }
  }
  return best
}

function reserve() {
  if (!mounted || !root) return
  clearAllPads()
  const band = root.getBoundingClientRect()
  if (band.height <= 0) return

  // 1) the shell: its box reaches the bottom of the viewport, so its overlap
  //    with the bar's band is the bar's full height.
  const shell = findShell()
  if (shell) applyPad(shell, Math.ceil(band.height))

  // 2) everything else that actually scrolls and dips under the bar.
  const all = document.querySelectorAll("body *")
  for (const node of all) {
    if (node === shell || root.contains(node)) continue
    if (node.scrollHeight <= node.clientHeight + 4) continue
    const oy = getComputedStyle(node).overflowY
    if (oy !== "auto" && oy !== "scroll") continue
    const overlap = Math.ceil(node.getBoundingClientRect().bottom - band.top)
    if (overlap > 0) applyPad(node, overlap)
  }
}

function setFlag(v) {
  try {
    window.localStorage.setItem(FLAG_KEY, v ? "1" : "0")
  } catch {
    /* storage unavailable */
  }
  try {
    window.dispatchEvent(new CustomEvent(FLAG_EVENT))
  } catch {
    /* ignore */
  }
  sync()
}

function render() {
  if (!root || !els) return
  const proc = (stateCache && stateCache.process) || { running: false }
  const uptime =
    proc.running && proc.started_at && stateCache && stateCache.now
      ? stateCache.now - proc.started_at
      : 0

  els.dot.style.background = apiDown
    ? "#f87171"
    : proc.running
    ? proc.attached === false
      ? "#fbbf24"
      : "#34d399"
    : "#6b7280"
  root.style.borderTopColor =
    !apiDown && proc.running ? "rgba(52,211,153,.5)" : "rgba(148,163,184,.25)"

  if (apiDown) {
    els.name.textContent = "backend offline"
    els.meta.textContent = ""
    els.line.textContent = "can't reach the app backend — is the app enabled in Kiro Crew?"
    els.line.title = ""
  } else {
    els.name.textContent = proc.running ? proc.profile_name || "process" : "idle"
    els.meta.textContent = proc.running ? `pid ${proc.pid} · ${fmtDur(uptime)}` : ""
    els.line.textContent = lastLine || (proc.running ? "no output yet" : "nothing running")
    els.line.title = lastLine
  }
}

async function pollState() {
  try {
    stateCache = await getState()
    apiDown = false
  } catch {
    apiDown = true
  }
  render()
}

function mount() {
  if (mounted || !document.body) return
  const existing = document.getElementById(BAR_ID)
  if (existing) existing.remove() // belt and braces: module is a singleton anyway
  makeBar()
  document.body.appendChild(root)
  mounted = true
  lastLine = ""
  apiDown = false
  stateCache = null
  // Keep the reserved band in sync with the dashboard's layout: any new
  // scroll container (a freshly opened terminal, a panel, a route change)
  // mutates the DOM or the viewport, which re-runs reserve().
  domObserver = new MutationObserver(scheduleReserve)
  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  })
  window.addEventListener("resize", onResize)
  reserve()
  pollState()
  pollTimer = setInterval(pollState, 2500)
  sub = subscribeLogs({
    after: 0,
    onLine: (d) => {
      if (d && typeof d.text === "string") {
        lastLine = d.text
        render()
      }
    },
  })
  render()
}

function unmount() {
  if (!mounted) return
  mounted = false
  if (domObserver) {
    domObserver.disconnect()
    domObserver = null
  }
  window.removeEventListener("resize", onResize)
  if (reserveTimer) {
    clearTimeout(reserveTimer)
    reserveTimer = null
  }
  clearAllPads() // give the dashboard its full height back
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (sub) {
    try {
      sub.close()
    } catch {
      /* already closed */
    }
    sub = null
  }
  if (root && root.parentNode) root.parentNode.removeChild(root)
  root = null
  els = null
}

// Idempotent: cheap no-op when the flag and the DOM already agree.
function sync() {
  if (flagOn()) mount()
  else unmount()
}

function init() {
  window.setInterval(sync, 1000) // backstop for same-tab flag changes
  window.addEventListener(FLAG_EVENT, () => sync())
  window.addEventListener(
    "storage",
    (e) => {
      if (e.key === FLAG_KEY || e.key === null) sync()
    },
    false
  )
  sync()
}

if (document.body) init()
else document.addEventListener("DOMContentLoaded", init, { once: true })
