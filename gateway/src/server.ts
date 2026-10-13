// x-opencode gateway
//
// Public side (PUBLIC_PORT, behind the exe.dev HTTPS proxy):
//   GET  /, /play        X player card page (xterm.js)
//   GET  /card.png, /vendor/*
//   WS   /tty            one visitor = one real OpenCode TUI in a sandboxed PTY
//   GET  /stats          aggregate counters (no visitor data)
//
// Private side (127.0.0.1:PROXY_PORT): every TUI talks to the shared OpenCode
// server through /v/<token>/..., never directly. The proxy authenticates the
// TUI by its unguessable token, injects the real server password, pins every
// request to the visitor's own workspace directory, only lets through the
// routes a chat-and-edit TUI needs, checks session ownership, filters lists and
// the event stream, and only allows free models.
import { mkdir, realpath, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"

const PUBLIC_PORT = Number(process.env.PORT ?? 8000)
const PROXY_PORT = 4097
const UPSTREAM = "http://127.0.0.1:4096"
const ORIGIN = (process.env.PUBLIC_ORIGIN ?? "https://x-opencode.exe.xyz").replace(/\/$/, "")
const WS_ROOT = "/srv/ws"
const TUI_SCRIPT = "/opt/x-opencode/ops/tui.sh"
const WEB_DIR = path.resolve(import.meta.dir, "../../web")
const VENDOR_DIR = path.resolve(import.meta.dir, "../node_modules/@xterm")

if (!process.env.OPENCODE_PASSWORD) throw new Error("OPENCODE_PASSWORD is not set")
const UPSTREAM_AUTH = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")
delete process.env.OPENCODE_PASSWORD

const LIMITS = {
  visitors: Number(process.env.MAX_VISITORS ?? 40),
  perIp: 2,
  startsPerIpPerHour: 12,
  idleMs: 10 * 60_000,
  maxMs: 30 * 60_000,
  prompts: 40,
  promptGapMs: 3_000,
  bodyBytes: 8 * 1024 * 1024,
  inputBytes: 64 * 1024,
  workspaceKB: 50 * 1024,
}

// ─── Visitors ────────────────────────────────────────────────────────────────

type Visitor = {
  id: string
  token: string
  dir: string
  ip: string
  ws: import("bun").ServerWebSocket<Conn>
  proc?: import("bun").Subprocess
  started: number
  lastInput: number
  prompts: number
  lastPrompt: number
  sessions: Set<string>
  ended: boolean
}
type Conn = { ip: string; cols: number; rows: number; visitor?: Visitor }

const byToken = new Map<string, Visitor>()
const starts = new Map<string, number[]>()
const stats = {
  bootedAt: Date.now(),
  started: 0,
  rejectedFull: 0,
  rejectedIp: 0,
  prompts: 0,
  promptsLimited: 0,
  denied: 0,
  leaksBlocked: 0,
  timedOut: 0,
  spawnFailures: 0,
  oversized: 0,
}

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))

const ipCount = (ip: string) => [...byToken.values()].filter((v) => v.ip === ip && !v.ended).length

function allowStart(ip: string) {
  const now = Date.now()
  const recent = (starts.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  starts.set(ip, recent)
  if (recent.length >= LIMITS.startsPerIpPerHour) return false
  recent.push(now)
  return true
}

const send = (v: Visitor, msg: Record<string, unknown>) => {
  try {
    v.ws.send(JSON.stringify(msg))
  } catch {}
}

async function git(dir: string, args: string[]) {
  const p = Bun.spawn(["git", "-c", "user.name=OpenCode", "-c", "user.email=demo@opencode.ai", ...args], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: "/srv/ocgw" },
  })
  if ((await p.exited) !== 0) throw new Error(`git ${args[0]} failed: ${await new Response(p.stderr).text()}`)
}

