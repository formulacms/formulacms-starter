export const MAX_SVG_SCAN_BYTES = 64 * 1024

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
] as const

export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number]

export type ImageDimensions = {
  width: number
  height: number
}

export type ImageDimensionsErrorCode =
  | "unsupported_mime"
  | "mime_mismatch"
  | "truncated"
  | "malformed"
  | "dimensions_missing"
  | "invalid_dimensions"
  | "scan_limit"

export class ImageDimensionsError extends Error {
  readonly code: ImageDimensionsErrorCode

  constructor(code: ImageDimensionsErrorCode, message: string) {
    super(message)
    this.name = "ImageDimensionsError"
    this.code = code
  }
}

function fail(code: ImageDimensionsErrorCode, message: string): never {
  throw new ImageDimensionsError(code, message)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder().decode(bytes.subarray(start, start + length))
}

function matches(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.byteLength < expected.length) return false
  for (let index = 0; index < expected.length; index++) {
    if (bytes[index] !== expected[index]) return false
  }
  return true
}

function assertDimensions(
  dimensions: ImageDimensions,
  format: string
): ImageDimensions {
  if (
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    fail(
      "invalid_dimensions",
      `${format} dimensions must be positive finite numbers`
    )
  }
  return dimensions
}

function readPng(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength < 8) fail("truncated", "PNG signature is truncated")
  if (!matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    fail("mime_mismatch", "PNG MIME type does not match the file signature")
  }
  if (bytes.byteLength < 33) fail("truncated", "PNG IHDR chunk is truncated")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    fail("malformed", "PNG must begin with a valid IHDR chunk")
  }
  return assertDimensions(
    { width: view.getUint32(16), height: view.getUint32(20) },
    "PNG"
  )
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
])

function readJpeg(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength < 2) fail("truncated", "JPEG signature is truncated")
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail("mime_mismatch", "JPEG MIME type does not match the file signature")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  let markersVisited = 0

  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset++
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++
    if (offset >= bytes.byteLength) {
      fail("truncated", "JPEG marker is truncated")
    }

    const marker = bytes[offset]!
    offset++
    markersVisited++
    if (markersVisited > 1024) fail("malformed", "JPEG has too many markers")
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > bytes.byteLength) {
      fail("truncated", "JPEG segment length is truncated")
    }

    const segmentLength = view.getUint16(offset)
    if (segmentLength < 2) fail("malformed", "JPEG segment length is invalid")
    if (offset + segmentLength > bytes.byteLength) {
      fail("truncated", "JPEG segment is truncated")
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        fail("malformed", "JPEG start-of-frame segment is invalid")
      }
      return assertDimensions(
        {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        },
        "JPEG"
      )
    }
    offset += segmentLength
  }

  fail("dimensions_missing", "JPEG start-of-frame dimensions were not found")
}

function readGif(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength < 6) fail("truncated", "GIF signature is truncated")
  const signature = ascii(bytes, 0, 6)
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    fail("mime_mismatch", "GIF MIME type does not match the file signature")
  }
  if (bytes.byteLength < 10) {
    fail("truncated", "GIF logical screen descriptor is truncated")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return assertDimensions(
    { width: view.getUint16(6, true), height: view.getUint16(8, true) },
    "GIF"
  )
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16)
  )
}

