import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";
import { Unicode11Addon } from "/vendor/addon-unicode11.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let touch = matchMedia("(pointer: coarse)").matches;
const setTouch = () => { document.body.classList.toggle("touch", touch); };
setTouch();
addEventListener("pointerdown", (e) => { if (e.pointerType === "touch" && !touch) { touch = true; setTouch(); refit(); } }, true);

// OpenCode lays out best at ~80 columns but works down to ~50. The card is
// ~480px wide; phones are ~390px. Pick the largest font size that still gives
// at least minCols columns (fewer columns on narrow screens, for legibility).
const MIN_ROWS = 20;
function fontSizeFor(w, h) {
  const minCols = w < 440 ? 50 : 72;
  const byW = Math.floor((w - 8) / (minCols * 0.6));
  const byH = Math.floor((h - 8) / (MIN_ROWS * 1.2));
  return Math.max(7, Math.min(15, byW, byH));
}

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily: '"Berkeley Mono", ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: fontSizeFor(innerWidth, innerHeight),
  lineHeight: 1.1,
  scrollback: 0,
  macOptionIsMeta: true,
  theme: { background: "#0a0a0a", foreground: "#eeeeee", cursor: "#eeeeee", selectionBackground: "#3a3a3a" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
term.open($("term"));

function refit() {
  const r = $("term").getBoundingClientRect();
  const size = fontSizeFor(r.width, r.height);
  if (term.options.fontSize !== size) term.options.fontSize = size;
  try { fit.fit(); } catch {}
}
new ResizeObserver(() => refit()).observe($("term"));
refit();

// ─── Connection ──────────────────────────────────────────────────────────────
// Server → page: binary frames are terminal output; text frames are JSON
// status ({type:"status"|"exit"|"error", ...}).
// Page → server: text frames are JSON: {type:"input",data} | {type:"resize",cols,rows}.
let ws = null, open = false, ended = false;
const enc = new TextEncoder();
const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function show(text, button) {
  $("overlay").classList.remove("gone");
  $("msg").textContent = text;
  $("go").hidden = !button;
}

function connect() {
  ended = false;
  term.reset();
  show("Starting your session…", false);
  const url = new URL("/tty", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cols", term.cols);
  url.searchParams.set("rows", term.rows);
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { open = true; };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") {
      if ($("overlay").classList.contains("gone") === false) { $("overlay").classList.add("gone"); term.focus(); }
      term.write(new Uint8Array(e.data));
      return;
    }
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "status") show(m.message, false);
    if (m.type === "error") { ended = true; show(m.message, !!m.retry); }
    if (m.type === "exit") { ended = true; show(m.message || "Session ended.", true); }
  };
  ws.onclose = () => {
    open = false;
    if (!ended) show("Disconnected.", true);
  };
}

term.onData((data) => {
  if (ctrl && data.length === 1) {
    const c = data.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) data = String.fromCharCode(c - 96);
    setCtrl(false);
  }
  send({ type: "input", data });
});
term.onBinary((data) => send({ type: "input", data }));
term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));

$("go").onclick = () => connect();

// ─── Extra keys ─────────────────────────────────────────────────────────────
let ctrl = false;
function setCtrl(on) { ctrl = on; $("k-ctrl").classList.toggle("on", on); }
const KEYS = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", slash: "/", at: "@", enter: "\r" };
for (const b of document.querySelectorAll("#keys button")) {
  // pointerdown + preventDefault keeps focus (and the soft keyboard) on the terminal.
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const k = b.dataset.k;
    if (k === "ctrl") return setCtrl(!ctrl);
    send({ type: "input", data: KEYS[k] });
    term.focus();
  });
}
$("term").addEventListener("click", () => term.focus());

connect();
