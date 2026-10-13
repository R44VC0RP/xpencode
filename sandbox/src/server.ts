// x-opencode sandbox backend
//
// An embedded OpenCode (SDK) whose sessions run every tool inside the
// visitor's own gVisor container (see driver.ts). It serves the same HTTP API
// as `opencode serve` on 127.0.0.1:4098; the gateway's filtering proxy is its
// only client. Admin routes (bearer token) let the gateway create and destroy
// a visitor's workspace.
import { Effect } from "effect"
// The SDK's public API hides the HTTP handler; the embedded host exposes it.
import { EmbeddedHost } from "../node_modules/@opencode/sdk/dist/internal/host.js"
import { PROVIDER, provider, workspaceId } from "./driver"

const PORT = 4098
const STATE = process.env.STATE_DIR ?? "/srv/ocsbx/state"
const VERSION = process.env.OPENCODE_VERSION ?? "2.0.28"
const ADMIN_TOKEN = process.env.SANDBOX_ADMIN_TOKEN
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) throw new Error("SANDBOX_ADMIN_TOKEN is not set")
delete process.env.SANDBOX_ADMIN_TOKEN

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))

// Shell is allowed here: it runs in the visitor's container, not on the VM.
// Tools that run in this process (web fetch/search, Code Mode, MCP, skills,
// subagents) stay off, as on the shared backend. No `plugins` key: any entry
// there makes the free tier reject requests.
const CONFIG = {
  model: "opencode/big-pickle",
  update: "disable",
  share: "disabled",
  lsp: false,
  formatter: false,
  websearch: false,
  snapshots: false,
  permissions: [
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "skill", resource: "*", effect: "deny" },
    { action: "execute", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "deny" },
  ],
  experimental: {
    subagent_depth: 0,
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "opencode", effect: "allow" },
      { action: "tool.use", resource: "webfetch:*", effect: "deny" },
      { action: "tool.use", resource: "websearch:*", effect: "deny" },
      { action: "tool.use", resource: "subagent:*", effect: "deny" },
      { action: "tool.use", resource: "skill:*", effect: "deny" },
      { action: "tool.use", resource: "execute:*", effect: "deny" },
      { action: "tool.use", resource: "external_directory:*", effect: "deny" },
      { action: "integration.use", resource: "mcp:*", effect: "deny" },
      { action: "integration.use", resource: "skill:*", effect: "deny" },
    ],
  },
}

const host: any = await Effect.runPromise(
  EmbeddedHost.create({
    // A real version: the free tier rejects clients that report e.g. "1".
    app: { name: "x-opencode", version: VERSION, channel: "latest" },
    database: { path: `${STATE}/opencode.sqlite` },
    events: { persist: true },
    config: { directory: STATE, project: false, content: JSON.stringify(CONFIG) },
    fs: { filewatcher: false },
    workspaceProviders: { [PROVIDER]: provider },
  } as any),
)
const run = <A>(effect: any): Promise<A> => host.runtime.runPromise(effect)

const visitorOfDir = (dir: unknown) => (typeof dir === "string" ? dir.match(/^\/srv\/ws\/([a-f0-9]{16})$/)?.[1] : undefined)

async function createWorkspace(id: string) {
  const workspaceID = workspaceId(id)
  await run(host.workspace.create({ id: workspaceID, provider: PROVIDER }))
  await run(host.workspace.provision(workspaceID))
}

async function destroyWorkspace(id: string) {
  await run(host.workspace.destroy(workspaceId(id))).catch((e) => log("destroy failed", { id, error: String(e) }))
}

// The public session-create route cannot carry a workspace, so sessions are
// created through the host API and then read back through HTTP for the
// response shape the TUI expects.
async function createSession(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, any>
  const id = visitorOfDir(body?.location?.directory)
  if (!id) return Response.json({ error: { message: "Unknown workspace" } }, { status: 400 })
  const input: Record<string, unknown> = {
    location: { directory: `/srv/ws/${id}`, workspaceID: workspaceId(id) },
  }
  for (const k of ["id", "title", "agent", "model", "metadata"]) if (body[k] !== undefined) input[k] = body[k]
  const session: any = await run(host.sessions.create(input))
  return host.fetch(new Request(`http://opencode.local/api/session/${session.id}`))
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    try {
      if (url.pathname.startsWith("/_x/")) {
        if (req.headers.get("authorization") !== `Bearer ${ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401)
        const id = url.pathname.match(/^\/_x\/workspace\/([a-f0-9]{16})$/)?.[1]
        if (!id) return json({ error: "not found" }, 404)
        if (req.method === "POST") {
          const t0 = Date.now()
          await createWorkspace(id)
          log("workspace ready", { id, ms: Date.now() - t0 })
          return json({ ok: true })
        }
        if (req.method === "DELETE") {
          await destroyWorkspace(id)
          return json({ ok: true })
        }
        return json({ error: "method" }, 405)
      }
      // The bundled info handler fails to encode `pid`; answer it here.
      if (url.pathname === "/api/info")
        return json({
          version: VERSION,
          pid: process.pid,
          urls: [`http://127.0.0.1:${PORT}`],
          paths: { tmp: "/tmp/opencode" },
          capabilities: { persistentPty: false },
        })
      if (url.pathname === "/api/session" && req.method === "POST") return await createSession(req)
      return await host.fetch(req)
    } catch (e) {
      log("request failed", { path: url.pathname, error: String(e).slice(0, 400) })
      return json({ error: { message: "Sandbox backend error" } }, 500)
    }
  },
})
log("sandbox backend listening", { port: PORT, version: VERSION })