function readWebp(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength < 12) fail("truncated", "WebP header is truncated")
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    fail("mime_mismatch", "WebP MIME type does not match the RIFF signature")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const declaredEnd = view.getUint32(4, true) + 8
  if (declaredEnd > bytes.byteLength) {
    fail("truncated", "WebP RIFF payload is truncated")
  }
  if (declaredEnd < 12) fail("malformed", "WebP RIFF size is invalid")

  let offset = 12
  let chunksVisited = 0
  while (offset + 8 <= declaredEnd) {
    chunksVisited++
    if (chunksVisited > 1024) fail("malformed", "WebP has too many chunks")
    const type = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const payloadStart = offset + 8
    const payloadEnd = payloadStart + size
    if (payloadEnd > declaredEnd) fail("truncated", "WebP chunk is truncated")

    if (type === "VP8X") {
      if (size < 10) fail("truncated", "WebP VP8X chunk is truncated")
      return assertDimensions(
        {
          width: readUint24LittleEndian(bytes, payloadStart + 4) + 1,
          height: readUint24LittleEndian(bytes, payloadStart + 7) + 1,
        },
        "WebP"
      )
    }
    if (type === "VP8L") {
      if (size < 5) fail("truncated", "WebP VP8L chunk is truncated")
      if (bytes[payloadStart] !== 0x2f) {
        fail("malformed", "WebP VP8L signature is invalid")
      }
      const b1 = bytes[payloadStart + 1]!
      const b2 = bytes[payloadStart + 2]!
      const b3 = bytes[payloadStart + 3]!
      const b4 = bytes[payloadStart + 4]!
      return assertDimensions(
        {
          width: 1 + b1 + ((b2 & 0x3f) << 8),
          height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
        },
        "WebP"
      )
    }
    if (type === "VP8 ") {
      if (size < 10) fail("truncated", "WebP VP8 frame header is truncated")
      if (
        bytes[payloadStart + 3] !== 0x9d ||
        bytes[payloadStart + 4] !== 0x01 ||
        bytes[payloadStart + 5] !== 0x2a
      ) {
        fail("malformed", "WebP VP8 frame signature is invalid")
      }
      return assertDimensions(
        {
          width: view.getUint16(payloadStart + 6, true) & 0x3fff,
          height: view.getUint16(payloadStart + 8, true) & 0x3fff,
        },
        "WebP"
      )
    }

    offset = payloadEnd + (size % 2)
  }
  fail("dimensions_missing", "WebP dimensions were not found")
}

type AvifBox = {
  type: string
  start: number
  contentStart: number
  end: number
}

function readAvifBox(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  end: number
): AvifBox {
  if (offset + 8 > end) fail("truncated", "AVIF box header is truncated")
  const size32 = view.getUint32(offset)
  const type = ascii(bytes, offset + 4, 4)
  let size = size32
  let contentStart = offset + 8
  if (size32 === 1) {
    if (offset + 16 > end) fail("truncated", "AVIF large box is truncated")
    const size64 = view.getBigUint64(offset + 8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("malformed", "AVIF box is too large")
    }
    size = Number(size64)
    contentStart = offset + 16
  } else if (size32 === 0) {
    size = end - offset
  }
  if (size < contentStart - offset || offset + size > end) {
    fail("truncated", "AVIF box payload is truncated")
  }
  return { type, start: offset, contentStart, end: offset + size }
}

function readAvif(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength < 16) fail("truncated", "AVIF header is truncated")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = readAvifBox(bytes, view, 0, bytes.byteLength)
  if (first.type !== "ftyp") {
    fail("mime_mismatch", "AVIF MIME type does not match the file signature")
  }

  let hasAvifBrand = false
  for (let offset = first.contentStart; offset + 4 <= first.end; offset += 4) {
    if (offset === first.contentStart + 4) continue
    const brand = ascii(bytes, offset, 4)
    if (brand === "avif" || brand === "avis") hasAvifBrand = true
  }
  if (!hasAvifBrand) {
    fail("mime_mismatch", "AVIF MIME type does not match the file brands")
  }

  const containers = new Set(["meta", "iprp", "ipco"])
  let boxesVisited = 0
  const findDimensions = (
    start: number,
    end: number,
    depth: number
  ): ImageDimensions | null => {
    if (depth > 8) fail("malformed", "AVIF box nesting is too deep")
    let offset = start
    while (offset < end) {
      boxesVisited++
      if (boxesVisited > 512) fail("malformed", "AVIF has too many boxes")
      const box = readAvifBox(bytes, view, offset, end)
      if (box.type === "ispe") {
        if (box.contentStart + 12 > box.end) {
          fail("truncated", "AVIF ispe property is truncated")
        }
        return assertDimensions(
          {
            width: view.getUint32(box.contentStart + 4),
            height: view.getUint32(box.contentStart + 8),
          },
          "AVIF"
        )
      }
      if (containers.has(box.type)) {
        const childStart = box.contentStart + (box.type === "meta" ? 4 : 0)
        if (childStart > box.end) fail("truncated", "AVIF meta box is truncated")
        const dimensions = findDimensions(childStart, box.end, depth + 1)
        if (dimensions) return dimensions
      }
      offset = box.end
    }
    return null
  }

  const dimensions = findDimensions(first.end, bytes.byteLength, 0)
  if (!dimensions) fail("dimensions_missing", "AVIF dimensions were not found")
  return dimensions
}

