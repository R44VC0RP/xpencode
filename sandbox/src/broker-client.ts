// Client for the sandbox broker (see broker.ts for the protocol).
import { decodeFrames, frame } from "./frames"

const SOCKET = process.env.BROKER_SOCKET ?? "/run/x-opencode-broker/broker.sock"

export interface BrokerProcess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly writeStdin: (bytes: Uint8Array) => void
  readonly closeStdin: () => void
  /** Exit code; rejects if the broker failed or the connection dropped. */
  readonly exited: Promise<number>
  readonly close: () => void
}

type State = {
  buf: Uint8Array
  queue: Uint8Array[]
  onFrame: (type: string, payload: Uint8Array) => void
  onClose: () => void
}

async function connect(header: object, onFrame: State["onFrame"], onClose: State["onClose"]) {
  const socket = await Bun.connect<State>({
    unix: SOCKET,
    socket: {
      data(s, chunk) {
        const { frames, rest } = decodeFrames(s.data.buf, chunk)
        s.data.buf = rest
        for (const [t, p] of frames) s.data.onFrame(t, p)
      },
      drain(s) {
        while (s.data.queue.length) {
          const head = s.data.queue[0]
          const n = s.write(head)
          if (n < head.length) {
            s.data.queue[0] = head.subarray(Math.max(0, n))
            return
          }
          s.data.queue.shift()
        }
      },
      close(s) {
        s.data.onClose()
      },
      error(s) {
        s.data.onClose()
      },
    },
    data: { buf: new Uint8Array(0), queue: [], onFrame, onClose },
  })
  const send = (bytes: Uint8Array) => {
    if (socket.data.queue.length === 0) {
      const n = socket.write(bytes)
      if (n >= bytes.length) return
      bytes = bytes.subarray(Math.max(0, n))
    }
    socket.data.queue.push(bytes)
  }
  send(frame("H", JSON.stringify(header)))
  return { socket, send }
}

/** create / destroy / kill: resolves when the broker reports success. */
export function op(header: { op: "create" | "destroy" | "kill"; id: string; [k: string]: unknown }) {
  return new Promise<void>((resolve, reject) => {
    let done = false
    connect(
      header,
      (type, payload) => {
        if (done) return
        done = true
        if (type === "X") resolve()
        else reject(new Error(new TextDecoder().decode(payload)))
      },
      () => {
        if (!done) {
          done = true
          reject(new Error("broker connection closed"))
        }
      },
    ).catch(reject)
  })
}

export async function exec(header: {
  id: string
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  marker: string
}): Promise<BrokerProcess> {
  let out!: ReadableStreamDefaultController<Uint8Array>
  let err!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) })
  const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (err = c) })
  let settle!: (code: number) => void
  let reject!: (e: Error) => void
  const exited = new Promise<number>((a, b) => ((settle = a), (reject = b)))
  let finished = false
  const end = () => {
    try {
      out.close()
    } catch {}
    try {
      err.close()
    } catch {}
  }
  const { socket, send } = await connect(
    { op: "exec", ...header },
    (type, payload) => {
      if (type === "O") out.enqueue(payload)
      else if (type === "E") err.enqueue(payload)
      else if (type === "X" || type === "F") {
        finished = true
        end()
        if (type === "X") settle(JSON.parse(new TextDecoder().decode(payload)).code ?? 1)
        else reject(new Error(new TextDecoder().decode(payload)))
      }
    },
    () => {
      if (!finished) {
        finished = true
        end()
        reject(new Error("broker connection closed"))
      }
    },
  )
  return {
    stdout,
    stderr,
    exited,
    writeStdin: (bytes) => send(frame("I", bytes)),
    closeStdin: () => send(frame("C", new Uint8Array(0))),
    close: () => socket.end(),
  }
}
