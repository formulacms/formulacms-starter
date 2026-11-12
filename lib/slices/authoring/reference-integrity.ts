/**
 * Integrity checks over `public/slice-references` (ADR-0044 §3).
 * Header-only PNG parsing never decodes images or requires image dependencies.
 */
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { REGISTERED_SLICE_TYPES } from "@/convex/lib/slices"
import {
  deviceScaleFactor,
  dprWarning,
  loadReferenceContractFile,
  referenceContractKey,
  type ReferenceVariant,
} from "./reference-contract"

const REFERENCE_DIR = join("public", "slice-references")
export const TALL_ASPECT_LIMIT = 3

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

export function pngDimensions(
  buf: Buffer
): { width: number; height: number } | null {
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

type ScannedReferenceFile = {
  file: string
  hash: string
  dims: { width: number; height: number } | null
}

type ReferenceDirectoryScan = {
  /** Files matching the supported image extensions (png/jpg/webp). */
  images: ScannedReferenceFile[]
  /** Files present in the directory that don't match any supported extension. */
  unsupported: string[]
}

async function scanReferenceFiles(
  dir: string
): Promise<ReferenceDirectoryScan> {
  const entries = await readdir(dir).catch(() => [] as string[])
  const sorted = [...entries].sort()
  const images: ScannedReferenceFile[] = []
  const unsupported: string[] = []

  for (const file of sorted) {
    // A dot-prefixed entry is never a reference. The atomic writer stages
    // `.<name>.<uuid>.tmp` beside its target, so an interrupted save would
    // otherwise be reported as an unsupported image rather than the crash
    // leftover it is.
    if (file.startsWith(".")) continue
    if (!/\.(?:png|jpg|webp)$/i.test(file)) {
      unsupported.push(file)
      continue
    }
    const buf = await readFile(join(dir, file))
    images.push({
      file,
      hash: createHash("sha256").update(buf).digest("hex"),
      dims: pngDimensions(buf),
    })
  }

  return { images, unsupported }
}

export type ReferenceIntegrityReport = {
  duplicates: { hash: string; files: string[] }[]
  tall: { file: string; width: number; height: number }[]
}

export async function checkReferenceIntegrity(
  root = process.cwd()
): Promise<ReferenceIntegrityReport> {
  const dir = join(root, REFERENCE_DIR)
  const { images } = await scanReferenceFiles(dir)
  const byHash = new Map<string, string[]>()
  const tall: ReferenceIntegrityReport["tall"] = []

  for (const { file, hash, dims } of images) {
    byHash.set(hash, [...(byHash.get(hash) ?? []), file])
    if (
      dims &&
      dims.width > 0 &&
      dims.height / dims.width > TALL_ASPECT_LIMIT
    ) {
      tall.push({ file, ...dims })
    }
  }

  return {
    duplicates: [...byHash.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([hash, group]) => ({ hash, files: group })),
    tall,
  }
}

/**
 * Slice-reference filename convention (mirrors `reference.ts`'s
 * `basenameFor`, duplicated locally per the existing `verify.ts` precedent
 * rather than exporting it from `reference.ts`, which B1 does not touch).
 */
function referenceVariantIndex(): Map<
  string,
  { type: string; variant: ReferenceVariant }
> {
  const index = new Map<string, { type: string; variant: ReferenceVariant }>()
  for (const type of REGISTERED_SLICE_TYPES) {
    index.set(type, { type, variant: "desktop" })
    index.set(`${type}.mobile`, { type, variant: "mobile" })
  }
  return index
}

export type ReferenceContractIntegrityDefect =
  | {
      kind: "invalid-field"
      type: string
      variant?: string
      field?: string
      message: string
    }
  | {
      kind: "image-without-contract"
      type: string
      variant: ReferenceVariant
      file: string
    }
  | {
      kind: "contract-without-image"
      type: string
      variant: ReferenceVariant
    }
  | {
      kind: "hash-mismatch"
      type: string
      variant: ReferenceVariant
      file: string
      expected: string
      actual: string
    }
  | { kind: "unsupported-file"; file: string }

export type ReferenceContractIntegrityReport = {
  defects: ReferenceContractIntegrityDefect[]
  warnings: string[]
}

/**
 * Cross-references `config/slice-reference-contracts.json` against
 * `public/slice-references/` (plan §5 B1 rule 7). Since B4 migrated the
 * original references, this is a hard repository gate: `pnpm
 * check:slices:references` runs it in ordinary CI, and the aggregate fidelity
 * command runs it before it captures anything.
 */
export async function checkReferenceContractIntegrity(
  root = process.cwd()
): Promise<ReferenceContractIntegrityReport> {
  const contract = await loadReferenceContractFile(root)
  const defects: ReferenceContractIntegrityDefect[] = contract.defects.map(
    (defect) => ({ kind: "invalid-field", ...defect })
  )
  const warnings: string[] = []

  const dir = join(root, REFERENCE_DIR)
  const { images, unsupported } = await scanReferenceFiles(dir)
  const index = referenceVariantIndex()
  const matchedKeys = new Set<string>()

  for (const file of unsupported) {
    defects.push({ kind: "unsupported-file", file })
  }

  for (const { file, hash, dims } of images) {
    const basename = file.replace(/\.(?:png|jpg|webp)$/i, "")
    const match = index.get(basename)
    if (!match) {
      defects.push({ kind: "unsupported-file", file })
      continue
    }
    const { type, variant } = match
    const key = referenceContractKey(type, variant)
    const entry = contract.entries.get(key)
    if (!entry) {
      defects.push({ kind: "image-without-contract", type, variant, file })
      continue
    }
    matchedKeys.add(key)
    if (entry.sha256 !== hash) {
      defects.push({
        kind: "hash-mismatch",
        type,
        variant,
        file,
        expected: entry.sha256,
        actual: hash,
      })
      continue
    }
    if (dims) {
      const dpr = deviceScaleFactor(dims.width, entry.cssWidth)
      const warning = dprWarning(dpr)
      if (warning) warnings.push(`${type}/${variant}: ${warning}`)
    }
  }

  for (const key of contract.entries.keys()) {
    if (matchedKeys.has(key)) continue
    const [type, variant] = key.split(":") as [string, ReferenceVariant]
    defects.push({ kind: "contract-without-image", type, variant })
  }

  return { defects, warnings }
}