async function startVisitor(ws: import("bun").ServerWebSocket<Conn>) {
  const { ip, cols, rows } = ws.data
  const id = randomBytes(8).toString("hex")
  const token = randomBytes(24).toString("base64url")
  const dir = path.join(WS_ROOT, id)
  const v: Visitor = {
    id,
    token,
    dir,
    ip,
    ws,
    started: Date.now(),
    lastInput: Date.now(),
    prompts: 0,
    lastPrompt: 0,
    sessions: new Set(),
    ended: false,
  }
  ws.data.visitor = v
  byToken.set(token, v)
  stats.started++

  try {
    await mkdir(dir, { mode: 0o2775 })
    // A unique git repo per visitor gives each one its own OpenCode project, so
    // saved "always allow" approvals and project lists never cross visitors.
    await git(dir, ["init", "-q", "-b", "main"])
    await git(dir, ["config", "core.sharedRepository", "group"])
    await git(dir, ["commit", "-q", "--allow-empty", "-m", `x-opencode workspace ${id}`])
  } catch (e) {
    log("workspace setup failed", { id, error: String(e) })
    send(v, { type: "error", message: "Could not create your workspace. Try again.", retry: true })
    return endVisitor(v, "setup failed")
  }
  if (v.ended) return endVisitor(v, "closed during setup")

  try {
    v.proc = Bun.spawn(["sudo", "-n", "-u", "octui", TUI_SCRIPT, id, `http://127.0.0.1:${PROXY_PORT}/v/${token}`], {
      terminal: {
        cols,
        rows,
        data(_t, data) {
          if (v.ended) return
          // Drop output for clients that stopped reading rather than buffering forever.
          if (v.ws.getBufferedAmount() > 8 * 1024 * 1024) return
          v.ws.sendBinary(data)
        },
      },
      env: { PATH: "/usr/bin:/bin" },
    })
  } catch (e) {
    stats.spawnFailures++
    log("spawn failed", { id, error: String(e) })
    send(v, { type: "error", message: "Could not start OpenCode. Try again.", retry: true })
    return endVisitor(v, "spawn failed")
  }
  log("visitor started", { id, ip: hashIp(ip), active: activeCount() })
  v.proc.exited.then((code) => {
    if (v.ended) return
    stats.spawnFailures += code !== 0 && Date.now() - v.started < 5000 ? 1 : 0
    send(v, { type: "exit", message: "OpenCode exited." })
    endVisitor(v, `tui exited ${code}`)
  })
}

async function endVisitor(v: Visitor, reason: string) {
  if (v.ended && !byToken.has(v.token)) return
  v.ended = true
  byToken.delete(v.token)
  try {
    v.proc?.kill("SIGTERM")
    // `killed` turns true once a signal is sent, so check for an actual exit.
    setTimeout(() => v.proc && v.proc.exitCode === null && v.proc.kill("SIGKILL"), 3000)
  } catch {}
  try {
    v.ws.close(1000, reason.slice(0, 100))
  } catch {}
  log("visitor ended", { id: v.id, reason, seconds: Math.round((Date.now() - v.started) / 1000), prompts: v.prompts })
  // Give the TUI a moment to go away, then stop and delete its sessions and files.
  setTimeout(() => void cleanup(v), 2000)
}

async function cleanup(v: Visitor) {
  try {
    const res = await upstream(`/api/session?directory=${encodeURIComponent(v.dir)}&limit=200`)
    const list = res.ok ? ((await res.json()) as { data?: { id: string }[] }).data ?? [] : []
    const ids = new Set([...v.sessions, ...list.map((s) => s.id)])
    for (const id of ids) {
      await upstream(`/api/session/${id}/interrupt`, { method: "POST", body: "{}" }).catch(() => {})
      await upstream(`/api/session/${id}`, { method: "DELETE" }).catch(() => {})
    }
  } catch (e) {
    log("session cleanup failed", { id: v.id, error: String(e) })
  }
  await rm(v.dir, { recursive: true, force: true }).catch((e) => log("rm failed", { id: v.id, error: String(e) }))
  await evictLocation(v.dir)
}

