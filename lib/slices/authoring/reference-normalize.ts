/**
 * Deterministic reference-image normalization (slice-fidelity plan §5 B2,
 * "Normalized output").
 *
 * Every stored comparison baseline and — from B3 onward — every captured
 * candidate passes through this one function, so a baseline hash and a
 * candidate hash are only ever compared under identical decoding assumptions.
 *
 * ## The recipe is the contract
 *
 * Changing any step below changes every `sha256` in
 * `config/slice-reference-contracts.json`. Treat it as a versioned format, not
 * an implementation detail:
 *
 * 1. **EXIF orientation is baked into the pixels** (`rotate()` with no
 *    argument). The stored PNG needs no viewer-side rotation and carries no
 *    orientation tag.
 * 2. **Colour is device-independent sRGB.** sharp's documented default with no
 *    `withMetadata()`/`keepMetadata()` call is to convert to sRGB and strip all
 *    metadata; `toColourspace("srgb")` states that intent explicitly rather
 *    than inheriting it, and pins 8-bit channels for a 16-bit source.
 * 3. **No metadata survives.** An embedded ICC profile, timestamp, or comment
 *    would otherwise make two visually identical exports hash differently.
 * 4. **Encoder options are fixed**, never left to defaults that can move
 *    between sharp releases. `palette: false` keeps the output true colour, so
 *    the quantiser — the one non-deterministic PNG stage — never runs.
 */
import { createHash } from "node:crypto"

/** Fixed PNG encoder options; see step 4 above. */
const PNG_ENCODER_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: false,
  palette: false,
  progressive: false,
} as const

export type NormalizedReferenceImage = {
  /** The deterministic sRGB PNG representation stored for comparison. */
  png: Buffer
  /** SHA-256 over exactly `png` — the value recorded in the tracked contract. */
  sha256: string
  width: number
  height: number
}

/**
 * `sharp` is a native module, so it is loaded on demand. That keeps it out of
 * the module graph of the edge-runtime test project and of any bundle that
 * merely imports a reference path helper.
 */
async function loadSharp() {
  return (await import("sharp")).default
}

export async function normalizeReferenceImage(
  source: Buffer
): Promise<NormalizedReferenceImage> {
  const sharp = await loadSharp()
  let png: Buffer
  let info: { width: number; height: number }
  try {
    const result = await sharp(source, { failOn: "error" })
      .rotate()
      .toColourspace("srgb")
      .png(PNG_ENCODER_OPTIONS)
      .toBuffer({ resolveWithObject: true })
    png = result.data
    info = { width: result.info.width, height: result.info.height }
  } catch (error) {
    throw new Error(
      `That file could not be read as an image: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return {
    png,
    sha256: createHash("sha256").update(png).digest("hex"),
    width: info.width,
    height: info.height,
  }
}
