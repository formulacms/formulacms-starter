function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  new DataView(bytes.buffer).setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number): Uint8Array {
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

function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...new TextEncoder().encode("GIF89a"),
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
  ])
}

function webp(width: number, height: number): Uint8Array {
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

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength)
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(payload, 8)
  return bytes
}

function concat(...parts: Uint8Array[]): Uint8Array {
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

function avif(width: number, height: number): Uint8Array {
  const ftypPayload = new Uint8Array(12)
  ftypPayload.set(new TextEncoder().encode("avif"), 0)
  ftypPayload.set(new TextEncoder().encode("avif"), 8)
  const ispePayload = new Uint8Array(12)
  const view = new DataView(ispePayload.buffer)
  view.setUint32(4, width)
  view.setUint32(8, height)
  const properties = box("ipco", box("ispe", ispePayload))
  const metaPayload = concat(new Uint8Array(4), box("iprp", properties))
  return concat(box("ftyp", ftypPayload), box("meta", metaPayload))
}

const WIDTH = 640
const HEIGHT = 360

export const IMAGE_DIMENSION_FIXTURES = [
  {
    name: "PNG",
    filename: "image.png",
    mimeType: "image/png",
    width: WIDTH,
    height: HEIGHT,
    bytes: png(WIDTH, HEIGHT),
  },
  {
    name: "JPEG",
    filename: "image.jpg",
    mimeType: "image/jpeg",
    width: WIDTH,
    height: HEIGHT,
    bytes: jpeg(WIDTH, HEIGHT),
  },
  {
    name: "GIF",
    filename: "image.gif",
    mimeType: "image/gif",
    width: WIDTH,
    height: HEIGHT,
    bytes: gif(WIDTH, HEIGHT),
  },
  {
    name: "WebP",
    filename: "image.webp",
    mimeType: "image/webp",
    width: WIDTH,
    height: HEIGHT,
    bytes: webp(WIDTH, HEIGHT),
  },
  {
    name: "AVIF",
    filename: "image.avif",
    mimeType: "image/avif",
    width: WIDTH,
    height: HEIGHT,
    bytes: avif(WIDTH, HEIGHT),
  },
  {
    name: "SVG",
    filename: "image.svg",
    mimeType: "image/svg+xml",
    width: WIDTH,
    height: HEIGHT,
    bytes: new TextEncoder().encode(
      `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}"></svg>`
    ),
  },
] as const