// The server keeps every location it has loaded (its services, caches and
// background work) until told otherwise; one per visitor adds up fast.
const evictLocation = (dir: string) =>
  upstream(`/api/debug/location?location%5Bdirectory%5D=${encodeURIComponent(dir)}`, { method: "DELETE" }).catch(() => {})

async function sweepLocations() {
  try {
    const res = await upstream("/api/debug/location")
    const loaded = ((await res.json()) as { directory?: string }[]).map((l) => l.directory ?? "")
    const active = new Set([...byToken.values()].map((v) => v.dir))
    const stale = loaded.filter((d) => d.startsWith(WS_ROOT + "/") && !active.has(d))
    for (let i = 0; i < stale.length; i += 16) await Promise.all(stale.slice(i, i + 16).map(evictLocation))
    if (stale.length) log("evicted stale locations", { count: stale.length, loaded: loaded.length })
  } catch (e) {
    log("location sweep failed", { error: String(e) })
  }
}
setInterval(sweepLocations, 2 * 60_000)

const activeCount = () => [...byToken.values()].filter((v) => !v.ended).length
const hashIp = (ip: string) => new Bun.CryptoHasher("sha256").update("x-oc:" + ip).digest("hex").slice(0, 10)

async function workspaceKB(dir: string) {
  const p = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "ignore" })
  const out = await new Response(p.stdout).text()
  return Number(out.split(/\s/)[0]) || 0
}

setInterval(() => {
  const now = Date.now()
  for (const v of byToken.values()) {
    if (v.ended) continue
    void workspaceKB(v.dir).then((kb) => {
      if (v.ended || kb <= LIMITS.workspaceKB) return
      stats.oversized++
      send(v, { type: "exit", message: "Your workspace passed the 50 MB demo limit, so the session was closed." })
      endVisitor(v, `workspace ${kb} KB`)
    })
    if (now - v.lastInput > LIMITS.idleMs) {
      stats.timedOut++
      send(v, { type: "exit", message: "Session closed after 10 minutes of inactivity." })
      endVisitor(v, "idle")
    } else if (now - v.started > LIMITS.maxMs) {
      stats.timedOut++
      send(v, { type: "exit", message: "Sessions last 30 minutes. Thanks for trying OpenCode!" })
      endVisitor(v, "max age")
    }
  }
}, 15_000)

// ─── Allowed models ──────────────────────────────────────────────────────────
// Visitors may only use these "provider/model" refs (the demo's one model).

const ALLOWED_MODELS = new Set(
  (process.env.ALLOWED_MODELS ?? "mystery/guess-who").split(",").map((s) => s.trim()).filter(Boolean),
)
const allowedRef = (providerID: unknown, id: unknown) => ALLOWED_MODELS.has(`${providerID}/${id}`)
let freeModels = new Set<string>()
type ModelInfo = { id: string; providerID: string; enabled?: boolean; cost?: { input?: number; output?: number }[] }
const isFreeInfo = (m: ModelInfo) => m.enabled !== false && allowedRef(m.providerID, m.id)

async function refreshFreeModels() {
  try {
    const res = await upstream(`/api/model?location%5Bdirectory%5D=${encodeURIComponent(WS_ROOT)}`)
    const body = (await res.json()) as { data: ModelInfo[] }
    const next = new Set(body.data.filter(isFreeInfo).map((m) => m.id))
    if (next.size > 0) freeModels = next
    log("free models", { models: [...freeModels] })
  } catch (e) {
    log("free model refresh failed", { error: String(e) })
  }
}
setInterval(refreshFreeModels, 10 * 60_000)
void refreshFreeModels()

// Any object in a request body that names a provider must name an allowed model.
function modelRefsAreFree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(modelRefsAreFree)
  if (!value || typeof value !== "object") return true
  const o = value as Record<string, unknown>
  if ("providerID" in o) {
    const id = (o.id ?? o.modelID ?? o.model) as unknown
    if (typeof id === "string" ? !allowedRef(o.providerID, id) : !ALLOWED_MODELS.size) return false
  }
  return Object.values(o).every(modelRefsAreFree)
}

