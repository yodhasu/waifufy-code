// Smaller TGA textures for the phone. MMD models ship 4096-pixel TGAs (Reine's six are ~400 MB of GPU memory once
// decoded), which a phone's WebView can't hold; the link scales them down for a phone and caches the result. Only
// what MMD models use: true-color TGAs, uncompressed (type 2) or run-length encoded (type 10), 24 or 32 bits.

type Image = { width: number; height: number; /** RGBA, top row first. */ rgba: Uint8Array }

const HEADER = 18
const TRUE_COLOR = 2
const TRUE_COLOR_RLE = 10
/** Image descriptor: bit 5 set means the first row stored is the top one; bits 0-3 are the alpha bits. */
const TOP_FIRST = 0x20
const RIGHT_FIRST = 0x10

export function decodeTga(buf: Buffer): Image | undefined {
  if (buf.length < HEADER) return undefined
  const idLength = buf[0]!
  const colorMapType = buf[1]!
  const type = buf[2]!
  const width = buf.readUInt16LE(12)
  const height = buf.readUInt16LE(14)
  const bpp = buf[16]!
  const desc = buf[17]!
  if (colorMapType !== 0 || (type !== TRUE_COLOR && type !== TRUE_COLOR_RLE) || (bpp !== 24 && bpp !== 32) || !width || !height) return undefined
  if (desc & RIGHT_FIRST) return undefined
  const bytes = bpp / 8
  const n = width * height
  const rgba = new Uint8Array(n * 4)
  let src = HEADER + idLength
  let i = 0
  const put = (at: number) => {
    // TGA stores BGR(A).
    const o = i * 4
    rgba[o] = buf[at + 2]!
    rgba[o + 1] = buf[at + 1]!
    rgba[o + 2] = buf[at]!
    rgba[o + 3] = bytes === 4 ? buf[at + 3]! : 255
    i++
  }
  if (type === TRUE_COLOR) {
    if (buf.length < src + n * bytes) return undefined
    while (i < n) put(src + i * bytes)
  } else {
    while (i < n && src < buf.length) {
      const head = buf[src++]!
      const count = (head & 0x7f) + 1
      if (head & 0x80) {
        if (src + bytes > buf.length) return undefined
        for (let k = 0; k < count && i < n; k++) put(src)
        src += bytes
      } else {
        if (src + count * bytes > buf.length) return undefined
        for (let k = 0; k < count && i < n; k++) put(src + k * bytes)
        src += count * bytes
      }
    }
    if (i < n) return undefined
  }
  if (!(desc & TOP_FIRST)) flipRows(rgba, width, height)
  return { width, height, rgba }
}

function flipRows(rgba: Uint8Array, width: number, height: number) {
  const row = width * 4
  const tmp = new Uint8Array(row)
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row
    const b = (height - 1 - y) * row
    tmp.set(rgba.subarray(a, a + row))
    rgba.copyWithin(a, b, b + row)
    rgba.set(tmp, b)
  }
}

/** Halves the image until its longer side is at most `max`, averaging each 2×2 block (a box filter). */
export function shrink(img: Image, max: number): Image {
  let { width, height, rgba } = img
  while (Math.max(width, height) > max && width > 1 && height > 1) {
    const w = width >> 1
    const h = height >> 1
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = ((2 * y) * width + 2 * x) * 4
        const b = a + width * 4
        const o = (y * w + x) * 4
        for (let c = 0; c < 4; c++) out[o + c] = (rgba[a + c]! + rgba[a + 4 + c]! + rgba[b + c]! + rgba[b + 4 + c]! + 2) >> 2
      }
    }
    width = w
    height = h
    rgba = out
  }
  return { width, height, rgba }
}

/** A run-length encoded, 32-bit, top-row-first TGA. */
export function encodeTga(img: Image): Buffer {
  const { width, height, rgba } = img
  const n = width * height
  const out = Buffer.alloc(HEADER + n * 5 + Math.ceil(n / 128))
  out[2] = TRUE_COLOR_RLE
  out.writeUInt16LE(width, 12)
  out.writeUInt16LE(height, 14)
  out[16] = 32
  out[17] = TOP_FIRST | 8
  let at = HEADER
  const same = (p: number, q: number) => rgba[p * 4] === rgba[q * 4] && rgba[p * 4 + 1] === rgba[q * 4 + 1] && rgba[p * 4 + 2] === rgba[q * 4 + 2] && rgba[p * 4 + 3] === rgba[q * 4 + 3]
  const pixel = (p: number) => {
    out[at++] = rgba[p * 4 + 2]!
    out[at++] = rgba[p * 4 + 1]!
    out[at++] = rgba[p * 4]!
    out[at++] = rgba[p * 4 + 3]!
  }
  // Packets never cross a row, as the format asks.
  for (let y = 0; y < height; y++) {
    const end = (y + 1) * width
    let p = y * width
    while (p < end) {
      let run = 1
      while (p + run < end && run < 128 && same(p, p + run)) run++
      if (run > 1) {
        out[at++] = 0x80 | (run - 1)
        pixel(p)
        p += run
        continue
      }
      let raw = 1
      while (p + raw < end && raw < 128 && !(p + raw + 1 < end && same(p + raw, p + raw + 1))) raw++
      out[at++] = raw - 1
      for (let k = 0; k < raw; k++) pixel(p + k)
      p += raw
    }
  }
  return out.subarray(0, at)
}
