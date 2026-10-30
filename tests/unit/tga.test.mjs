// Unit check of link/src/tga.ts, the phone's smaller 3D textures: decoding both row orders and both encodings,
// halving down to a size, and a lossless round trip through the RLE encoder.
// Run: node tests/unit/tga.test.mjs   (no app, no Claude).
const { decodeTga, encodeTga, shrink } = await import('../../link/src/tga.ts')

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

/** An uncompressed 32-bit TGA from RGBA rows given top first; `bottomFirst` stores them the other way, as most files do. */
function rawTga(width, height, rgba, bottomFirst) {
  const b = Buffer.alloc(18 + width * height * 4)
  b[2] = 2
  b.writeUInt16LE(width, 12)
  b.writeUInt16LE(height, 14)
  b[16] = 32
  b[17] = bottomFirst ? 8 : 0x28
  for (let y = 0; y < height; y++) {
    const row = bottomFirst ? height - 1 - y : y
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const o = 18 + (row * width + x) * 4
      b[o] = rgba[s + 2]
      b[o + 1] = rgba[s + 1]
      b[o + 2] = rgba[s]
      b[o + 3] = rgba[s + 3]
    }
  }
  return b
}

// 4×2: a red top row, a blue bottom row; the last top pixel half transparent.
const W = 4, H = 2
const px = []
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.push(...(y === 0 ? [255, 0, 0, x === 3 ? 128 : 255] : [0, 0, 255, 255]))
const rgba = Uint8Array.from(px)

test('both row orders decode top row first', () => {
  for (const bottomFirst of [true, false]) {
    const img = decodeTga(rawTga(W, H, rgba, bottomFirst))
    eq([img.width, img.height, [...img.rgba.slice(0, 4)], [...img.rgba.slice(16, 20)]], [4, 2, [255, 0, 0, 255], [0, 0, 255, 255]], `bottomFirst ${bottomFirst}`)
  }
})

test('the RLE encoder round-trips exactly', () => {
  const img = decodeTga(rawTga(W, H, rgba, true))
  const back = decodeTga(encodeTga(img))
  eq([back.width, back.height, [...back.rgba]], [W, H, [...rgba]], 'same pixels')
})

test('shrink halves to the limit with a 2×2 average', () => {
  const small = shrink(decodeTga(rawTga(W, H, rgba, true)), 2)
  eq([small.width, small.height], [2, 1], 'size')
  // Left block: two red, two blue; right block: red, half-transparent red, two blue.
  eq([...small.rgba], [128, 0, 128, 255, 128, 0, 128, 223], 'averaged')
})

test('anything else is left alone', () => {
  const b = rawTga(W, H, rgba, true)
  b[1] = 1 // a color map
  eq(decodeTga(b), undefined, 'color-mapped')
  eq(decodeTga(Buffer.alloc(4)), undefined, 'truncated')
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