// ─── Upstream helpers ────────────────────────────────────────────────────────

function upstream(pathAndQuery: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", UPSTREAM_AUTH)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  return fetch(UPSTREAM + pathAndQuery, { ...init, headers, redirect: "manual" })
}

const sessionDirCache = new Map<string, string>()
async function sessionDir(id: string): Promise<string | undefined> {
  const cached = sessionDirCache.get(id)
  if (cached) return cached
  const res = await upstream(`/api/session/${encodeURIComponent(id)}`)
  if (!res.ok) return undefined
  const body = (await res.json()) as { data?: { location?: { directory?: string } } }
  const dir = body.data?.location?.directory
  if (dir) sessionDirCache.set(id, dir)
  if (sessionDirCache.size > 50_000) sessionDirCache.clear()
  return dir
}

const inside = (dir: string, p: string | undefined) => !!p && (p === dir || p.startsWith(dir + "/"))

async function owns(v: Visitor, sessionID: string) {
  if (v.sessions.has(sessionID)) return true
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) return false
  if (inside(v.dir, await sessionDir(sessionID))) {
    v.sessions.add(sessionID)
    return true
  }
  return false
}

// file:// attachments are read by the server with no containment check, so
// only allow ones that resolve inside the visitor's workspace.
async function attachmentsAreLocal(v: Visitor, value: unknown): Promise<boolean> {
  const uris: string[] = []
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      if (/^file:/i.test(x)) uris.push(x)
    } else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === "object") Object.values(x).forEach(walk)
  }
  walk(value)
  for (const uri of uris) {
    let p: string
    try {
      p = decodeURIComponent(new URL(uri).pathname)
    } catch {
      return false
    }
    const real = await realpath(p).catch(() => undefined)
    if (!inside(v.dir, real)) return false
  }
  return true
}

// Defense in depth: no response may mention another visitor's workspace or a
// session the visitor does not own.
function leaksForeign(v: Visitor, text: string) {
  for (const m of text.matchAll(/\/srv\/ws\/([a-z0-9]+)/g)) if (path.join(WS_ROOT, m[1]) !== v.dir) return true
  return false
}

// ─── Route policy ────────────────────────────────────────────────────────────

const SID = "(ses_[A-Za-z0-9]+)"
type Kind =
  | "plain"
  | "session" // owner check on the session id in the path
  | "sessionList"
  | "sessionCreate"
  | "sessionActive"
  | "projects"
  | "events"
  | "models"
  | "prompt" // owner check + rate limit + body checks
  | "globalForm"
  | "integrations"
type Rule = [method: string, pattern: RegExp, kind: Kind]

