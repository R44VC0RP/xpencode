// Runs before the OpenCode web UI boots on /desktop/app.
// 1. Its router lives at "/": move the address to the new session's route
//    without reloading, keeping ?auth_token= (the UI reads it, then removes it).
// 2. No service worker: it would claim this whole origin, including the
//    terminal version's pages.
// 3. Open the visitor's workspace as the one project (the web UI lists
//    projects the user opened, stored in localStorage; old ones are gone).
;(function () {
  // A reload inside the card: the UI already removed ?auth_token= from the
  // address, so put this tab's token back before it boots.
  try {
    var saved = sessionStorage.getItem("xoc-auth")
    var current = new URLSearchParams(location.search).get("auth_token")
    if (current) sessionStorage.setItem("xoc-auth", current)
    else if (saved && location.pathname.indexOf("/desktop") !== 0) {
      var p = new URLSearchParams(location.search)
      p.set("auth_token", saved)
      history.replaceState(null, "", location.pathname + "?" + p.toString() + location.hash)
    }
  } catch (e) {}
  var params = new URLSearchParams(location.search)
  var ws = params.get("ws")
  var sid = params.get("s")
  params.delete("ws")
  params.delete("s")
  if (ws && /^[a-f0-9]{16}$/.test(ws)) {
    var dir = "/srv/ws/" + ws
    var key = "opencode.global.dat:server"
    var state
    try { state = JSON.parse(localStorage.getItem(key) || "null") } catch (e) {}
    if (!state || typeof state !== "object") state = { list: [], hidden: {}, projects: {}, lastProject: {}, recentlyClosed: {} }
    state.projects = { local: [{ worktree: dir, expanded: true }] }
    state.lastProject = { local: dir }
    state.recentlyClosed = { local: [] }
    try { localStorage.setItem(key, JSON.stringify(state)) } catch (e) {}
  }
  // Every launch from the card opens the fresh session the gateway created:
  // /server/<base64url(server URL)>/session/<id>, the UI's own session route.
  var search = params.toString()
  var target = "/"
  if (sid && /^ses_[A-Za-z0-9]+$/.test(sid)) {
    var key = btoa(location.origin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    target = "/server/" + key + "/session/" + sid
  }
  if (location.pathname.indexOf("/desktop") === 0 || ws)
    history.replaceState(null, "", target + (search ? "?" + search : "") + location.hash)
})()
if (navigator.serviceWorker) {
  navigator.serviceWorker.register = function () { return Promise.reject(new Error("disabled in this demo")) }
  navigator.serviceWorker.getRegistrations?.().then(function (rs) { rs.forEach(function (r) { r.unregister() }) })
}
// Dark by default, like the TUI and opencode.ai (a visitor's own choice wins).
try { if (!localStorage.getItem("opencode-color-scheme")) localStorage.setItem("opencode-color-scheme", "dark") } catch (e) {}
