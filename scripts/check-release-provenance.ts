import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const RELEASE_PROVENANCE_FILE = "starter.provenance.json"
export const RELEASE_LOCK_FILE = "starter.release-lock.json"
export const RELEASE_ARTIFACT = "community" as const

export const RELEASE_PIPELINE_TRANSFORMS = {
  "starter-ci-filter": "1",
  "slice-curation": "1",
  "generated-api-reconciliation": "1",
  "generated-env-reconciliation": "1",
  "package-overlay": "1",
  "content-type-selection": "1",
  "community-surface-selection": "1",
  "content-type-registration": "1",
  "starter-selection": "1",
} as const

export type ReleasePipelineTransformId =
  keyof typeof RELEASE_PIPELINE_TRANSFORMS

export type ReleaseProvenanceTransform = {
  id: string
  version: string
  sourceSha256?: string
  targetSha256?: string
}

export type ReleaseProvenanceFile = {
  target: string
  source: string
  origin: "engine" | "overlay" | "transform"
  disposition: "runtime" | "ship" | "transform"
  kind: "runtime" | "governed" | "generated"
  sourceSha256?: string
  outputSha256: string
  transform?: ReleaseProvenanceTransform
  deterministicTransforms?: ReleaseProvenanceTransform[]
}

export const RELEASE_PROVENANCE_EXCEPTIONS = [
  {
    id: "self-referential-release-metadata",
    rule: "exact-output-paths",
    paths: [RELEASE_PROVENANCE_FILE, RELEASE_LOCK_FILE],
  },
  {
    id: "owner-installed-agent-tooling",
    rule: "fork-only-not-release-output",
    paths: [],
  },
  {
    id: "intentionally-excluded-files",
    rule: "release-manifest-source-selection",
    paths: [],
  },
] as const

export type ReleaseProvenance = {
  schemaVersion: 2
  artifact: typeof RELEASE_ARTIFACT
  release: {
    engineSha: string | null
    releaseManifestSha256: string
    distributionManifestSha256: string
    generatorDigests: Array<{ path: string; sha256: string }>
    declaredTransforms: Array<{ id: string; version: string }>
  }
  exceptions: Array<{ id: string; rule: string; paths: string[] }>
  files: ReleaseProvenanceFile[]
}

const SHA256 = /^[a-f0-9]{64}$/
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const TRANSFORM_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TRANSFORM_VERSION = /^[1-9]\d*$/

function posix(path: string): string {
  return path.split(sep).join("/")
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  function walk(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = join(directory, entry)
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        throw new Error(`Release provenance cannot verify symlink: ${absolute}`)
      }
      if (stat.isDirectory()) walk(absolute)
      else if (stat.isFile()) files.push(posix(relative(root, absolute)))
    }
  }
  walk(root)
  return files.sort()
}

function treeDigest(root: string, excludedPaths: string[]): string {
  const excluded = new Set(excludedPaths)
  const hash = createHash("sha256")
  for (const path of walkFiles(root).filter((path) => !excluded.has(path))) {
    hash.update(path)
    hash.update("\0")
    hash.update(sha256(readFileSync(join(root, path))))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function readProvenance(root: string): ReleaseProvenance {
  const parsed = JSON.parse(
    readFileSync(join(root, RELEASE_PROVENANCE_FILE), "utf8")
  ) as Partial<ReleaseProvenance>
  if (parsed.schemaVersion !== 2) {
    throw new Error(
      `Unsupported starter provenance schema: ${String(parsed.schemaVersion)}`
    )
  }
  if (parsed.artifact !== RELEASE_ARTIFACT) {
    throw new Error("Starter provenance has an invalid artifact.")
  }
  if (!parsed.release || !Array.isArray(parsed.files)) {
    throw new Error("Starter provenance is missing release metadata or files.")
  }
  if (!Array.isArray(parsed.exceptions)) {
    throw new Error("Starter provenance is missing reviewed exceptions.")
  }
  return parsed as ReleaseProvenance
}

function assertSafeExactPath(path: string, label: string): void {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("*") ||
    path.includes("?") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`${label} must be an exact safe path: ${path}`)
  }
}

