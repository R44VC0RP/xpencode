// Runs before the OpenCode web UI boots on /desktop/app.
// 1. Its router lives at "/": move the address there without reloading,
//    keeping ?auth_token= (the UI reads it, then removes it).
// 2. No service worker: it would claim this whole origin, including the
//    terminal version's pages.
// 3. Open the visitor's workspace as the one project (the web UI lists
//    projects the user opened, stored in localStorage; old ones are gone).
;(function () {
  var params = new URLSearchParams(location.search)
  var ws = params.get("ws")
  params.delete("ws")
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
  var search = params.toString()
  if (location.pathname.indexOf("/desktop") === 0 || ws)
    history.replaceState(null, "", "/" + (search ? "?" + search : "") + location.hash)
})()
if (navigator.serviceWorker) {
  navigator.serviceWorker.register = function () { return Promise.reject(new Error("disabled in this demo")) }
  navigator.serviceWorker.getRegistrations?.().then(function (rs) { rs.forEach(function (r) { r.unregister() }) })
}
// Dark by default, like the TUI and opencode.ai (a visitor's own choice wins).
try { if (!localStorage.getItem("opencode-color-scheme")) localStorage.setItem("opencode-color-scheme", "dark") } catch (e) {}