const r = (method: string, p: string, kind: Kind = "plain"): Rule => [method, new RegExp(`^${p}$`), kind]
const RULES: Rule[] = [
  r("GET", "/api/info"),
  r("GET", "/api/location"),
  r("GET", "/api/fs/list"),
  r("GET", "/api/fs/find"),
  r("GET", "/api/fs/read/.+"),
  r("GET", "/api/event", "events"),
  r("GET", "/api/session/active", "sessionActive"),
  r("GET", "/api/project", "projects"),
  r("GET", "/api/plugin"),
  r("GET", "/api/experimental/migration/v1"),
  r("GET", "/api/agent(/[A-Za-z0-9_.-]+)?"),
  r("GET", "/api/command"),
  r("GET", "/api/config"),
  r("GET", "/api/config/shell"),
  // Visitors can't connect providers, so the /connect list is shown empty.
  r("GET", "/api/integration", "integrations"),
  r("GET", "/api/mcp"),
  r("GET", "/api/mcp/resource"),
  r("GET", "/api/model", "models"),
  r("GET", "/api/model/default"),
  r("GET", "/api/provider(/[A-Za-z0-9_.-]+)?", "models"),
  r("GET", "/api/reference"),
  r("GET", "/api/skill"),
  r("GET", "/api/websearch/provider"),
  r("GET", "/api/vcs(/(base|status|branch|diff))?"),
  r("GET", "/api/shell"),
  r("GET", "/api/permission/request"),
  r("GET", "/api/permission/saved"),
  r("GET", "/api/form"),
  r("GET", "/api/session", "sessionList"),
  r("POST", "/api/session", "sessionCreate"),
  r("GET", `/api/session/${SID}`, "session"),
  r("GET", `/api/session/${SID}/(message(/[A-Za-z0-9_]+)?|diff|context|inbox|form(/[A-Za-z0-9_]+)?|permission(/[A-Za-z0-9_]+)?)`, "session"),
  r("GET", `/api/session/global/form(/[A-Za-z0-9_]+)?`, "globalForm"),
  r("POST", `/api/session/global/form/[A-Za-z0-9_]+/reply`, "globalForm"),
  r("GET", `/api/experimental/session/${SID}/(log|export|instructions/entries)`, "session"),
  r("POST", `/api/session/${SID}/(prompt|command)`, "prompt"),
  r("POST", `/api/session/${SID}/(synthetic|compact|interrupt|background|agent|model|view|fork|revert/stage|revert/commit)`, "session"),
  r("POST", `/api/session/${SID}/(form/[A-Za-z0-9_]+/reply|permission/[A-Za-z0-9_]+/reply)`, "session"),
  r("POST", `/api/experimental/session/${SID}/wait`, "session"),
  r("PATCH", `/api/session/${SID}`, "session"),
  r("PATCH", `/api/session/${SID}/inbox/[A-Za-z0-9_]+`, "prompt"),
  r("DELETE", `/api/session/${SID}`, "session"),
  r("DELETE", `/api/session/${SID}/(revert|inbox/[A-Za-z0-9_]+|form/[A-Za-z0-9_]+)`, "session"),
]

const deny = (status: number, message: string) => {
  stats.denied++
  return Response.json({ error: { type: "x-opencode.denied", message } }, { status })
}

