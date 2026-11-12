import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import { withFileRollback } from "./file-rollback"
import { rootFile } from "./paths"
import {
  parseSliceSpecJson,
  persistSliceSpec,
  previewSliceSpecPersistence,
  sliceCreationPersistencePaths,
  type PersistedSlice,
  type SlicePersistencePreview,
} from "./persist"
import { scaffoldSlice } from "./scaffold"

export type ReviewedSliceCreation = {
  specJson: string
  expectedType: string
  expectedCatalogSourceRevision: string
}

/** Trusted controller adapters, not an authorization boundary. The caller must
 * qualify the finite catalog's complete source coverage, installation receipt,
 * ordinary owner session and current backend contracts before entry. The catalog
 * reader is source-only; the gate uses the installed ordinary typecheck/SSR path.
 * External source writers must remain quiescent throughout apply and rollback. */
export type SliceCreationAdapters = {
  readCatalog: (root: string) => Promise<{
    sourceRevision: string
    registeredTypes: readonly string[]
  }>
  runCreationGate: (type: string, root: string) => Promise<void>
}

type CreationRefusal = {
  status: "refused"
  reason: "wrong_type" | "stale_catalog" | "conflict"
  conflicts?: string[]
}

type CreationReview = SlicePersistencePreview & {
  status: "reviewed"
  normalizedSpecJson: string
  scaffold: ReturnType<typeof scaffoldSlice>
}

const SHA256 = /^[a-f0-9]{64}$/
// The ordinary emitter maps dash-before-letter to camel/Pascal identifiers.
// Numeric dash segments cannot become valid generated identifiers today.
const TYPE = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/

function matchesWhole(pattern: RegExp, value: unknown): value is string {
  // JavaScript's $ also matches before a final newline. Review identities must
  // match the complete literal string, including its final character.
  return typeof value === "string" && pattern.exec(value)?.[0] === value
}

function captureRequest(request: ReviewedSliceCreation): ReviewedSliceCreation {
  const { specJson, expectedType, expectedCatalogSourceRevision } = request
  if (typeof specJson !== "string")
    throw new Error("SliceSpec JSON must be a string.")
  return { specJson, expectedType, expectedCatalogSourceRevision }
}

function parseRequest(request: ReviewedSliceCreation, root: string) {
  if (!isAbsolute(root))
    throw new Error("A selected absolute application root is required.")
  if (
    !matchesWhole(TYPE, request.expectedType) ||
    !matchesWhole(SHA256, request.expectedCatalogSourceRevision)
  )
    throw new Error(
      "A valid new Type and catalog source revision are required."
    )
  // Only the real model parser and deterministic scaffold are admitted. There
  // is no custom renderer, asset, AI execution or arbitrary source option.
  return parseSliceSpecJson(request.specJson)
}

async function catalogRefusal(
  request: ReviewedSliceCreation,
  readCatalog: SliceCreationAdapters["readCatalog"],
  root: string
): Promise<CreationRefusal | null> {
  const { sourceRevision, registeredTypes } = await readCatalog(root)
  if (!Array.isArray(registeredTypes))
    throw new Error("The trusted catalog reader returned an invalid catalog.")
  const types = [...registeredTypes]
  if (
    !matchesWhole(SHA256, sourceRevision) ||
    types.some((type) => !matchesWhole(TYPE, type)) ||
    new Set(types).size !== types.length
  )
    throw new Error("The trusted catalog reader returned an invalid catalog.")
  if (sourceRevision !== request.expectedCatalogSourceRevision)
    return { status: "refused", reason: "stale_catalog" }
  if (types.includes(request.expectedType))
    return {
      status: "refused",
      reason: "conflict",
      conflicts: [`Slice "${request.expectedType}" is already registered.`],
    }
  return null
}

/** Zero-write review of the actual model validation and persistence projection. */
export async function reviewSliceModelCreation(
  request: ReviewedSliceCreation,
  adapters: Pick<SliceCreationAdapters, "readCatalog">,
  root: string
): Promise<CreationReview | CreationRefusal> {
  const captured = captureRequest(request)
  const spec = parseRequest(captured, root)
  if (spec.type !== captured.expectedType)
    return { status: "refused", reason: "wrong_type" }
  for (const path of sliceCreationPersistencePaths(spec)) rootFile(root, path)
  const refusal = await catalogRefusal(captured, adapters.readCatalog, root)
  if (refusal) return refusal
  const preview = await previewSliceSpecPersistence(spec, { root })
  return {
    ...preview,
    status: "reviewed",
    normalizedSpecJson: JSON.stringify(spec, null, 2),
    scaffold: scaffoldSlice(spec),
  }
}

/** Apply only the trusted deterministic scaffold to an explicitly reviewed
 * catalog. Source origin and optional tools projections remain persistence's
 * ordinary behavior; the controller must refuse the source/blueprint itself. */
export async function createReviewedSliceModel(
  request: ReviewedSliceCreation,
  adapters: SliceCreationAdapters,
  root: string
): Promise<({ status: "created" } & PersistedSlice) | CreationRefusal> {
  const captured = captureRequest(request)
  const review = await reviewSliceModelCreation(captured, adapters, root)
  if (review.status === "refused") return review
  if (review.conflicts.length)
    return {
      status: "refused",
      reason: "conflict",
      conflicts: review.conflicts,
    }
  const spec = parseSliceSpecJson(review.normalizedSpecJson)
  const paths = [
    ...new Set([
      ...sliceCreationPersistencePaths(spec),
      ...review.files.map(({ path }) => path),
    ]),
  ]
  for (const path of paths) rootFile(root, path)
  return withFileRollback(root, paths, async () => {
    // The final controller catalog read precedes the commit. Only synchronous
    // preconditions and ordinary local persistence reads follow it before the
    // first write; no asynchronous backend operation follows this read.
    // Refusal resolves rather than triggering restoration over current work.
    const refusal = await catalogRefusal(captured, adapters.readCatalog, root)
    if (refusal) return refusal
    for (const path of paths) rootFile(root, path)
    const conflicts = [
      review.scaffold.descriptorPath,
      review.scaffold.rendererPath,
    ]
      .filter((path) => existsSync(rootFile(root, path)))
      .map((path) => `Source already exists: ${path}`)
    if (conflicts.length)
      return { status: "refused", reason: "conflict", conflicts }
    const result = await persistSliceSpec(spec, { root })
    await adapters.runCreationGate(spec.type, root)
    return { ...result, status: "created" }
  })
}
