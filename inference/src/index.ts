// x-opencode inference proxy (Cloudflare Worker)
//
// Holds the OpenCode Console service-account key so it never lives on the
// demo VM. The VM's OpenCode server calls this Worker with a separate proxy
// token; the Worker only accepts that token from the VM's IP, only forwards
// Anthropic-format message requests, and always rewrites the model to the one
// configured here, whatever the request asked for. The Console policy caps the
// key's spend; revoking either the key or the proxy token stops everything.

interface Env {
  CONSOLE_KEY: string // secret: OpenCode Console service-account key
  PROXY_TOKEN: string // secret: shared with the VM's OpenCode server
  ALLOWED_IPS: string // comma-separated
  UPSTREAM: string // e.g. https://opencode.ai/inference/v1
  MODEL: string // the only model ever requested upstream
  MAX_OUTPUT_TOKENS: string
}

const MAX_BODY = 4 * 1024 * 1024
const FORWARD = ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"]

const deny = (status: number, message: string) =>
  Response.json({ type: "error", error: { type: "proxy_error", message } }, { status })

function sameToken(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/health") return new Response("ok")

    const ip = req.headers.get("cf-connecting-ip") ?? ""
    if (!env.ALLOWED_IPS.split(",").map((s) => s.trim()).includes(ip)) return deny(403, "Forbidden")
    const presented =
      req.headers.get("x-api-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
    if (!sameToken(presented, env.PROXY_TOKEN)) return deny(401, "Unauthorized")

    if (req.method !== "POST" || url.pathname !== "/v1/messages") return deny(404, "Not found")
    const len = Number(req.headers.get("content-length") ?? 0)
    if (len > MAX_BODY) return deny(413, "Request too large")
    const text = await req.text()
    if (text.length > MAX_BODY) return deny(413, "Request too large")
    let body: Record<string, unknown>
    try {
      body = JSON.parse(text)
    } catch {
      return deny(400, "Invalid JSON")
    }

    // The lock: one model, bounded output, whatever the caller asked for.
    body.model = env.MODEL
    const cap = Number(env.MAX_OUTPUT_TOKENS) || 16000
    body.max_tokens = Math.min(Number(body.max_tokens) || cap, cap)

    const headers = new Headers()
    for (const h of FORWARD) {
      const v = req.headers.get(h)
      if (v) headers.set(h, v)
    }
    for (const [k, v] of req.headers) if (k.startsWith("x-opencode-") || k === "x-session-affinity") headers.set(k, v)
    headers.set("x-api-key", env.CONSOLE_KEY)
    headers.set("authorization", `Bearer ${env.CONSOLE_KEY}`)

    const upstream = await fetch(`${env.UPSTREAM}/messages`, { method: "POST", headers, body: JSON.stringify(body) })
    const out = new Headers(upstream.headers)
    out.delete("set-cookie")
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
}
