// x-opencode sandbox broker
//
// The only process with Docker access (Docker access is root-equivalent), so
// it stays tiny: it creates, runs commands in and destroys per-visitor
// containers from one fixed image, under gVisor, with no network and fixed
// resource limits. Callers choose nothing else.
//
// Protocol: a Unix socket; one connection per operation. Frames are
// [type: 1 byte][length: uint32 BE][payload]. The first client frame is "H"
// with a JSON header:
//   {op:"create", id}                       -> "X" {code:0} | "F" {message}
//   {op:"destroy", id}                      -> "X" {code:0} | "F" {message}
//   {op:"exec", id, argv, cwd?, env?, marker} then "I" stdin / "C" close stdin
//                                           -> "O" stdout, "E" stderr, "X" {code}
//   {op:"kill", id, marker, signal}         -> "X" {code:0}
import { chmod, unlink } from "node:fs/promises"
import { decodeFrames, frame } from "./frames"

const SOCKET = process.env.BROKER_SOCKET ?? "/run/x-opencode-broker/broker.sock"
const IMAGE = process.env.SANDBOX_IMAGE ?? "xoc-sandbox:1"
const LABEL = "x-opencode.sandbox=1"
const MAX_AGE_MS = 45 * 60_000
const ID = /^[a-f0-9]{16}$/
const MARKER = /^[A-Za-z0-9-]{8,64}$/
const ENV_KEY = /^(LC_[A-Z]+|LANG|LANGUAGE|TERM|NO_COLOR|FORCE_COLOR|COLUMNS|LINES|GIT_PAGER|PAGER)$/
const SIGNALS = new Set(["TERM", "KILL", "INT", "HUP", "QUIT"])

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))

const name = (id: string) => `xoc-${id}`
const workspace = (id: string) => `/srv/ws/${id}`

async function docker(args: string[], timeoutMs = 60_000) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } })
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  return { code, out: out.trim(), err: err.trim() }
}

async function exists(id: string) {
  return (await docker(["inspect", "--format", "{{.State.Running}}", name(id)])).out === "true"
}

async function create(id: string) {
  if (await exists(id)) return
  await docker(["rm", "-f", name(id)]) // a stopped leftover with the same name
  const ws = workspace(id)
  const run = await docker([
    "run", "-d", "--name", name(id), "--label", LABEL,
    "--runtime=runsc", "--network=none",
    "--cpus=1", "--memory=1g", "--memory-swap=1g", "--pids-limit=256",
    "--ulimit", "nofile=4096:4096",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--tmpfs", `${ws}:rw,nosuid,nodev,size=200m,uid=1000,gid=1000,mode=0755`,
    "--tmpfs", "/home/user:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755",
    "--user", "1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--workdir", ws, "-e", "HOME=/home/user",
    IMAGE, "sleep", "infinity",
  ], 120_000)
  if (run.code !== 0) throw new Error(`docker run failed: ${run.err.slice(0, 300)}`)
  // A unique repository per visitor, like the shared backend's workspaces.
  const init = await docker(["exec", name(id), "sh", "-c",
    `cd ${ws} && git init -q && git commit -q --allow-empty -m "x-opencode workspace ${id}"`])
  if (init.code !== 0) log("git init failed", { id, err: init.err.slice(0, 200) })
  log("sandbox created", { id })
}

async function destroy(id: string) {
  await docker(["rm", "-f", name(id)])
  log("sandbox destroyed", { id })
}

const KILL_SCRIPT = `for d in /proc/[0-9]*; do
  if tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qx "XOC_PROC=$2"; then
    kill -s "$1" "\${d#/proc/}" 2>/dev/null
  fi
done
exit 0`

type Conn = {
  buf: Uint8Array
  started: boolean
  proc?: ReturnType<typeof Bun.spawn>
  queue: Uint8Array[]
  queued: number
  ending: boolean
}
type Sock = import("bun").Socket<Conn>

// socket.write may accept only part of a buffer; keep the rest until "drain".
function send(socket: Sock, bytes: Uint8Array) {
  const st = socket.data
  if (st.queue.length === 0) {
    const n = socket.write(bytes)
    if (n >= bytes.length) return
    bytes = bytes.subarray(Math.max(0, n))
  }
  st.queue.push(bytes)
  st.queued += bytes.length
  // A reader that stopped reading: stop its process instead of buffering forever.
  if (st.queued > 32 * 1024 * 1024) {
    st.proc?.kill("SIGKILL")
    socket.end()
  }
}
function flush(socket: Sock) {
  const st = socket.data
  while (st.queue.length) {
    const head = st.queue[0]
    const n = socket.write(head)
    if (n < head.length) {
      st.queue[0] = head.subarray(Math.max(0, n))
      st.queued -= Math.max(0, n)
      return
    }
    st.queue.shift()
    st.queued -= head.length
  }
  if (st.ending) socket.end()
}
function finish(socket: Sock, type: "X" | "F", body: object) {
  send(socket, frame(type, JSON.stringify(body)))
  socket.data.ending = true
  if (socket.data.queue.length === 0) socket.end()
}
const fail = (socket: Sock, message: string) => finish(socket, "F", { message })

