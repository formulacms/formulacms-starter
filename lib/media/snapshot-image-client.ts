import { MAX_MEDIA_FILE_SIZE } from "./image-client"

export { MAX_MEDIA_FILE_SIZE }

const MAX_AI_IMAGE_DATA_URL_CHARS = 950_000
const TARGET_INLINE_IMAGE_BYTES = 675_000
const MAX_INLINE_IMAGE_DIMENSION = 1600

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readFileAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () =>
      reject(reader.error ?? new Error("Image read failed"))
    reader.readAsDataURL(blob)
  })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Could not prepare snapshot image."))
    }
    image.src = url
  })
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mediaType: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error("Could not encode snapshot image."))
      },
      mediaType,
      quality
    )
  })
}

export async function prepareSnapshotForInlineAi(
  file: File
): Promise<{ dataUrl: string; mediaType: string; bytes: number }> {
  const image = await loadImage(file)
  const scale = Math.min(
    1,
    MAX_INLINE_IMAGE_DIMENSION /
      Math.max(image.naturalWidth, image.naturalHeight)
  )
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Could not prepare snapshot canvas.")
  ctx.drawImage(image, 0, 0, width, height)

  const mediaType = "image/jpeg"
  const candidates = await Promise.all(
    [0.82, 0.72, 0.62, 0.52, 0.42].map(async (quality) => {
      const blob = await canvasToBlob(canvas, mediaType, quality)
      if (blob.size > TARGET_INLINE_IMAGE_BYTES) return null
      const dataUrl = await readFileAsDataUrl(blob)
      return dataUrl.length <= MAX_AI_IMAGE_DATA_URL_CHARS
        ? { dataUrl, mediaType, bytes: blob.size }
        : null
    })
  )
  const candidate = candidates.find((item) => item !== null)
  if (candidate) {
    return candidate
  }

  throw new Error(
    `Snapshot is too complex to inline after compression. Try a smaller crop under ${formatBytes(
      TARGET_INLINE_IMAGE_BYTES
    )}.`
  )
}
