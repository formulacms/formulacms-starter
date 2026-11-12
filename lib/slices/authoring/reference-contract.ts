/**
 * Tracked variant contract for slice references (ADR-0044; slice-fidelity
 * plan §5 B1). Parses and validates `config/slice-reference-contracts.json`
 * — the versioned, git-tracked source of each reference's accepted CSS
 * width, crop status, provenance, and normalized-image hash. Filesystem
 * cross-referencing against `public/slice-references/` lives in
 * `reference-integrity.ts`; this module only knows the JSON shape.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { REGISTERED_SLICE_TYPES } from "@/convex/lib/slices"
import { writeFileAtomically } from "./atomic-write"
import {
  unknownKeyMessage,
  validateDomContract,
  type ReferenceDomContract,
  type ValidatedDomContract,
} from "./reference-dom-contract"

const SLICE_TYPE_SET = new Set<string>(REGISTERED_SLICE_TYPES)
export const REFERENCE_CONTRACT_VERSION = 1
export const REFERENCE_CONTRACT_PATH = join(
  "config",
  "slice-reference-contracts.json"
)

export const REFERENCE_VARIANTS = ["desktop", "mobile"] as const
export type ReferenceVariant = (typeof REFERENCE_VARIANTS)[number]
const VARIANT_SET = new Set<string>(REFERENCE_VARIANTS)

const REFERENCE_PROVENANCES = ["recovered", "accepted-baseline"] as const
export type ReferenceProvenance = (typeof REFERENCE_PROVENANCES)[number]
const PROVENANCE_SET = new Set<string>(REFERENCE_PROVENANCES)

const SHA256_PATTERN = /^[0-9a-f]{64}$/

/** DPR steps a normalized capture is expected to land near (plan §5 B1 rule 9). */
const DPR_STEPS = [1, 1.5, 2, 3]
const DPR_TOLERANCE = 0.01
const DPR_WARNING_CAUSES =
  "wrong width, unclean crop, or fractional-DPR export"

export type ReferenceContractEntry = {
  cssWidth: number
  sectionCropAccepted: boolean
  /** True only when `sectionCropAccepted` is exactly `true` (plan §3 "Crop eligibility"). */
  gateEligible: boolean
  provenance: ReferenceProvenance
  sha256: string
  /** Opt-in shape checks, with defaults resolved (plan §5 D2). */
  dom?: ValidatedDomContract
}

/** The only keys an entry may carry; anything else is a defect, not a no-op. */
const ENTRY_KEYS = [
  "cssWidth",
  "sectionCropAccepted",
  "provenance",
  "sha256",
  "dom",
] as const

export function referenceContractKey(
  type: string,
  variant: string
): string {
  return `${type}:${variant}`
}

export type ReferenceContractDefect = {
  type: string
  variant?: string
  field?: string
  message: string
}

export type ReferenceContractValidation = {
  version: number
  /** Keyed by `referenceContractKey(type, variant)`; only entries that passed every rule. */
  entries: Map<string, ReferenceContractEntry>
  defects: ReferenceContractDefect[]
}