function assertReviewedExceptions(provenance: ReleaseProvenance): Set<string> {
  if (
    JSON.stringify(provenance.exceptions) !==
    JSON.stringify(RELEASE_PROVENANCE_EXCEPTIONS)
  ) {
    throw new Error(
      "Starter provenance has unknown, reordered, wildcard, or altered exception rules."
    )
  }
  const outputExceptions = new Set<string>()
  for (const exception of provenance.exceptions) {
    for (const path of exception.paths) {
      assertSafeExactPath(path, `Provenance exception ${exception.id}`)
      if (exception.rule === "exact-output-paths") outputExceptions.add(path)
    }
  }
  return outputExceptions
}

function assertReleaseDigests(
  provenance: ReleaseProvenance,
  engineRoot: string | undefined,
  allowNullEngineSha: boolean,
  manifestPaths: {
    release: string
    distribution: string
  } | null
): void {
  if (
    provenance.release.engineSha === null
      ? !allowNullEngineSha
      : !GIT_OID.test(provenance.release.engineSha)
  ) {
    throw new Error("Starter provenance engine SHA is invalid.")
  }
  for (const [label, digest] of [
    ["release manifest", provenance.release.releaseManifestSha256],
    ["distribution manifest", provenance.release.distributionManifestSha256],
  ] as const) {
    if (!SHA256.test(digest)) {
      throw new Error(`Starter provenance ${label} digest is invalid.`)
    }
  }
  if (!Array.isArray(provenance.release.generatorDigests)) {
    throw new Error("Starter provenance generator digests are missing.")
  }
  if (provenance.release.generatorDigests.length === 0) {
    throw new Error("Starter provenance generator digests cannot be empty.")
  }
  const generatorPaths = new Set<string>()
  for (const entry of provenance.release.generatorDigests) {
    assertSafeExactPath(entry.path, "Generator digest path")
    if (generatorPaths.has(entry.path)) {
      throw new Error(`Duplicate generator digest path: ${entry.path}.`)
    }
    generatorPaths.add(entry.path)
    if (!SHA256.test(entry.sha256)) {
      throw new Error(`Generator digest is invalid for ${entry.path}.`)
    }
    if (engineRoot) {
      const actual = sha256(readFileSync(join(engineRoot, entry.path)))
      if (actual !== entry.sha256) {
        throw new Error(`Generator source hash is stale for ${entry.path}.`)
      }
    }
  }
  if (engineRoot && manifestPaths) {
    const manifestDigest = sha256(
      readFileSync(join(engineRoot, manifestPaths.release))
    )
    const distributionDigest = sha256(
      readFileSync(join(engineRoot, manifestPaths.distribution))
    )
    if (manifestDigest !== provenance.release.releaseManifestSha256) {
      throw new Error("Starter provenance release manifest hash is stale.")
    }
    if (distributionDigest !== provenance.release.distributionManifestSha256) {
      throw new Error("Starter provenance distribution manifest hash is stale.")
    }
  }
}

function sourcePathFor(
  file: ReleaseProvenanceFile,
  engineRoot: string
): string | null {
  if (file.kind === "generated") return null
  if (file.origin === "engine") return join(engineRoot, file.source)
  if (file.origin === "overlay") {
    return join(engineRoot, "scripts/starter/overlay", file.source)
  }
  if (file.origin === "transform") return join(engineRoot, file.source)
  return null
}

function transformKey(transform: ReleaseProvenanceTransform): string {
  return `${transform.id}\0${transform.version}`
}

function assertTransform(
  transform: ReleaseProvenanceTransform,
  label: string
): void {
  if (
    !transform ||
    typeof transform !== "object" ||
    !TRANSFORM_NAME.test(transform.id) ||
    !TRANSFORM_VERSION.test(transform.version)
  ) {
    throw new Error(`${label} has an invalid id or version.`)
  }
  for (const [name, digest] of [
    ["sourceSha256", transform.sourceSha256],
    ["targetSha256", transform.targetSha256],
  ] as const) {
    if (digest !== undefined && !SHA256.test(digest)) {
      throw new Error(`${label} has an invalid ${name}.`)
    }
  }
}

