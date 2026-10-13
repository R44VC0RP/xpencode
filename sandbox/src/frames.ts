// Length-prefixed frames shared by the broker and its client:
// [type: 1 ASCII byte][length: uint32 big-endian][payload].
const enc = new TextEncoder()

export function frame(type: string, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : payload
  const out = new Uint8Array(5 + body.length)
  out[0] = type.charCodeAt(0)
  new DataView(out.buffer).setUint32(1, body.length)
  out.set(body, 5)
  return out
}

export function decodeFrames(
  buf: Uint8Array,
  chunk: Uint8Array,
): { frames: Array<[string, Uint8Array]>; rest: Uint8Array } {
  let data = buf
  if (chunk.length) {
    data = new Uint8Array(buf.length + chunk.length)
    data.set(buf)
    data.set(chunk, buf.length)
  }
  const frames: Array<[string, Uint8Array]> = []
  let at = 0
  while (data.length - at >= 5) {
    const len = new DataView(data.buffer, data.byteOffset + at + 1, 4).getUint32(0)
    if (data.length - at - 5 < len) break
    frames.push([String.fromCharCode(data[at]), data.slice(at + 5, at + 5 + len)])
    at += 5 + len
  }
  return { frames, rest: data.slice(at) }
}