const SVG_NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`

function svgOpeningTag(bytes: Uint8Array): string {
  const scanned = bytes.subarray(0, MAX_SVG_SCAN_BYTES)
  let text = new TextDecoder().decode(scanned).replace(/^\uFEFF/, "")

  while (true) {
    text = text.trimStart()
    if (text.startsWith("<?xml")) {
      const end = text.indexOf("?>")
      if (end === -1) {
        if (bytes.byteLength > MAX_SVG_SCAN_BYTES) {
          fail("scan_limit", "SVG XML declaration exceeds the scan limit")
        }
        fail("truncated", "SVG XML declaration is truncated")
      }
      text = text.slice(end + 2)
      continue
    }
    if (text.startsWith("<!--")) {
      const end = text.indexOf("-->")
      if (end === -1) {
        if (bytes.byteLength > MAX_SVG_SCAN_BYTES) {
          fail("scan_limit", "SVG preamble exceeds the scan limit")
        }
        fail("truncated", "SVG comment is truncated")
      }
      text = text.slice(end + 3)
      continue
    }
    break
  }

  if (!/^<svg(?:\s|>)/i.test(text)) {
    fail("mime_mismatch", "SVG MIME type does not match a root svg element")
  }

  let quote: '"' | "'" | null = null
  for (let index = 4; index < text.length; index++) {
    const character = text[index]
    if (quote) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === ">") {
      return text.slice(0, index + 1)
    }
  }
  if (bytes.byteLength > MAX_SVG_SCAN_BYTES) {
    fail("scan_limit", "SVG root element exceeds the scan limit")
  }
  fail("truncated", "SVG root element is truncated")
}

function svgAttribute(openingTag: string, name: string): string | null {
  const match = openingTag.match(
    new RegExp(`\\b${name}\\s*=\\s*(['\"])(.*?)\\1`, "i")
  )
  return match?.[2]?.trim() ?? null
}

function svgLength(value: string | null): number | null {
  if (value === null) return null
  if (!new RegExp(`^\\+?${SVG_NUMBER}(?:px)?$`, "i").test(value)) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function readSvg(bytes: Uint8Array): ImageDimensions {
  const openingTag = svgOpeningTag(bytes)
  const widthAttribute = svgAttribute(openingTag, "width")
  const heightAttribute = svgAttribute(openingTag, "height")
  const width = svgLength(widthAttribute)
  const height = svgLength(heightAttribute)
  if (width !== null && height !== null) return { width, height }

  const viewBox = svgAttribute(openingTag, "viewBox")
  if (viewBox !== null) {
    const values = viewBox
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
    if (
      values.length === 4 &&
      values.every((value) => new RegExp(`^${SVG_NUMBER}$`, "i").test(value))
    ) {
      const parsed = values.map(Number)
      if (parsed.every(Number.isFinite)) {
        return assertDimensions(
          { width: parsed[2]!, height: parsed[3]! },
          "SVG viewBox"
        )
      }
    }
    fail("malformed", "SVG viewBox must contain four finite numbers")
  }

  if (widthAttribute !== null || heightAttribute !== null) {
    fail(
      "invalid_dimensions",
      "SVG width and height must both be positive unitless or px values"
    )
  }
  fail(
    "dimensions_missing",
    "SVG must provide positive width and height attributes or a viewBox"
  )
}

function normalizeMimeType(mimeType: string): SupportedImageMimeType {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase()
  if (
    !SUPPORTED_IMAGE_MIME_TYPES.includes(
      normalized as SupportedImageMimeType
    )
  ) {
    fail("unsupported_mime", `Unsupported image MIME type: ${normalized || ""}`)
  }
  return normalized as SupportedImageMimeType
}

export function readImageDimensions(
  input: ArrayBuffer | Uint8Array,
  mimeType: string
): ImageDimensions {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)

  switch (normalizeMimeType(mimeType)) {
    case "image/png":
      return readPng(bytes)
    case "image/jpeg":
      return readJpeg(bytes)
    case "image/gif":
      return readGif(bytes)
    case "image/webp":
      return readWebp(bytes)
    case "image/avif":
      return readAvif(bytes)
    case "image/svg+xml":
      return readSvg(bytes)
  }
}