function validateEntry(
  type: string,
  variant: string,
  value: unknown,
  defects: ReferenceContractDefect[]
): ReferenceContractEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    defects.push({
      type,
      variant,
      message: "Reference contract entry must be an object.",
    })
    return null
  }
  const candidate = value as Record<string, unknown>
  let ok = true

  // Reject unknown keys before checking the known ones. Without this a
  // misspelled "dom" is silently ignored, so a design can look like it declares
  // its shape while nothing is ever measured (plan §5 D2).
  for (const key of Object.keys(candidate)) {
    if ((ENTRY_KEYS as readonly string[]).includes(key)) continue
    defects.push({
      type,
      variant,
      field: key,
      message: unknownKeyMessage(key, ENTRY_KEYS),
    })
    ok = false
  }

  if (
    typeof candidate.cssWidth !== "number" ||
    !Number.isFinite(candidate.cssWidth) ||
    candidate.cssWidth <= 0
  ) {
    defects.push({
      type,
      variant,
      field: "cssWidth",
      message: '"cssWidth" must be a finite positive number.',
    })
    ok = false
  }
  if (typeof candidate.sectionCropAccepted !== "boolean") {
    defects.push({
      type,
      variant,
      field: "sectionCropAccepted",
      message: '"sectionCropAccepted" must be a boolean.',
    })
    ok = false
  }
  if (
    typeof candidate.provenance !== "string" ||
    !PROVENANCE_SET.has(candidate.provenance)
  ) {
    defects.push({
      type,
      variant,
      field: "provenance",
      message: '"provenance" must be "recovered" or "accepted-baseline".',
    })
    ok = false
  }
  if (
    typeof candidate.sha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.sha256)
  ) {
    defects.push({
      type,
      variant,
      field: "sha256",
      message: '"sha256" must be a lowercase 64-character SHA-256 hash.',
    })
    ok = false
  }

  let dom: ValidatedDomContract | undefined
  if (candidate.dom !== undefined) {
    const domDefects: { field: string; message: string }[] = []
    const validated = validateDomContract(candidate.dom, domDefects)
    for (const defect of domDefects) {
      defects.push({ type, variant, field: defect.field, message: defect.message })
    }
    if (validated) dom = validated
    else ok = false
  }

  if (!ok) return null
  return {
    cssWidth: candidate.cssWidth as number,
    sectionCropAccepted: candidate.sectionCropAccepted as boolean,
    gateEligible: candidate.sectionCropAccepted === true,
    provenance: candidate.provenance as ReferenceProvenance,
    sha256: candidate.sha256 as string,
    ...(dom ? { dom } : {}),
  }
}

/**
 * Validate a parsed contract file. Collects every defect in one pass
 * (plan §5 B1 rule 7 — "report all integrity defects in one run") rather
 * than throwing on the first problem.
 */
export function validateReferenceContractFile(
  raw: unknown,
  additionalSliceTypes: Iterable<string> = []
): ReferenceContractValidation {
  const defects: ReferenceContractDefect[] = []
  const entries = new Map<string, ReferenceContractEntry>()
  const allowedSliceTypes = new Set([
    ...SLICE_TYPE_SET,
    ...additionalSliceTypes,
  ])

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    defects.push({
      type: "<root>",
      message: "Reference contract file must be a JSON object.",
    })
    return { version: 0, entries, defects }
  }
  const root = raw as { version?: unknown; references?: unknown }

  if (root.version !== REFERENCE_CONTRACT_VERSION) {
    defects.push({
      type: "<root>",
      field: "version",
      message: `Unsupported reference contract version "${String(root.version)}"; expected ${REFERENCE_CONTRACT_VERSION}.`,
    })
    return {
      version: typeof root.version === "number" ? root.version : 0,
      entries,
      defects,
    }
  }

  if (
    typeof root.references !== "object" ||
    root.references === null ||
    Array.isArray(root.references)
  ) {
    defects.push({
      type: "<root>",
      field: "references",
      message: 'Reference contract file must have a "references" object.',
    })
    return { version: REFERENCE_CONTRACT_VERSION, entries, defects }
  }

  for (const [type, variants] of Object.entries(
    root.references as Record<string, unknown>
  )) {
    if (!allowedSliceTypes.has(type)) {
      defects.push({ type, message: `Unknown slice type "${type}".` })
      continue
    }
    if (
      typeof variants !== "object" ||
      variants === null ||
      Array.isArray(variants)
    ) {
      defects.push({
        type,
        message: `Reference contract entry for "${type}" must be an object keyed by variant.`,
      })
      continue
    }
    for (const [variant, value] of Object.entries(
      variants as Record<string, unknown>
    )) {
      if (!VARIANT_SET.has(variant)) {
        defects.push({
          type,
          variant,
          message: `Unknown reference variant "${variant}" for "${type}".`,
        })
        continue
      }
      const entry = validateEntry(type, variant, value, defects)
      if (entry) entries.set(referenceContractKey(type, variant), entry)
    }
  }

  return { version: REFERENCE_CONTRACT_VERSION, entries, defects }
}