function startExec(socket: Sock, h: any) {
  if (!Array.isArray(h.argv) || h.argv.length === 0 || h.argv.some((a: unknown) => typeof a !== "string"))
    return fail(socket, "bad argv")
  if (h.argv.reduce((n: number, a: string) => n + a.length, 0) > 2_000_000) return fail(socket, "argv too large")
  if (h.argv.some((a: string) => a.includes("\0"))) return fail(socket, "bad argv")
  if (!MARKER.test(h.marker ?? "")) return fail(socket, "bad marker")
  const cwd = typeof h.cwd === "string" && h.cwd.startsWith("/") && !h.cwd.includes("\0") ? h.cwd : undefined
  const envArgs: string[] = []
  for (const [k, v] of Object.entries(h.env ?? {}))
    if (ENV_KEY.test(k) && typeof v === "string" && !v.includes("\0") && v.length < 4096) envArgs.push("-e", `${k}=${v}`)
  const args = ["exec", "-i", ...(cwd ? ["-w", cwd] : []), ...envArgs, "-e", `XOC_PROC=${h.marker}`, name(h.id), ...h.argv]
  const proc = Bun.spawn(["docker", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } })
  socket.data.proc = proc
  const pump = async (stream: ReadableStream<Uint8Array>, type: "O" | "E") => {
    for await (const chunk of stream) send(socket, frame(type, chunk))
  }
  Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, "O"), pump(proc.stderr as ReadableStream<Uint8Array>, "E"), proc.exited])
    .then(([, , code]) => finish(socket, "X", { code }))
    .catch((e) => fail(socket, String(e)))
}

async function handleHeader(socket: Sock, payload: Uint8Array) {
  let h: any
  try {
    h = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    return fail(socket, "bad header")
  }
  if (!ID.test(h?.id ?? "")) return fail(socket, "bad id")
  try {
    switch (h.op) {
      case "create":
        await create(h.id)
        break
      case "destroy":
        await destroy(h.id)
        break
      case "kill": {
        if (!MARKER.test(h.marker ?? "") || !SIGNALS.has(h.signal)) return fail(socket, "bad kill")
        await docker(["exec", name(h.id), "sh", "-c", KILL_SCRIPT, "sh", h.signal, h.marker], 30_000)
        break
      }
      case "exec":
        return startExec(socket, h)
      default:
        return fail(socket, "bad op")
    }
    finish(socket, "X", { code: 0 })
  } catch (e) {
    log("op failed", { op: h.op, id: h.id, error: String(e).slice(0, 300) })
    fail(socket, String(e).slice(0, 300))
  }
}

await unlink(SOCKET).catch(() => {})
Bun.listen<Conn>({
  unix: SOCKET,
  socket: {
    open(socket) {
      socket.data = { buf: new Uint8Array(0), started: false, queue: [], queued: 0, ending: false }
    },
    drain(socket) {
      flush(socket)
    },
    data(socket, chunk) {
      const st = socket.data
      const { frames, rest } = decodeFrames(st.buf, chunk)
      st.buf = rest
      for (const [type, payload] of frames) {
        if (!st.started) {
          if (type !== "H") return fail(socket, "expected header")
          st.started = true
          void handleHeader(socket, payload)
          continue
        }
        const stdin = st.proc?.stdin as import("bun").FileSink | undefined
        if (type === "I") stdin?.write(payload)
        else if (type === "C") void stdin?.end()
      }
      if (st.buf.length > 8 * 1024 * 1024) fail(socket, "frame too large")
    },
    close(socket) {
      // Caller went away (e.g. OpenCode killed the tool): stop the docker client.
      if (socket.data?.proc && socket.data.proc.exitCode === null) socket.data.proc.kill("SIGKILL")
      const stdin = socket.data?.proc?.stdin as import("bun").FileSink | undefined
      try {
        void stdin?.end()
      } catch {}
    },
  },
})
await chmod(SOCKET, 0o660)

// Backstop: containers outliving any visit (gateway crash, lost destroy).
async function gc(all = false) {
  const ps = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}} {{.CreatedAt}}"])
  for (const line of ps.out.split("\n").filter(Boolean)) {
    const [n, ...created] = line.split(" ")
    const age = Date.now() - Date.parse(created.slice(0, 3).join(" "))
    if (all || !(age < MAX_AGE_MS)) {
      await docker(["rm", "-f", n])
      log("sandbox reaped", { name: n, all })
    }
  }
}
await gc(true)
setInterval(() => void gc(), 60_000)
log("broker listening", { socket: SOCKET, image: IMAGE })
