/**
 * Round-trip test for the panel's hand-written PNG code.
 *
 * `client.js` cannot import `node:buffer` (the panel renderer has no `Buffer`),
 * so both directions are plain JS and can be extracted verbatim and exercised
 * here: encode an RGBA image with the encoder, decode the bytes with the
 * decoder, and compare pixels. Extraction by marker keeps the test honest —
 * it tests the shipped code, not a copy of it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Slice a `// --- name-begin` … `// --- name-end` region out of client.js. */
function region(name) {
  const begin = source.indexOf(`// --- ${name}-begin`)
  const end = source.indexOf(`// --- ${name}-end`)
  assert.ok(begin >= 0 && end > begin, `missing ${name} region`)
  return source.slice(source.indexOf('\n', begin) + 1, end)
}

// The encoder needs bytesToBase64 and the CRC/chunk helpers; the decoder needs
// its own base64 → bytes and inflate. Assemble one scope for both.
const encoder = region('png-encoder')
const decoder = region('png-decoder')
const deflate = region('png-deflate')
const body = `
${deflate}
${encoder}
${decoder}
return { encodePng, deflateBytes, pngToRgba, bytesToBase64 }
`
const { encodePng, deflateBytes, pngToRgba, bytesToBase64 } = new Function(body)()

/** A small test image: 4×3, distinct per-pixel values, one semi-transparent pixel. */
function sample() {
  const width = 4
  const height = 3
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = (i * 7) & 0xff
    rgba[i * 4 + 1] = (255 - i * 5) & 0xff
    rgba[i * 4 + 2] = (i * 3 + 40) & 0xff
    rgba[i * 4 + 3] = 255
  }
  rgba[3] = 128 // keep one non-opaque pixel: alpha must survive the round trip
  return { width, height, rgba }
}

test('encode → decode returns the same pixels', async () => {
  const { width, height, rgba } = sample()
  const png = await encodePng(width, height, rgba, deflateBytes)
  const dataUrl = `data:image/png;base64,${bytesToBase64(png)}`
  const back = await pngToRgba(dataUrl)
  assert.equal(back.width, width)
  assert.equal(back.height, height)
  assert.deepEqual([...back.rgba], [...rgba])
})

test('the encoder writes a real PNG header and IHDR', async () => {
  const { width, height, rgba } = sample()
  const png = await encodePng(width, height, rgba, deflateBytes)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(String.fromCharCode(...png.subarray(12, 16)), 'IHDR')
  const view = new DataView(png.buffer, png.byteOffset)
  assert.equal(view.getUint32(16), width)
  assert.equal(view.getUint32(20), height)
  assert.equal(png[24], 8) // bit depth
  assert.equal(png[25], 6) // RGBA
})

test('a non-PNG data URL is rejected by name', async () => {
  await assert.rejects(() => pngToRgba('data:image/jpeg;base64,AAAA'), /was not a PNG/)
})
