import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs"
import { isAbsolute, join } from "node:path"
import {
  applyClassOperationBatch,
  hashTweakSource,
  type ClassReplaceOperation,
} from "../visual-tweak/class-operations"
import { assertAuthoringPaths } from "./paths"
import type { SliceRetirementUsage } from "./service"

const MAX_SOURCE_BYTES = 1_048_576
const MAX_OPERATIONS = 128
const SHA256 = /^[a-f0-9]{64}$/
const TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value
}

function exactKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

/** Finite data only. No source text, module path, executable or custom writer is admitted. */
export function parseRendererOperationsJson(
  json: string
): ClassReplaceOperation[] {
  if (typeof json !== "string" || Buffer.byteLength(json) > MAX_SOURCE_BYTES)
    throw new Error("A bounded renderer operations array is required.")
  const values: unknown = JSON.parse(json)
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > MAX_OPERATIONS
  )
    throw new Error("A bounded renderer operations array is required.")
  for (const value of values) {
    if (
      !exactKeys(value, [
        "kind",
        "target",
        "tag",
        "scope",
        "group",
        "expected",
        "next",
        "sourceHash",
        "postcondition",
      ]) ||
      value.kind !== "class.replace" ||
      !["target", "tag", "scope", "group", "next"].every(
        (key) =>
          typeof value[key] === "string" &&
          value[key].length > 0 &&
          value[key].length <= 512
      ) ||
      !(
        value.expected === null ||
        (typeof value.expected === "string" && value.expected.length <= 512)
      ) ||
      !matches(SHA256, value.sourceHash) ||
      !exactKeys(value.postcondition, ["kind", "value"]) ||
      value.postcondition.kind !== "class-token" ||
      value.postcondition.value !== value.next
    )
      throw new Error(
        "Only complete deterministic class operations are supported."
      )
  }
  // The pure batch validates the supported axis, token, scope, location and tag.
  return values as ClassReplaceOperation[]
}

export type ReviewedRendererRequest = {
  expectedType: string
  expectedSourceRevision: string
  operationsJson: string
}

/** The controller must qualify the physical created app and ordinary owner session.
 * Revalidation must reread current owner/backend contracts, config, finite local
 * catalog and authoritative usage. These trusted adapters are not an auth bypass.
 * Existing renderer code alone executes in the normal installed gate; this service
 * never accepts or evaluates arbitrary candidate code. External writers must stay
 * quiescent during the synchronous commit and trusted gate/rollback interval. */
export type RendererAdapters = {
  revalidateCurrentState: (
    type: string,
    root: string
  ) => Promise<SliceRetirementUsage>
  runRendererGate: (type: string, root: string) => Promise<void>
}

type Snapshot = { path: string; bytes: Buffer; identity: Stats }
type SourceFrame = {
  snapshots: Snapshot[]
  revision: string
  rootIdentity: Stats
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.nlink === 1 && b.nlink === 1
}

function sourceFrame(type: string, root: string): SourceFrame {
  const camel = type.replace(/-([a-z])/g, (_, char: string) =>
    char.toUpperCase()
  )
  const paths = [
    `convex/lib/slices/${camel}.ts`,
    `components/slices/${type}.tsx`,
    "lib/slices/builder.ts",
    "lib/slices/slices.manifest.json",
  ].map((path) => join(root, path))
  assertAuthoringPaths(root, paths)
  const rootIdentity = lstatSync(realpathSync(root))
  const snapshots = paths.map((path) => {
    const identity = lstatSync(path)
    if (identity.size > MAX_SOURCE_BYTES)
      throw new Error("Renderer source is too large.")
    const bytes = readFileSync(path)
    const after = lstatSync(path)
    if (
      !sameIdentity(identity, after) ||
      bytes.length !== identity.size ||
      identity.size !== after.size ||
      identity.mtimeMs !== after.mtimeMs
    )
      throw new Error("Renderer source changed during capture.")
    return { path, bytes, identity }
  })
  assertAuthoringPaths(root, paths)
  return {
    snapshots,
    rootIdentity,
    revision: createHash("sha256")
      .update(
        JSON.stringify([
          type,
          ...snapshots.map(({ bytes }) => bytes.toString("hex")),
        ])
      )
      .digest("hex"),
  }
}

function frameIsCurrent(
  type: string,
  root: string,
  frame: SourceFrame
): boolean {
  try {
    const current = sourceFrame(type, root)
    return (
      current.revision === frame.revision &&
      current.rootIdentity.dev === frame.rootIdentity.dev &&
      current.rootIdentity.ino === frame.rootIdentity.ino &&
      current.snapshots.every((snapshot, index) =>
        sameIdentity(snapshot.identity, frame.snapshots[index].identity)
      )
    )
  } catch {
    return false
  }
}

function prepare(request: ReviewedRendererRequest, root: string) {
  // Capture immutable request data before the first await.
  const { expectedType: type, expectedSourceRevision, operationsJson } = request
  if (
    !isAbsolute(root) ||
    !matches(TYPE, type) ||
    !matches(SHA256, expectedSourceRevision)
  )
    throw new Error(
      "A complete reviewed Type and source revision are required."
    )
  const operations = parseRendererOperationsJson(operationsJson)
  let frame: SourceFrame
  try {
    frame = sourceFrame(type, root)
  } catch {
    return null
  }
  if (frame.revision !== expectedSourceRevision) return null
  const renderer = frame.snapshots[1]
  const source = renderer.bytes.toString("utf8")
  if (!Buffer.from(source).equals(renderer.bytes)) return null
  const batch = applyClassOperationBatch({
    source,
    file: `components/slices/${type}.tsx`,
    operations,
  })
  return { type, frame, source, batch }
}