function assertTransforms(provenance: ReleaseProvenance): void {
  if (!Array.isArray(provenance.release.declaredTransforms)) {
    throw new Error("Starter provenance declared transforms are missing.")
  }
  const declared = new Set<string>()
  for (const transform of provenance.release.declaredTransforms) {
    assertTransform(transform, "Declared transform")
    const key = transformKey(transform)
    if (declared.has(key)) {
      throw new Error(
        `Duplicate declared transform ${transform.id}@${transform.version}.`
      )
    }
    declared.add(key)
  }
  const required = new Set(
    Object.entries(RELEASE_PIPELINE_TRANSFORMS).map(([id, version]) =>
      transformKey({ id, version })
    )
  )
  for (const file of provenance.files) {
    const transforms = [
      ...(file.transform ? [file.transform] : []),
      ...(file.deterministicTransforms ?? []),
    ]
    for (const transform of transforms) {
      assertTransform(transform, `Transform at ${file.target}`)
      const key = transformKey(transform)
      required.add(key)
      if (!declared.has(key)) {
        throw new Error(
          `Undeclared deterministic transform ${transform.id}@${transform.version} at ${file.target}.`
        )
      }
    }
  }
  const omitted = [...required].filter((key) => !declared.has(key))
  if (omitted.length > 0) {
    throw new Error(
      `Starter provenance omitted required transform declaration(s): ${omitted
        .map((key) => key.replace("\0", "@"))
        .join(", ")}.`
    )
  }
  const unknown = [...declared].filter((key) => !required.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `Starter provenance has unused transform declaration(s): ${unknown
        .map((key) => key.replace("\0", "@"))
        .join(", ")}.`
    )
  }
}

function assertFileShape(file: ReleaseProvenanceFile): void {
  assertSafeExactPath(file.target, "Provenance target")
  if (!["engine", "overlay", "transform"].includes(file.origin)) {
    throw new Error(`Invalid provenance origin at ${file.target}.`)
  }
  if (!["runtime", "ship", "transform"].includes(file.disposition)) {
    throw new Error(`Invalid provenance disposition at ${file.target}.`)
  }
  if (!["runtime", "governed", "generated"].includes(file.kind)) {
    throw new Error(`Invalid provenance kind at ${file.target}.`)
  }
  if (file.kind === "generated") {
    if (
      file.origin !== "transform" ||
      file.disposition !== "transform" ||
      file.sourceSha256 !== undefined ||
      !Array.isArray(file.deterministicTransforms) ||
      file.deterministicTransforms.length === 0
    ) {
      throw new Error(`Invalid generated provenance entry at ${file.target}.`)
    }
    return
  }
  assertSafeExactPath(file.source, `Provenance source at ${file.target}`)
  if (file.origin === "transform") {
    if (
      file.kind !== "governed" ||
      file.disposition !== "transform" ||
      !file.transform
    ) {
      throw new Error(`Invalid governed transform entry at ${file.target}.`)
    }
  }
}

function assertReleaseLock(root: string, provenance: ReleaseProvenance): void {
  const lock = JSON.parse(
    readFileSync(join(root, RELEASE_LOCK_FILE), "utf8")
  ) as {
    artifact?: string
    engineSha?: string | null
    releaseManifestDigest?: string
    distributionManifestDigest?: string
    generatedTreeDigest?: string
    generatedTreeDigestExcludes?: string[]
  }
  if (lock.artifact !== provenance.artifact) {
    throw new Error("Release lock artifact does not match provenance.")
  }
  if (lock.engineSha !== provenance.release.engineSha) {
    throw new Error("Release lock engine SHA does not match provenance.")
  }
  if (
    lock.releaseManifestDigest !== provenance.release.releaseManifestSha256 ||
    lock.distributionManifestDigest !==
      provenance.release.distributionManifestSha256
  ) {
    throw new Error("Release lock manifest digests do not match provenance.")
  }
  if (!Array.isArray(lock.generatedTreeDigestExcludes)) {
    throw new Error("Release lock generated-tree exclusions are missing.")
  }
  if (
    JSON.stringify(lock.generatedTreeDigestExcludes) !==
    JSON.stringify([RELEASE_LOCK_FILE])
  ) {
    throw new Error(
      "Release lock generated-tree exclusions must name only the release lock."
    )
  }
  const actual = treeDigest(root, lock.generatedTreeDigestExcludes)
  if (actual !== lock.generatedTreeDigest) {
    throw new Error("Release lock generated-tree digest does not match output.")
  }
}

