// ==UserScript==
// @name         Zens Local Inferencing — persistent bar (Kiro Crew)
// @namespace    silent-imperium.org/kirocrew/zens-local-inferencing
// @version      0.1.0
// @description  Optional companion for the Zens ninfer app: keeps the
//               persistent bottom bar alive across FULL page loads of the
//               Kiro Crew dashboard. The bar itself is the app's own
//               ui/bar.mjs module — this script only adds the <script> tag
//               when the "everywhere" flag is on.
// @match        http://localhost:5476/*
// @match        http://127.0.0.1:5476/*
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict"

  const FLAG = "zli.persistBar"
  const BAR_ID = "zli-pbar"
  const SRC = "/apps/zens-local-inferencing/ui/bar.mjs"

  function inject() {
    let on = false
    try {
      on = localStorage.getItem(FLAG) === "1"
    } catch {
      return
    }
    if (!on || document.getElementById(BAR_ID)) return
    // Module scripts evaluate once per URL per page, so repeated calls are a
    // no-op when the app bundle (app page / side panel) has already imported
    // bar.mjs.
    const s = document.createElement("script")
    s.type = "module"
    s.src = SRC
    document.documentElement.appendChild(s)
  }

  inject()

  // storage fires only in tabs that did NOT make the change — i.e. this tab
  // picks up a flag flip made on the app page in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key === FLAG || e.key === null) inject()
  })
})()
