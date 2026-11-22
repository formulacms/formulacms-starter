import { readFile, writeFile } from "node:fs/promises"

export interface VisualDiffResult {
  totalPixels: number
  diffPixels: number
  diffPercent: number
  diffImagePath?: string
}

// Local shape declarations for pngjs and pixelmatch.
// These are optional peer dependencies that may not be installed;
// we resolve them via dynamic import at runtime to degrade gracefully.
interface PNGImage {
  width: number
  height: number
  data: Buffer
}

interface PNGLib {
  PNG: {
    new (opts: { width: number; height: number }): PNGImage
    sync: {
      read(buffer: Buffer): PNGImage
      write(png: PNGImage): Buffer
    }
  }
}

type PixelmatchFn = (
  img1: Uint8Array,
  img2: Uint8Array,
  output: Uint8Array | null,
  width: number,
  height: number,
  options?: { threshold?: number }
) => number

/**
 * Compare two PNG files and return a pixel-level diff percentage.
 *
 * Uses `pixelmatch` + `pngjs` via dynamic import so the code degrades
 * gracefully if neither package is installed (throws a descriptive error
 * instead of crashing at module load time).
 *
 * If the images have different dimensions the comparison is clipped to the
 * intersection (min width × min height) and a warning is written to stderr.
 *
 * @param referencePath  Absolute path to the reference (design) PNG.
 * @param snapshotPath   Absolute path to the candidate (rendered) PNG.
 * @param diffOutputPath Optional absolute path; if provided the diff image is
 *                       written there as a PNG.
 * @param threshold      Per-pixel colour distance threshold (0–1, default 0.1).
 */
export async function computeVisualDiff(
  referencePath: string,
  snapshotPath: string,
  diffOutputPath?: string,
  threshold = 0.1
): Promise<VisualDiffResult> {
  // Use non-literal import specifiers so TypeScript does not attempt to
  // statically resolve the optional packages and fail type-checking when
  // they are not installed (the resolved type is `any` for dynamic specifiers).
  const pngjsId = "pngjs"
  const pixelmatchId = "pixelmatch"

  let PNG: PNGLib["PNG"]
  let pixelmatch: PixelmatchFn
  try {
    const [pngjsMod, pixelmatchMod] = await Promise.all([
      import(pngjsId),
      import(pixelmatchId),
    ])
    PNG = (pngjsMod as PNGLib).PNG
    pixelmatch = (pixelmatchMod as { default: PixelmatchFn }).default
  } catch {
    throw new Error(
      "pixelmatch not installed; run pnpm add -D pixelmatch pngjs"
    )
  }

  const [refBuffer, snapBuffer] = await Promise.all([
    readFile(referencePath),
    readFile(snapshotPath),
  ])

  const ref = PNG.sync.read(refBuffer)
  const snap = PNG.sync.read(snapBuffer)

  const width = Math.min(ref.width, snap.width)
  const height = Math.min(ref.height, snap.height)

  if (ref.width !== snap.width || ref.height !== snap.height) {
    process.stderr.write(
      `visual-diff: dimension mismatch — ` +
        `reference ${ref.width}×${ref.height}, ` +
        `snapshot ${snap.width}×${snap.height}; ` +
        `comparing ${width}×${height} intersection\n`
    )
  }

  /**
   * Crop a full-width pngjs image buffer down to `w × h`.
   * pngjs stores rows as contiguous RGBA quads; we copy row-by-row.
   */
  function cropData(png: PNGImage, w: number, h: number): Buffer {
    if (png.width === w && png.height === h) return png.data
    const out = Buffer.alloc(w * h * 4)
    for (let row = 0; row < h; row++) {
      const srcStart = row * png.width * 4
      const dstStart = row * w * 4
      png.data.copy(out, dstStart, srcStart, srcStart + w * 4)
    }
    return out
  }

  const refData = cropData(ref, width, height)
  const snapData = cropData(snap, width, height)
  const totalPixels = width * height
  const diffBuf: Buffer | null = diffOutputPath
    ? Buffer.alloc(totalPixels * 4)
    : null

  const diffPixels = pixelmatch(refData, snapData, diffBuf, width, height, {
    threshold,
  })

  let diffImagePath: string | undefined
  if (diffOutputPath && diffBuf) {
    const diffPng = new PNG({ width, height })
    diffPng.data = diffBuf
    const diffBuffer = PNG.sync.write(diffPng)
    await writeFile(diffOutputPath, diffBuffer)
    diffImagePath = diffOutputPath
  }

  return {
    totalPixels,
    diffPixels,
    diffPercent: totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0,
    diffImagePath,
  }
}
