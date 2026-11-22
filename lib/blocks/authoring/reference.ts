import { stat, unlink } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { localStateDirectory } from "@/lib/local-state/directory"
import { writeFileAtomically } from "../../factories/atomic-write"
import { withFileRollback } from "../../factories/file-rollback"
import { normalizeReferenceImage } from "./reference-normalize"
import { DESIGN_WIDTH_REQUIRED, isDesignWidth } from "./design-width"
import {
  deviceScaleFactor,
  REFERENCE_CONTRACT_PATH,
  removeReferenceContractEntry,
  writeReferenceContractEntry,
  dprWarning,
  type ReferenceProvenance,
  type ReferenceVariant,
} from "./reference-contract"

const REFERENCE_DIR = "public/block-references"
/** Where preserved uploads live: the machine-local state folder, which a site
 *  from 0.2.0 may still have under its old name until the server start moves
 *  it. */
function originalsDirectory(root: string): string {
  const local = relative(root, localStateDirectory(root)).split(sep).join("/")
  return `${local}/block-references/originals`
}
/**
 * One ceiling governs both the uploaded design and the normalized PNG derived
 * from it. The old 700 KB cap applied to a downscaled data URL; a full
 * resolution design — which is what a comparison baseline must now be — is
 * routinely larger than that, and a lossless PNG of one is larger still.
 */
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}
const BLOCK_REFERENCE_EXTENSIONS = Object.values(EXT_BY_MEDIA_TYPE)
/** Every normalized comparison baseline is a PNG, whatever the upload was. */
const NORMALIZED_REFERENCE_EXTENSION = "png"
const BLOCK_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export type BlockReferenceInput = {
  dataUrl: string
  mediaType: string
}

export type BlockReference = {
  url: string
  path: string
}

export type BlockReferenceVariant = ReferenceVariant

