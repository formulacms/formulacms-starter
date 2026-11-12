import { describe, expect, it } from "vitest"
import {
  ImageDimensionsError,
  MAX_SVG_SCAN_BYTES,
  readImageDimensions,
} from "./imageDimensions"

function pngFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  new DataView(bytes.buffer).setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function jpegFixture(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x08,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
  ])
}

function gifFixture(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...new TextEncoder().encode("GIF89a"),
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
  ])
}

function webpFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode("RIFF"), 0)
  new DataView(bytes.buffer).setUint32(4, 22, true)
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8)
  new DataView(bytes.buffer).setUint32(16, 10, true)
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  bytes.set(
    [
      widthMinusOne & 0xff,
      (widthMinusOne >> 8) & 0xff,
      (widthMinusOne >> 16) & 0xff,
    ],
    24
  )
  bytes.set(
    [
      heightMinusOne & 0xff,
      (heightMinusOne >> 8) & 0xff,
      (heightMinusOne >> 16) & 0xff,
    ],
    27
  )
  return bytes
}

function webpChunkFixture(type: string, payload: Uint8Array): Uint8Array {
  const paddedSize = payload.byteLength + (payload.byteLength % 2)
  const bytes = new Uint8Array(12 + 8 + paddedSize)
  bytes.set(new TextEncoder().encode("RIFF"), 0)
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true)
  bytes.set(new TextEncoder().encode("WEBP"), 8)
  bytes.set(new TextEncoder().encode(type), 12)
  new DataView(bytes.buffer).setUint32(16, payload.byteLength, true)
  bytes.set(payload, 20)
  return bytes
}

function lossyWebpFixture(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(10)
  payload.set([0x9d, 0x01, 0x2a], 3)
  const view = new DataView(payload.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return webpChunkFixture("VP8 ", payload)
}

function losslessWebpFixture(width: number, height: number): Uint8Array {
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  return webpChunkFixture(
    "VP8L",
    Uint8Array.from([
      0x2f,
      widthMinusOne & 0xff,
      ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
      (heightMinusOne >> 2) & 0xff,
      (heightMinusOne >> 10) & 0x0f,
    ])
  )
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength)
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(payload, 8)
  return bytes
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0)
  )
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function avifFixture(width: number, height: number): Uint8Array {
  const ftypPayload = new Uint8Array(12)
  ftypPayload.set(new TextEncoder().encode("avif"), 0)
  ftypPayload.set(new TextEncoder().encode("avif"), 8)

  const ispePayload = new Uint8Array(12)
  const view = new DataView(ispePayload.buffer)
  view.setUint32(4, width)
  view.setUint32(8, height)
  const properties = box("ipco", box("ispe", ispePayload))
  const metaPayload = concatBytes(new Uint8Array(4), box("iprp", properties))

  return concatBytes(box("ftyp", ftypPayload), box("meta", metaPayload))
}

