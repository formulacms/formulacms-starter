"use client"

export { parseDesignWidth } from "./design-width"

/**
 * Read an uploaded design exactly as it arrived, plus the pixel width shown in
 * the "How wide was this design made for?" prompt.
 *
 * Deliberately no downscaling: the bytes read here become both the preserved
 * original and the source of the normalized comparison baseline
 * (slice-fidelity plan §5 B2). The AI-analysis path still compacts its own
 * copy; the two must not be confused.
 */
export type DesignUpload = {
  dataUrl: string
  mediaType: string
  pixelWidth: number
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("Image read failed"))
    reader.readAsDataURL(file)
  })
}

export function readDesignPixelWidth(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new window.Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image.naturalWidth)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("That file could not be read as an image."))
    }
    image.src = url
  })
}

export async function readDesignForUpload(file: File): Promise<DesignUpload> {
  const [dataUrl, pixelWidth] = await Promise.all([
    readAsDataUrl(file),
    readDesignPixelWidth(file),
  ])
  return {
    dataUrl,
    mediaType: file.type || "image/png",
    pixelWidth,
  }
}