export function verifyReleaseProvenance(options: {
  root: string
  engineRoot?: string
  releaseManifestPath?: string
  distributionManifestPath?: string
  allowNullEngineSha?: boolean
}): { artifact: typeof RELEASE_ARTIFACT; files: number } {
  const root = resolve(options.root)
  const engineRoot = options.engineRoot
    ? resolve(options.engineRoot)
    : undefined
  let manifestPaths: { release: string; distribution: string } | null = null
  if (engineRoot) {
    if (!options.releaseManifestPath || !options.distributionManifestPath) {
      throw new Error(
        "Engine verification requires explicit release and distribution manifest paths."
      )
    }
    assertSafeExactPath(options.releaseManifestPath, "Release manifest path")
    assertSafeExactPath(
      options.distributionManifestPath,
      "Distribution manifest path"
    )
    manifestPaths = {
      release: options.releaseManifestPath,
      distribution: options.distributionManifestPath,
    }
  } else if (options.releaseManifestPath || options.distributionManifestPath) {
    throw new Error("Manifest paths require an engine root.")
  }
  const provenance = readProvenance(root)
  const outputExceptions = assertReviewedExceptions(provenance)
  assertReleaseDigests(
    provenance,
    engineRoot,
    options.allowNullEngineSha === true,
    manifestPaths
  )
  assertTransforms(provenance)

  const byTarget = new Map<string, ReleaseProvenanceFile>()
  for (const file of provenance.files) {
    assertFileShape(file)
    if (byTarget.has(file.target)) {
      throw new Error(`Duplicate provenance target: ${file.target}`)
    }
    byTarget.set(file.target, file)
  }
  const actualFiles = walkFiles(root).filter(
    (path) => !outputExceptions.has(path)
  )
  const unknown = actualFiles.filter((path) => !byTarget.has(path))
  if (unknown.length > 0) {
    throw new Error(`Unknown emitted path(s): ${unknown.join(", ")}`)
  }
  const missing = [...byTarget.keys()].filter(
    (path) => !existsSync(join(root, path))
  )
  if (missing.length > 0) {
    throw new Error(`Missing emitted path(s): ${missing.join(", ")}`)
  }

  for (const file of provenance.files) {
    const actualOutput = sha256(readFileSync(join(root, file.target)))
    if (!SHA256.test(file.outputSha256) || actualOutput !== file.outputSha256) {
      throw new Error(`Output hash mismatch at ${file.target}.`)
    }
    if (file.kind !== "generated" && !SHA256.test(file.sourceSha256 ?? "")) {
      throw new Error(`Source hash is missing or invalid at ${file.target}.`)
    }
    if (engineRoot && file.kind !== "generated") {
      const sourcePath = sourcePathFor(file, engineRoot)
      if (!sourcePath) {
        throw new Error(`Cannot resolve provenance source for ${file.target}.`)
      }
      const actualSource = sha256(readFileSync(sourcePath))
      if (actualSource !== file.sourceSha256) {
        throw new Error(`Source hash is stale at ${file.target}.`)
      }
    }
  }
  assertReleaseLock(root, provenance)
  return { artifact: provenance.artifact, files: provenance.files.length }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`)
  }
  return value
}

function hasArgument(name: string): boolean {
  return process.argv.some(
    (value) => value === name || value.startsWith(`${name}=`)
  )
}

function assertCleanReleaseLockInputMode(root: string): void {
  const lock = JSON.parse(
    readFileSync(join(root, RELEASE_LOCK_FILE), "utf8")
  ) as unknown
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return

  const inputMode = (lock as { inputMode?: unknown }).inputMode
  if (inputMode === "working-tree") {
    throw new Error(
      "Release provenance command refuses a working-tree diagnostic release lock."
    )
  }
  if (inputMode !== undefined) {
    throw new Error(
      "Release provenance command found an unknown release lock inputMode."
    )
  }
}

function main(): void {
  if (hasArgument("--artifact")) {
    throw new Error(
      "--artifact is no longer supported; FormulaCMS has one release identity."
    )
  }
  const root = argument("--root") ?? process.cwd()
  assertCleanReleaseLockInputMode(root)
  const result = verifyReleaseProvenance({
    root,
    engineRoot: argument("--engine-root"),
    releaseManifestPath: argument("--release-manifest"),
    distributionManifestPath: argument("--distribution-manifest"),
  })
  console.log(
    `Verified ${result.files} ${result.artifact} starter provenance entries.`
  )
}

const directEntry = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false
if (directEntry) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