describe("readImageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    expect(readImageDimensions(pngFixture(640, 360), "image/png")).toEqual({
      width: 640,
      height: 360,
    })
  })

  it("reads JPEG dimensions from a start-of-frame segment", () => {
    expect(readImageDimensions(jpegFixture(800, 600), "image/jpeg")).toEqual({
      width: 800,
      height: 600,
    })
  })

  it("reads GIF dimensions from the logical screen descriptor", () => {
    expect(readImageDimensions(gifFixture(320, 240), "image/gif")).toEqual({
      width: 320,
      height: 240,
    })
  })

  it("reads WebP dimensions from a VP8X chunk", () => {
    expect(readImageDimensions(webpFixture(1024, 512), "image/webp")).toEqual({
      width: 1024,
      height: 512,
    })
  })

  it.each([
    ["lossy VP8", lossyWebpFixture(800, 450)],
    ["lossless VP8L", losslessWebpFixture(800, 450)],
  ])("reads WebP dimensions from a %s header", (_variant, bytes) => {
    expect(readImageDimensions(bytes, "image/webp")).toEqual({
      width: 800,
      height: 450,
    })
  })

  it("reads AVIF dimensions from the image spatial extents property", () => {
    expect(readImageDimensions(avifFixture(1440, 900), "image/avif")).toEqual({
      width: 1440,
      height: 900,
    })
  })

  it("reads SVG dimensions from positive unitless and px attributes", () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg width="1200px" height="630" viewBox="0 0 12 6"></svg>'
    )

    expect(readImageDimensions(svg, "image/svg+xml")).toEqual({
      width: 1200,
      height: 630,
    })
  })

  it("falls back to SVG viewBox dimensions without inventing a scale", () => {
    const svg = new TextEncoder().encode(
      '<svg viewBox="-10 -20 640.5 360.25"></svg>'
    )

    expect(readImageDimensions(svg, "image/svg+xml")).toEqual({
      width: 640.5,
      height: 360.25,
    })
  })

  it("returns a typed rejection when raster magic bytes disagree with MIME", () => {
    expect(() =>
      readImageDimensions(pngFixture(640, 360), "image/jpeg")
    ).toThrowError(
      expect.objectContaining<Partial<ImageDimensionsError>>({
        name: "ImageDimensionsError",
        code: "mime_mismatch",
      })
    )
  })

  it.each([
    ["PNG", pngFixture(10, 10).subarray(0, 20), "image/png"],
    ["JPEG", jpegFixture(10, 10).subarray(0, 10), "image/jpeg"],
    ["GIF", gifFixture(10, 10).subarray(0, 8), "image/gif"],
    ["WebP", webpFixture(10, 10).subarray(0, 29), "image/webp"],
    ["AVIF", avifFixture(10, 10).subarray(0, 10), "image/avif"],
    [
      "SVG",
      new TextEncoder().encode("<svg width='10'"),
      "image/svg+xml",
    ],
  ])("rejects truncated %s data with a typed error", (_format, bytes, mime) => {
    expect(() => readImageDimensions(bytes, mime)).toThrowError(
      expect.objectContaining<Partial<ImageDimensionsError>>({
        code: "truncated",
      })
    )
  })

  it.each([
    ["PNG", new Uint8Array(33), "image/png"],
    ["JPEG", new Uint8Array(12), "image/jpeg"],
    ["GIF", new Uint8Array(10), "image/gif"],
    ["WebP", new Uint8Array(30), "image/webp"],
    [
      "AVIF",
      box(
        "ftyp",
        new TextEncoder().encode("heic\u0000\u0000\u0000\u0000heic")
      ),
      "image/avif",
    ],
    ["SVG", new TextEncoder().encode("<html></html>"), "image/svg+xml"],
  ])("rejects garbage %s data as a MIME mismatch", (_format, bytes, mime) => {
    expect(() => readImageDimensions(bytes, mime)).toThrowError(
      expect.objectContaining<Partial<ImageDimensionsError>>({
        code: "mime_mismatch",
      })
    )
  })

  const invalidSvgCases: Array<
    [string, string, ImageDimensionsError["code"]]
  > = [
    ["dimensionless", "<svg></svg>", "dimensions_missing"],
    [
      "unsupported length",
      '<svg width="10%" height="-4"></svg>',
      "invalid_dimensions",
    ],
    [
      "malformed viewBox",
      '<svg viewBox="0 0 nope 4"></svg>',
      "malformed",
    ],
  ]

  it.each(invalidSvgCases)(
    "rejects %s SVG input clearly",
    (_case, source, code) => {
      expect(() =>
        readImageDimensions(new TextEncoder().encode(source), "image/svg+xml")
      ).toThrowError(
        expect.objectContaining<Partial<ImageDimensionsError>>({ code })
      )
    }
  )

  it("bounds SVG root scanning", () => {
    const source = `<svg ${"a".repeat(MAX_SVG_SCAN_BYTES)}`

    expect(() =>
      readImageDimensions(new TextEncoder().encode(source), "image/svg+xml")
    ).toThrowError(
      expect.objectContaining<Partial<ImageDimensionsError>>({
        code: "scan_limit",
      })
    )
  })
})