function projectFile(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

function extensionFor(mediaType: string): string {
  const ext = EXT_BY_MEDIA_TYPE[mediaType]
  if (!ext) {
    throw new Error("Reference snapshot must be a PNG, JPEG, or WebP image.")
  }
  return ext
}

function basenameFor(type: string, variant: BlockReferenceVariant): string {
  return variant === "mobile" ? `${type}.mobile` : type
}

export function blockReferencePaths(type: string): string[] {
  if (!BLOCK_TYPE.test(type)) {
    throw new Error("Block type must be kebab-case.")
  }
  return (["desktop", "mobile"] as const).flatMap((variant) => {
    const basename = basenameFor(type, variant)
    return BLOCK_REFERENCE_EXTENSIONS.map(
      (ext) => `${REFERENCE_DIR}/${basename}.${ext}`
    )
  })
}

export function blockOriginalReferencePaths(
  type: string,
  root = process.cwd()
): string[] {
  if (!BLOCK_TYPE.test(type)) {
    throw new Error("Block type must be kebab-case.")
  }
  const originals = originalsDirectory(root)
  return (["desktop", "mobile"] as const).flatMap((variant) => {
    const basename = basenameFor(type, variant)
    return BLOCK_REFERENCE_EXTENSIONS.map(
      (ext) => `${originals}/${basename}.${ext}`
    )
  })
}

/** Every path one variant's reference can occupy: the baseline, the preserved
 *  original, and the tracked contract. This is the rollback unit for one save. */
function variantPersistencePaths(
  type: string,
  variant: BlockReferenceVariant,
  originals: string
): string[] {
  const basename = basenameFor(type, variant)
  return [
    ...BLOCK_REFERENCE_EXTENSIONS.map(
      (ext) => `${REFERENCE_DIR}/${basename}.${ext}`
    ),
    ...BLOCK_REFERENCE_EXTENSIONS.map(
      (ext) => `${originals}/${basename}.${ext}`
    ),
    REFERENCE_CONTRACT_PATH,
  ]
}

/**
 * The artifacts one save writes, in write order. `--dry-run` prints these, so
 * the preview names the preserved original and the tracked contract rather
 * than only the public image.
 */
export function blockReferenceArtifactPaths(
  type: string,
  variant: BlockReferenceVariant,
  mediaType: string,
  root = process.cwd()
): string[] {
  if (!BLOCK_TYPE.test(type)) {
    throw new Error("Block type must be kebab-case.")
  }
  const basename = basenameFor(type, variant)
  return [
    `${REFERENCE_DIR}/${basename}.${NORMALIZED_REFERENCE_EXTENSION}`,
    `${originalsDirectory(root)}/${basename}.${extensionFor(mediaType)}`,
    REFERENCE_CONTRACT_PATH,
  ]
}

export function decodeBlockReferenceDataUrl(input: BlockReferenceInput): Buffer {
  extensionFor(input.mediaType)
  const expectedPrefix = `data:${input.mediaType};base64,`
  if (!input.dataUrl.startsWith(expectedPrefix)) {
    throw new Error(
      "Reference snapshot data URL does not match its media type."
    )
  }
  const buffer = Buffer.from(
    input.dataUrl.slice(expectedPrefix.length),
    "base64"
  )
  if (buffer.byteLength === 0) {
    throw new Error("Reference snapshot is empty.")
  }
  if (buffer.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("Reference snapshot is too large.")
  }
  return buffer
}

async function firstExistingLocalReference(
  directory: string,
  basename: string
): Promise<string | null> {
  for (const ext of BLOCK_REFERENCE_EXTENSIONS) {
    const relativePath = `${directory}/${basename}.${ext}`
    const target = projectFile(relativePath)
    try {
      const info = await stat(target)
      if (info.isFile()) return relativePath
    } catch {
      // Try the next supported extension.
    }
  }
  return null
}

export type PersistBlockReferenceInput = {
  type: string
  variant: BlockReferenceVariant
  /** The uploaded design exactly as it arrived. */
  source: Buffer
  mediaType: string
  /** The CSS width the design was made for; captures replay at this width. */
  cssWidth: number
  provenance: ReferenceProvenance
  sectionCropAccepted: boolean
  root?: string
  /** A Block Type created earlier in this same process but not yet re-imported. */
  additionalBlockTypes?: readonly string[]
}

export type PersistedBlockReference = BlockReference & {
  /** Root-relative path of the preserved upload under ignored local state. */
  originalPath: string
  /** SHA-256 of the normalized PNG, as recorded in the tracked contract. */
  sha256: string
  width: number
  height: number
  deviceScaleFactor: number
  /** Advisory note about an unusual scale factor; never blocks the save. */
  warning: string | null
  /**
   * True when this save inherited shape checks the design already had on
   * record. Reported to the author, so replacing a picture does not quietly
   * leave them asserting geometry they never saw (plan §5 D2).
   */
  keptDeclaredGeometry: boolean
}

/**
 * The one way a block reference reaches the repository (block-fidelity plan
 * §5 B2). CLI, simulator replacement, and admin creation all call this, so a
 * baseline can never exist without its preserved original and tracked
 * contract.
 *
 * The three writes share one `withFileRollback` boundary and each is
 * individually atomic, so a failure at any step leaves the previous reference
 * exactly as it was rather than a half-replaced set.
 */
export async function persistBlockReference({
  type,
  variant,
  source,
  mediaType,
  cssWidth,
  provenance,
  sectionCropAccepted,
  root = process.cwd(),
  additionalBlockTypes,
}: PersistBlockReferenceInput): Promise<PersistedBlockReference> {
  if (!BLOCK_TYPE.test(type)) {
    throw new Error("Block type must be kebab-case.")
  }
  if (variant !== "desktop" && variant !== "mobile") {
    throw new Error("Pick either the desktop or the mobile design.")
  }
  const sourceExt = extensionFor(mediaType)
  if (!isDesignWidth(cssWidth)) throw new Error(DESIGN_WIDTH_REQUIRED)
  if (source.byteLength === 0) {
    throw new Error("Reference snapshot is empty.")
  }
  if (source.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("Reference snapshot is too large.")
  }

  const basename = basenameFor(type, variant)
  const originals = originalsDirectory(root)
  const referencePath = `${REFERENCE_DIR}/${basename}.${NORMALIZED_REFERENCE_EXTENSION}`
  const originalPath = `${originals}/${basename}.${sourceExt}`

  const { image: normalized, written } = await withFileRollback(
    root,
    variantPersistencePaths(type, variant, originals),
    async () => {
      const image = await normalizeReferenceImage(source)
      if (image.png.byteLength > MAX_REFERENCE_BYTES) {
        throw new Error(
          "That design is too large to store as a comparison baseline. Crop it to the section it shows."
        )
      }

      await writeFileAtomically(join(root, referencePath), image.png)
      await removeSiblingReferences(
        root,
        REFERENCE_DIR,
        basename,
        NORMALIZED_REFERENCE_EXTENSION
      )

      await writeFileAtomically(join(root, originalPath), source)
      await removeSiblingReferences(root, originals, basename, sourceExt)

      const written = await writeReferenceContractEntry({
        type,
        variant,
        entry: {
          cssWidth,
          sectionCropAccepted,
          provenance,
          sha256: image.sha256,
        },
        root,
        additionalBlockTypes,
      })
      return { image, written }
    }
  )

  const scale = deviceScaleFactor(normalized.width, cssWidth)
  return {
    path: referencePath,
    url: `/${referencePath.replace(/^public\//, "")}`,
    originalPath,
    sha256: normalized.sha256,
    width: normalized.width,
    height: normalized.height,
    deviceScaleFactor: scale,
    warning: dprWarning(scale),
    keptDeclaredGeometry: written.keptDeclaredGeometry,
  }
}

async function removeSiblingReferences(
  root: string,
  directory: string,
  basename: string,
  keepExt: string
): Promise<void> {
  await Promise.all(
    BLOCK_REFERENCE_EXTENSIONS.filter((ext) => ext !== keepExt).map(
      async (ext) => {
        try {
          await unlink(join(root, `${directory}/${basename}.${ext}`))
        } catch {
          // Missing stale siblings are expected.
        }
      }
    )
  )
}

/**
 * Remove a type's references. The tracked contract goes with them — leaving an
 * entry behind would be a "contract without an image" defect the repository
 * integrity check reports.
 */
export async function deleteBlockReference(type: string): Promise<string[]> {
  if (!BLOCK_TYPE.test(type)) {
    throw new Error("Block type must be kebab-case.")
  }
  const removed: string[] = []
  const originals = originalsDirectory(process.cwd())
  for (const directory of [REFERENCE_DIR, originals]) {
    for (const variant of ["desktop", "mobile"] as const) {
      const path = await firstExistingLocalReference(
        directory,
        basenameFor(type, variant)
      )
      if (!path) continue
      try {
        await unlink(projectFile(path))
        removed.push(path)
      } catch {
        // The file vanished between stat and unlink; treat as already gone.
      }
    }
  }
  for (const variant of ["desktop", "mobile"] as const) {
    if (await removeReferenceContractEntry({ type, variant })) {
      removed.push(`${REFERENCE_CONTRACT_PATH} (${variant})`)
    }
  }
  return removed
}

export async function getBlockReference(
  type: string,
  variant: BlockReferenceVariant = "desktop"
): Promise<BlockReference | null> {
  const relativePath = await firstExistingLocalReference(
    REFERENCE_DIR,
    basenameFor(type, variant)
  )
  if (!relativePath) return null
  return {
    path: relativePath,
    url: `/${relativePath.replace(/^public\//, "")}`,
  }
}

/** Whether either supported viewport variant has a committed reference. */
export async function hasBlockReference(type: string): Promise<boolean> {
  const references = await Promise.all(
    (["desktop", "mobile"] as const).map((variant) =>
      getBlockReference(type, variant)
    )
  )
  return references.some((reference) => reference !== null)
}