const stale = { status: "refused", reason: "stale_source" } as const

function reviewResult(
  prepared: NonNullable<ReturnType<typeof prepare>>,
  usage: SliceRetirementUsage
) {
  if (!prepared.batch.ok)
    return { status: "refused", reason: prepared.batch.code } as const
  return {
    status: "reviewed" as const,
    type: prepared.type,
    expectedSourceRevision: prepared.frame.revision,
    sourceHash: hashTweakSource(prepared.source),
    rendererPath: `components/slices/${prepared.type}.tsx`,
    currentRendererSource: prepared.source,
    pendingRendererSource: prepared.batch.source,
    diffs: prepared.batch.diffs,
    applied: prepared.batch.applied,
    knownAuthoritativeUsage: usage,
    scope: {
      ownership: "shared-renderer-source" as const,
      affects:
        "All usages that resolve this shared renderer when its source is installed. Already published Pages can change visually without another Page publication.",
      usageQualification:
        "Authoritative counts cover retained Type references, not a proven count of affected renderings. Alternative designs may resolve a different renderer.",
      unknownDownstreamExposure: true,
      publicationChanged: false,
    },
  }
}

/** Zero canonical writes: inspect actual source, deterministic pending diff and current usage. */
export async function reviewSliceRendererUpdate(
  request: ReviewedRendererRequest,
  adapters: Pick<RendererAdapters, "revalidateCurrentState">,
  root: string
) {
  const prepared = prepare(request, root)
  if (!prepared) return stale
  if (!prepared.batch.ok)
    return { status: "refused", reason: prepared.batch.code } as const
  const usage = await adapters.revalidateCurrentState(prepared.type, root)
  if (!frameIsCurrent(prepared.type, root, prepared.frame)) return stale
  return reviewResult(prepared, usage)
}

function writeExisting(root: string, snapshot: Snapshot, bytes: Buffer) {
  assertAuthoringPaths(root, [snapshot.path])
  const file = openSync(
    snapshot.path,
    constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    if (!sameIdentity(fstatSync(file), snapshot.identity))
      throw new Error("The physical renderer changed.")
    writeFileSync(file, bytes)
    ftruncateSync(file, bytes.length)
  } finally {
    closeSync(file)
  }
}

/** One guarded class-only write; descriptor, builder and manifest bytes are never regenerated. */
export async function updateReviewedSliceRenderer(
  request: ReviewedRendererRequest,
  adapters: RendererAdapters,
  root: string
) {
  const prepared = prepare(request, root)
  if (!prepared) return stale
  if (!prepared.batch.ok)
    return { status: "refused", reason: prepared.batch.code } as const
  const usage = await adapters.revalidateCurrentState(prepared.type, root)
  // No await occurs between this final complete source/physical check and write.
  if (!frameIsCurrent(prepared.type, root, prepared.frame)) return stale
  const renderer = prepared.frame.snapshots[1]
  const candidate = Buffer.from(prepared.batch.source)
  let gateStarted = false
  let sourceRevision: string
  try {
    writeExisting(root, renderer, candidate)
    gateStarted = true
    await adapters.runRendererGate(prepared.type, root)
    const checked = sourceFrame(prepared.type, root)
    if (
      checked.rootIdentity.dev !== prepared.frame.rootIdentity.dev ||
      checked.rootIdentity.ino !== prepared.frame.rootIdentity.ino ||
      checked.snapshots.some(
        (snapshot, index) =>
          !sameIdentity(
            snapshot.identity,
            prepared.frame.snapshots[index].identity
          ) ||
          !snapshot.bytes.equals(
            index === 1 ? candidate : prepared.frame.snapshots[index].bytes
          )
      )
    )
      throw new Error("Source changed during the renderer gate.")
    sourceRevision = checked.revision
  } catch (error) {
    try {
      const physicalRoot = lstatSync(realpathSync(root))
      if (
        physicalRoot.dev !== prepared.frame.rootIdentity.dev ||
        physicalRoot.ino !== prepared.frame.rootIdentity.ino
      )
        throw new Error(
          "The physical application root changed before rollback."
        )
      assertAuthoringPaths(
        root,
        prepared.frame.snapshots.map(({ path }) => path)
      )
      if (gateStarted && !readFileSync(renderer.path).equals(candidate))
        throw new Error(
          "Renderer changed during the gate; rollback refused over current work."
        )
      writeExisting(root, renderer, renderer.bytes)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Renderer update and rollback failed."
      )
    }
    throw error
  }
  const report = reviewResult(prepared, usage)
  if (report.status !== "reviewed")
    throw new Error("The deterministic renderer report is unavailable.")
  const { currentRendererSource, pendingRendererSource, ...details } = report
  return {
    ...details,
    status: "updated" as const,
    previousRendererSource: currentRendererSource,
    currentRendererSource: pendingRendererSource,
    sourceHash: hashTweakSource(prepared.batch.source),
    sourceRevision,
  }
}