/** Reads and validates `config/slice-reference-contracts.json` from `root`. */
export async function loadReferenceContractFile(
  root = process.cwd()
): Promise<ReferenceContractValidation> {
  const path = join(root, REFERENCE_CONTRACT_PATH)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    return {
      version: 0,
      entries: new Map(),
      defects: [
        {
          type: "<root>",
          message: `Could not read or parse ${REFERENCE_CONTRACT_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }
  }
  return validateReferenceContractFile(raw)
}

/**
 * The stored shape of one entry. `gateEligible` is derived on read, not
 * persisted, and `dom` is stored exactly as authored — the reader resolves its
 * defaults, so persisting the resolved form would write numbers nobody chose.
 */
export type ReferenceContractWrite = Omit<
  ReferenceContractEntry,
  "gateEligible" | "dom"
> & { dom?: ReferenceDomContract }

type ReferenceContractFile = {
  references: Record<string, Record<string, ReferenceContractWrite>>
}

function describeDefects(defects: readonly ReferenceContractDefect[]): string {
  return defects
    .map((defect) => {
      const where = [defect.type, defect.variant, defect.field]
        .filter(Boolean)
        .join(" / ")
      return `${where}: ${defect.message}`
    })
    .join("\n")
}

/**
 * Read the contract file as a mutable object. A missing file is a valid empty
 * starting point; a file this version cannot understand is not — overwriting it
 * would silently discard contracts that a newer or hand-edited format holds.
 */
async function readContractFileForWrite(
  root: string
): Promise<ReferenceContractFile> {
  const path = join(root, REFERENCE_CONTRACT_PATH)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { references: {} }
    }
    throw error
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${REFERENCE_CONTRACT_PATH} is not valid JSON, so it cannot be updated safely: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const rootDefects = validateReferenceContractFile(raw).defects.filter(
    (defect) => defect.type === "<root>"
  )
  if (rootDefects.length > 0) {
    throw new Error(
      `${REFERENCE_CONTRACT_PATH} cannot be updated until it is repaired:\n${describeDefects(rootDefects)}`
    )
  }

  return {
    references: (raw as { references: ReferenceContractFile["references"] })
      .references,
  }
}

/**
 * Serialize with sorted types and declaration-ordered variants, so writing the
 * same contracts in a different order produces the same bytes. Without that,
 * every ingestion would churn this tracked file and the starter release lock.
 */
function serializeContractFile(file: ReferenceContractFile): string {
  const references: ReferenceContractFile["references"] = {}
  for (const type of Object.keys(file.references).sort()) {
    const variants = file.references[type] ?? {}
    const ordered: Record<string, ReferenceContractWrite> = {}
    for (const variant of REFERENCE_VARIANTS) {
      const entry = variants[variant]
      if (!entry) continue
      ordered[variant] = {
        cssWidth: entry.cssWidth,
        sectionCropAccepted: entry.sectionCropAccepted,
        provenance: entry.provenance,
        sha256: entry.sha256,
        // Declared geometry is copied through untouched. It is last so the
        // scalar fields stay readable at the top of each entry.
        ...(entry.dom ? { dom: entry.dom } : {}),
      }
    }
    if (Object.keys(ordered).length > 0) references[type] = ordered
  }
  return `${JSON.stringify({ version: REFERENCE_CONTRACT_VERSION, references }, null, 2)}\n`
}

async function persistContractFile(
  root: string,
  file: ReferenceContractFile,
  additionalSliceTypes: Iterable<string> = []
): Promise<void> {
  const serialized = serializeContractFile(file)
  const validation = validateReferenceContractFile(
    JSON.parse(serialized),
    additionalSliceTypes
  )
  if (validation.defects.length > 0) {
    throw new Error(
      `Reference contract would be invalid, so nothing was written:\n${describeDefects(validation.defects)}`
    )
  }
  await writeFileAtomically(
    join(root, REFERENCE_CONTRACT_PATH),
    Buffer.from(serialized, "utf8")
  )
}

export type ReferenceContractWriteResult = {
  /**
   * True when this write inherited declared geometry that was already on
   * record. Callers report it, so an author replacing a design's picture learns
   * the old shape checks still apply instead of meeting them as a puzzling
   * gate failure later.
   */
  keptDeclaredGeometry: boolean
}

/**
 * Record one reference's accepted contract. Every ingestion path writes through
 * here (plan §5 B2), so a persisted reference and its contract cannot diverge.
 * The write is atomic and fails closed: an entry the reader would reject is
 * never persisted.
 *
 * Declared geometry survives a write that does not mention it. Replacing a
 * picture is not a statement about the design's shape, and silently dropping
 * the checks would turn a passing gate into no gate at all — the one failure
 * mode a contract exists to prevent. A write that does supply `dom` replaces it.
 */
export async function writeReferenceContractEntry({
  type,
  variant,
  entry,
  root = process.cwd(),
  additionalSliceTypes = [],
}: {
  type: string
  variant: ReferenceVariant
  entry: ReferenceContractWrite
  root?: string
  /** A Slice Type written earlier in this same generator process. */
  additionalSliceTypes?: readonly string[]
}): Promise<ReferenceContractWriteResult> {
  const file = await readContractFileForWrite(root)
  const existingDom = file.references[type]?.[variant]?.dom
  const keptDeclaredGeometry = entry.dom === undefined && existingDom !== undefined

  await persistContractFile(
    root,
    {
      references: {
        ...file.references,
        [type]: {
          ...(file.references[type] ?? {}),
          [variant]: keptDeclaredGeometry ? { ...entry, dom: existingDom } : entry,
        },
      },
    },
    additionalSliceTypes
  )
  return { keptDeclaredGeometry }
}

/**
 * Drop one reference's contract, pruning the type once its last variant is
 * gone. Returns whether an entry was actually removed, so callers can report
 * honestly instead of implying a deletion that never happened.
 */
export async function removeReferenceContractEntry({
  type,
  variant,
  root = process.cwd(),
}: {
  type: string
  variant: ReferenceVariant
  root?: string
}): Promise<boolean> {
  const file = await readContractFileForWrite(root)
  const variants = file.references[type]
  if (!variants || !(variant in variants)) return false

  const remaining = { ...variants }
  delete remaining[variant]
  const references = { ...file.references }
  if (Object.keys(remaining).length > 0) references[type] = remaining
  else delete references[type]

  await persistContractFile(root, { references })
  return true
}

/** Plan §5 B1 rule 8: `deviceScaleFactor = pixelWidth / cssWidth`. */
export function deviceScaleFactor(
  pixelWidth: number,
  cssWidth: number
): number {
  return pixelWidth / cssWidth
}

/**
 * Plan §5 B1 rule 9: warn (never fail) when a device scale factor is more
 * than 1% away from every expected step. Returns `null` when within
 * tolerance of the nearest step.
 */
export function dprWarning(dpr: number): string | null {
  const nearest = DPR_STEPS.reduce((closest, step) =>
    Math.abs(step - dpr) < Math.abs(closest - dpr) ? step : closest
  )
  if (Math.abs(dpr - nearest) / nearest <= DPR_TOLERANCE) return null
  return `device scale factor ${dpr.toFixed(3)} is not within 1% of any expected step (${DPR_STEPS.join(", ")}) — likely cause: ${DPR_WARNING_CAUSES}.`
}