const HOP = ["authorization", "cookie", "host", "connection", "upgrade", "content-length", "x-opencode-directory", "accept-encoding"]

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const m = url.pathname.match(/^\/v\/([A-Za-z0-9_-]{32})(\/.*)$/)
  const v = m ? byToken.get(m[1]) : undefined
  if (!v || v.ended) return deny(401, "Unknown visitor")
  if (req.headers.get("upgrade")) return deny(403, "Not available in this demo")
  const route = m![2]
  const rule = RULES.find(([method, re]) => method === req.method && re.test(route))
  if (!rule) {
    log("denied route", { id: v.id, method: req.method, route: route.slice(0, 120) })
    return deny(403, "This feature is disabled in the X demo")
  }
  const kind = rule[2]
  const sessionID = route.match(/\/(ses_[A-Za-z0-9]+)/)?.[1]
  if ((kind === "session" || kind === "prompt") && !(sessionID && (await owns(v, sessionID))))
    return deny(404, "Session not found")

  // Query: pin the location, strip credentials and any caller-chosen location.
  const query = new URLSearchParams()
  for (const [k, val] of url.searchParams) {
    if (k === "auth_token" || k.startsWith("location") || k === "directory" || k === "project" || k === "subpath") continue
    if (k === "cursor") {
      const pinned = pinCursor(val, v.dir)
      if (pinned) query.set(k, pinned)
      continue
    }
    query.append(k, val)
  }
  query.set("location[directory]", v.dir)
  if (kind === "sessionList") query.set("directory", v.dir)

  const headers = new Headers()
  for (const [k, val] of req.headers) if (!HOP.includes(k.toLowerCase())) headers.set(k, val)
  headers.set("x-opencode-directory", encodeURIComponent(v.dir))

  let body: string | undefined
  if (req.method !== "GET" && req.method !== "HEAD") {
    const len = Number(req.headers.get("content-length") ?? 0)
    if (len > LIMITS.bodyBytes) return deny(413, "Too large")
    body = await req.text()
    if (body.length > LIMITS.bodyBytes) return deny(413, "Too large")
    let json: unknown = undefined
    if (body.trim()) {
      try {
        json = JSON.parse(body)
      } catch {
        return deny(400, "Invalid JSON")
      }
    }
    if (!modelRefsAreFree(json)) return deny(403, "Only the demo's model is available here")
    if (!(await attachmentsAreLocal(v, json))) return deny(403, "Attachments must come from your workspace")
    if (kind === "sessionCreate") {
      const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>
      delete o.permissions
      o.location = { directory: v.dir }
      if (typeof o.parentID === "string" && !(await owns(v, o.parentID))) return deny(404, "Session not found")
      body = JSON.stringify(o)
    }
    if (kind === "prompt") {
      const now = Date.now()
      if (v.prompts >= LIMITS.prompts) {
        stats.promptsLimited++
        return deny(429, `This demo allows ${LIMITS.prompts} messages per visit. Install OpenCode to keep going: opencode.ai`)
      }
      if (now - v.lastPrompt < LIMITS.promptGapMs) {
        stats.promptsLimited++
        return deny(429, "Slow down a little")
      }
      v.prompts++
      v.lastPrompt = now
      stats.prompts++
    }
  }

  const res = await fetch(UPSTREAM + route + "?" + query.toString(), {
    method: req.method,
    headers: (headers.set("authorization", UPSTREAM_AUTH), headers),
    body,
    redirect: "manual",
    signal: req.signal,
  }).catch((e) => {
    log("upstream error", { route, error: String(e) })
    return undefined
  })
  if (!res) return deny(502, "OpenCode server unavailable")

  if (kind === "events") return filterEvents(v, res)

  const outHeaders = new Headers(res.headers)
  outHeaders.delete("set-cookie")
  outHeaders.delete("content-length")
  outHeaders.delete("content-encoding")
  const ctype = res.headers.get("content-type") ?? ""
  if (!ctype.includes("json")) {
    // Non-JSON (file contents from /api/fs/read): location-contained upstream.
    return new Response(res.body, { status: res.status, headers: outHeaders })
  }
  let text = await res.text()
  if (res.ok) {
    try {
      text = JSON.stringify(stripSecrets(await filterJson(v, kind, JSON.parse(text))))
    } catch (e) {
      if (e instanceof Denied) return deny(403, e.message)
      // Not parseable: fall through to the leak check below.
    }
  }
  if (leaksForeign(v, text)) {
    stats.leaksBlocked++
    log("blocked foreign data", { id: v.id, route })
    return deny(403, "Not available")
  }
  return new Response(text, { status: res.status, headers: outHeaders })
}

class Denied extends Error {}

// Credentials and the identity of the model behind "Guess Who" never reach
// visitors: OpenCode echoes provider settings (apiKey, baseURL) and each
// model's upstream modelID in config and model responses.
const SECRET_KEYS = /^(apikey|api_key|authorization|password|secret|baseurl|package)$/i
function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) out[k] = "[hidden]"
    else if (k === "modelID" && typeof v === "string") out[k] = typeof (value as any).id === "string" ? (value as any).id : "[hidden]"
    else out[k] = stripSecrets(v)
  }
  return out
}

