/**
 * Работа с байтами Serial без TextDecoder / TextEncoder —
 * в части окружений decode/encode падают на «не ArrayBuffer».
 */

export function appendSerialChunk(acc, chunk) {
  if (chunk == null) return acc
  if (typeof chunk === 'string') return acc + chunk
  try {
    let u8
    if (chunk instanceof ArrayBuffer) {
      u8 = new Uint8Array(chunk)
    } else if (chunk?.buffer && typeof chunk.byteLength === 'number') {
      u8 = new Uint8Array(chunk.buffer, chunk.byteOffset ?? 0, chunk.byteLength)
    } else {
      return acc
    }
    for (let i = 0; i < u8.length; i++) {
      acc += String.fromCharCode(u8[i])
    }
  } catch (_) {
    /* игнор */
  }
  return acc
}

/** ASCII-строка + LF → Uint8Array (для writer.write) */
export function encodeAsciiLine(text) {
  const line = String(text) + '\n'
  const out = new Uint8Array(line.length)
  for (let i = 0; i < line.length; i++) {
    out[i] = line.charCodeAt(i) & 0xff
  }
  return out
}