async function filterJson(v: Visitor, kind: Kind, body: any): Promise<unknown> {
  switch (kind) {
    case "sessionCreate": {
      const s = body?.data
      if (!inside(v.dir, s?.location?.directory)) throw new Denied("Session not found")
      v.sessions.add(s.id)
      return body
    }
    case "sessionList":
      if (Array.isArray(body?.data)) body.data = body.data.filter((s: any) => inside(v.dir, s?.location?.directory))
      for (const s of body?.data ?? []) v.sessions.add(s.id)
      return body
    case "sessionActive": {
      if (body?.data && typeof body.data === "object" && !Array.isArray(body.data)) {
        const kept: Record<string, unknown> = {}
        for (const [id, val] of Object.entries(body.data)) if (await owns(v, id)) kept[id] = val
        body.data = kept
      }
      return body
    }
    case "projects": {
      const list = Array.isArray(body) ? body : body?.data
      const kept = (list ?? []).filter((p: any) => inside(v.dir, p?.canonical) || inside(v.dir, p?.worktree))
      return Array.isArray(body) ? kept : { ...body, data: kept }
    }
    case "models": {
      const strip = (list: any[]) => list.filter((m) => !m?.providerID || allowedRef(m.providerID, m.id))
      if (Array.isArray(body?.data)) body.data = strip(body.data)
      else if (Array.isArray(body?.data?.models)) body.data.models = strip(body.data.models)
      return body
    }
    case "integrations":
      if (Array.isArray(body?.data)) body.data = []
      else if (Array.isArray(body)) return []
      return body
    case "session": {
      // Forks create new sessions in the same location; remember them.
      const s = body?.data
      if (s && typeof s.id === "string" && s.id.startsWith("ses_") && inside(v.dir, s?.location?.directory)) v.sessions.add(s.id)
      return body
    }
    default:
      return body
  }
}

// Session list cursors are unsigned base64url JSON that carry the query. Pin
// the directory inside them too, or a crafted cursor could list everything.
function pinCursor(cursor: string, dir: string): string | undefined {
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!o || typeof o !== "object") return undefined
    if ("directory" in o || "project" in o || "subpath" in o) {
      delete o.project
      delete o.subpath
      o.directory = dir
    }
    return Buffer.from(JSON.stringify(o)).toString("base64url")
  } catch {
    return undefined
  }
}

// /api/event is global: pass only events about this visitor's location or sessions.
function filterEvents(v: Visitor, res: Response): Response {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ""
  const keep = (block: string) => {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n")
    if (!data) return true // comments / heartbeats
    if (leaksForeign(v, data)) return false
    let ev: any
    try {
      ev = JSON.parse(data)
    } catch {
      return false
    }
    if (ev?.location?.directory) return inside(v.dir, ev.location.directory)
    const ids = new Set<string>(data.match(/ses_[A-Za-z0-9]+/g) ?? [])
    if (ids.size > 0) return [...ids].every((id) => v.sessions.has(id))
    return /^(server|provider|model|config|plugin|integration|mcp|agent|command|skill)\./.test(ev?.type ?? "")
  }
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n")
      let i: number
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (keep(block)) controller.enqueue(encoder.encode(block + "\n\n"))
      }
      if (buf.length > 4 * 1024 * 1024) buf = ""
    },
  })
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("set-cookie")
  return new Response(res.body!.pipeThrough(stream), { status: res.status, headers })
}

Bun.serve({ hostname: "127.0.0.1", port: PROXY_PORT, idleTimeout: 0, fetch: proxy })

// ─── Public server ───────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  "content-security-policy":
    "frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com; default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
}

const indexHtml = (await Bun.file(path.join(WEB_DIR, "index.html")).text()).replaceAll("__ORIGIN__", ORIGIN)
const VENDOR: Record<string, string> = {
  "xterm.mjs": "xterm/lib/xterm.mjs",
  "xterm.css": "xterm/css/xterm.css",
  "addon-fit.mjs": "addon-fit/lib/addon-fit.mjs",
  "addon-unicode11.mjs": "addon-unicode11/lib/addon-unicode11.mjs",
  "addon-webgl.mjs": "addon-webgl/lib/addon-webgl.mjs",
  "plex-400.woff2": "../@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
  "plex-500.woff2": "../@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
  "plex-600.woff2": "../@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2",
}

function clientIp(req: Request, server: import("bun").Server) {
  // The exe.dev proxy appends the real client address; anything to its left
  // came from the client and can be forged, so use the rightmost entry.
  const fwd = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
  return fwd || server.requestIP(req)?.address || "unknown"
}

Bun.serve<Conn, {}>({
  hostname: "0.0.0.0",
  port: PUBLIC_PORT,
  idleTimeout: 60,
  async fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/tty") {
      const ip = clientIp(req, server)
      const cols = Math.min(300, Math.max(20, Number(url.searchParams.get("cols")) || 80))
      const rows = Math.min(120, Math.max(5, Number(url.searchParams.get("rows")) || 24))
      if (server.upgrade(req, { data: { ip, cols, rows } })) return
      return new Response("Expected a WebSocket", { status: 400 })
    }
    if (url.pathname === "/" || url.pathname === "/play")
      return new Response(indexHtml, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } })
    if (url.pathname === "/app.mjs")
      return new Response(Bun.file(path.join(WEB_DIR, "app.mjs")), {
        headers: { ...SECURITY_HEADERS, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      })
    if (url.pathname === "/card.png") {
      const f = Bun.file(path.join(WEB_DIR, "card.png"))
      if (await f.exists()) return new Response(f, { headers: { ...SECURITY_HEADERS, "cache-control": "public, max-age=3600" } })
    }
    const vendor = url.pathname.match(/^\/vendor\/([a-z0-9.-]+)$/)?.[1]
    if (vendor && VENDOR[vendor])
      return new Response(Bun.file(path.join(VENDOR_DIR, VENDOR[vendor])), {
        headers: { ...SECURITY_HEADERS, "cache-control": "public, max-age=86400" },
      })
    if (url.pathname === "/stats")
      return Response.json(
        { ...stats, active: activeCount(), capacity: LIMITS.visitors, freeModels: [...freeModels], uptimeSeconds: Math.round((Date.now() - stats.bootedAt) / 1000) },
        { headers: { "cache-control": "no-store" } },
      )
    if (url.pathname === "/health") return new Response("ok")
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } })
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS })
  },
  websocket: {
    maxPayloadLength: LIMITS.inputBytes,
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
      const { ip } = ws.data
      const reject = (message: string) => {
        ws.send(JSON.stringify({ type: "error", message, retry: true }))
        ws.close(1013, "busy")
      }
      if (activeCount() >= LIMITS.visitors) {
        stats.rejectedFull++
        return reject("OpenCode is full right now. Try again in a minute.")
      }
      if (ipCount(ip) >= LIMITS.perIp || !allowStart(ip)) {
        stats.rejectedIp++
        return reject("Too many sessions from your network. Close another tab or try again later.")
      }
      ws.send(JSON.stringify({ type: "status", message: "Starting OpenCode…" }))
      void startVisitor(ws)
    },
    message(ws, raw) {
      const v = ws.data.visitor
      if (!v || v.ended || typeof raw !== "string") return
      let msg: any
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg?.type === "input" && typeof msg.data === "string") {
        v.lastInput = Date.now()
        v.proc?.terminal?.write(msg.data)
      } else if (msg?.type === "resize") {
        const cols = Math.min(300, Math.max(20, Number(msg.cols) || 80))
        const rows = Math.min(120, Math.max(5, Number(msg.rows) || 24))
        v.proc?.terminal?.resize(cols, rows)
      }
    },
    close(ws) {
      const v = ws.data.visitor
      if (v && !v.ended) endVisitor(v, "client closed")
    },
  },
})

// Leftover workspaces from a previous run (crash/restart) have no TUI attached.
for (const name of await Array.fromAsync(new Bun.Glob("*").scan({ cwd: WS_ROOT, onlyFiles: false }))) {
  if (!/^[a-f0-9]{16}$/.test(name)) continue
  void cleanup({ id: name, dir: path.join(WS_ROOT, name), sessions: new Set() } as unknown as Visitor)
}

log("gateway listening", { public: PUBLIC_PORT, proxy: PROXY_PORT, origin: ORIGIN })
