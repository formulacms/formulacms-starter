import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const RELEASE_LOCKFILE = "starter.release-lock.json"
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
const SEMVER_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const RELEASE_ARTIFACT = "community" as const
export type ReleaseArtifact = typeof RELEASE_ARTIFACT

export type RecordedReleaseIdentity = {
  tag: string
  tagObjectOid: string
  starterCommitOid: string
  engineCommitOid: string
}

export type ReleaseIdentityVerification = {
  artifact: ReleaseArtifact
  source: RecordedReleaseIdentity & { generatedTreeDigest: string }
  target: RecordedReleaseIdentity & { generatedTreeDigest: string }
}

type ReleaseLock = {
  schemaVersion: 1
  artifact: ReleaseArtifact
  engineSha: string
  generatedTreeDigest: string
  generatedTreeDigestExcludes: string[]
  inputMode?: unknown
}

type VerifyReleaseIdentityOptions = {
  repoRoot: string
  source: RecordedReleaseIdentity
  target: RecordedReleaseIdentity
}

function gitTextResult(repoRoot: string, args: string[]) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function gitBufferResult(repoRoot: string, args: string[]) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function gitText(repoRoot: string, args: string[]): string {
  const result = gitTextResult(repoRoot, args)
  if (result.error || result.status !== 0) {
    const detail =
      result.stderr.trim() || result.error?.message || "unknown Git error"
    throw new Error(`git ${args.join(" ")} failed: ${detail}`)
  }
  return result.stdout.trim()
}

function gitBuffer(repoRoot: string, args: string[]): Buffer {
  const result = gitBufferResult(repoRoot, args)
  if (result.error || result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim()
    const detail = stderr || result.error?.message || "unknown Git error"
    throw new Error(`git ${args.join(" ")} failed: ${detail}`)
  }
  return result.stdout
}

function assertGitOid(value: string, label: string): void {
  if (!GIT_OID.test(value)) {
    throw new Error(`${label} must be a full lowercase Git object ID.`)
  }
}

function assertSemVerTag(tag: string, label: string): void {
  if (!SEMVER_TAG.test(tag)) {
    throw new Error(`${label} ${tag} is not a strict v-prefixed SemVer tag.`)
  }
}

function readAnnotatedIdentity(
  repoRoot: string,
  label: "Source" | "Target",
  recorded: RecordedReleaseIdentity
): RecordedReleaseIdentity {
  assertSemVerTag(recorded.tag, label)
  assertGitOid(recorded.tagObjectOid, `${label} tag object ID`)
  assertGitOid(recorded.starterCommitOid, `${label} starter commit ID`)
  assertGitOid(recorded.engineCommitOid, `${label} engine commit ID`)

  const ref = `refs/tags/${recorded.tag}`
  const refResult = gitTextResult(repoRoot, ["rev-parse", "--verify", ref])
  if (refResult.error || refResult.status !== 0) {
    throw new Error(`${label} release tag ${recorded.tag} is absent.`)
  }
  const actualTagObjectOid = refResult.stdout.trim()
  const objectType = gitText(repoRoot, ["cat-file", "-t", ref])
  if (objectType !== "tag") {
    throw new Error(
      `${label} release tag ${recorded.tag} must be annotated; found ${objectType}.`
    )
  }
  if (actualTagObjectOid !== recorded.tagObjectOid) {
    throw new Error(
      `${label} release tag ${recorded.tag} moved or its tag object mismatched: expected ${recorded.tagObjectOid}, actual ${actualTagObjectOid}.`
    )
  }

  const actualStarterCommitOid = gitText(repoRoot, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ])
  if (actualStarterCommitOid !== recorded.starterCommitOid) {
    throw new Error(
      `${label} release tag ${recorded.tag} peeled to ${actualStarterCommitOid}, expected starter commit ${recorded.starterCommitOid}.`
    )
  }

  return {
    ...recorded,
    tagObjectOid: actualTagObjectOid,
    starterCommitOid: actualStarterCommitOid,
  }
}

function readReleaseLock(
  repoRoot: string,
  label: "Source" | "Target",
  identity: RecordedReleaseIdentity
): ReleaseLock {
  let value: unknown
  try {
    value = JSON.parse(
      gitText(repoRoot, [
        "show",
        `${identity.starterCommitOid}:${RELEASE_LOCKFILE}`,
      ])
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} release lock could not be read: ${detail}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} release lock must be a JSON object.`)
  }
  const lock = value as Partial<ReleaseLock>
  if (lock.inputMode === "working-tree") {
    throw new Error(
      `${label} release lock is working-tree diagnostic evidence.`
    )
  }
  if (lock.inputMode !== undefined) {
    throw new Error(`${label} release lock has an unknown inputMode.`)
  }
  if (lock.schemaVersion !== 1) {
    throw new Error(`${label} release lock must use schemaVersion 1.`)
  }
  if (lock.artifact !== RELEASE_ARTIFACT) {
    throw new Error(
      `${label} release lock artifact must be the legacy-compatible ${RELEASE_ARTIFACT} identity.`
    )
  }
  if (lock.engineSha !== identity.engineCommitOid) {
    throw new Error(
      `${label} release lock engineSha ${String(lock.engineSha)} does not match declared canonical engine commit ${identity.engineCommitOid}.`
    )
  }
  if (!SHA256.test(lock.generatedTreeDigest ?? "")) {
    throw new Error(
      `${label} release lock generatedTreeDigest must be a lowercase SHA-256 digest.`
    )
  }
  if (
    !Array.isArray(lock.generatedTreeDigestExcludes) ||
    lock.generatedTreeDigestExcludes.length !== 1 ||
    lock.generatedTreeDigestExcludes[0] !== RELEASE_LOCKFILE
  ) {
    throw new Error(
      `${label} release lock must exclude only ${RELEASE_LOCKFILE} from its generated-tree digest.`
    )
  }
  return lock as ReleaseLock
}

function gitTreeDigest(repoRoot: string, commitOid: string): string {
  const entries = gitBuffer(repoRoot, ["ls-tree", "-r", "-z", commitOid])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
  const hash = createHash("sha256")

  for (const entry of entries) {
    const separator = entry.indexOf("\t")
    if (separator < 0) throw new Error(`Malformed Git tree entry: ${entry}`)
    const [mode, type, objectOid] = entry.slice(0, separator).split(" ")
    const path = entry.slice(separator + 1)
    if (path === RELEASE_LOCKFILE) continue
    if (mode === "120000") {
      throw new Error(`Release trees cannot contain symlinks: ${path}`)
    }
    if (type !== "blob" || !objectOid) {
      throw new Error(`Release trees can contain files only: ${path}`)
    }
    const bytes = gitBuffer(repoRoot, ["cat-file", "blob", objectOid])
    hash.update(path)
    hash.update("\0")
    hash.update(createHash("sha256").update(bytes).digest("hex"))
    hash.update("\0")
  }

  return hash.digest("hex")
}

function verifyLockedTree(
  repoRoot: string,
  label: "Source" | "Target",
  identity: RecordedReleaseIdentity
): string {
  const lock = readReleaseLock(repoRoot, label, identity)
  const actual = gitTreeDigest(repoRoot, identity.starterCommitOid)
  if (actual !== lock.generatedTreeDigest) {
    throw new Error(
      `${label} tagged starter tree was tampered or its lock is stale: lock ${lock.generatedTreeDigest}, actual ${actual}.`
    )
  }
  return actual
}

export function verifyReleaseIdentity(
  options: VerifyReleaseIdentityOptions
): ReleaseIdentityVerification {
  const repoRoot = realpathSync(resolve(options.repoRoot))
  const topLevel = gitText(repoRoot, ["rev-parse", "--show-toplevel"])
  if (realpathSync(resolve(topLevel)) !== repoRoot) {
    throw new Error(`Release repository must be its Git root: ${repoRoot}.`)
  }
  const dirty = gitText(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
  if (dirty) {
    throw new Error(`Release repository must be clean. Dirty paths:\n${dirty}`)
  }
  const source = readAnnotatedIdentity(repoRoot, "Source", options.source)
  const target = readAnnotatedIdentity(repoRoot, "Target", options.target)
  const head = gitText(repoRoot, ["rev-parse", "--verify", "HEAD"])
  if (target.starterCommitOid !== head) {
    throw new Error(
      `Target starter commit ${target.starterCommitOid} does not equal repository HEAD ${head}.`
    )
  }
  if (source.starterCommitOid === target.starterCommitOid) {
    throw new Error("Source and target must be distinct starter commits.")
  }
  const ancestry = gitTextResult(repoRoot, [
    "merge-base",
    "--is-ancestor",
    source.starterCommitOid,
    target.starterCommitOid,
  ])
  if (ancestry.error || (ancestry.status !== 0 && ancestry.status !== 1)) {
    const detail =
      ancestry.stderr.trim() || ancestry.error?.message || "unknown Git error"
    throw new Error(`Could not verify release ancestry: ${detail}`)
  }
  if (ancestry.status === 1) {
    throw new Error(
      `Source starter commit ${source.starterCommitOid} is not an ancestor of target starter commit ${target.starterCommitOid}.`
    )
  }

  const sourceDigest = verifyLockedTree(
    repoRoot,
    "Source",
    source
  )
  const targetDigest = verifyLockedTree(
    repoRoot,
    "Target",
    target
  )

  return {
    artifact: RELEASE_ARTIFACT,
    source: { ...source, generatedTreeDigest: sourceDigest },
    target: { ...target, generatedTreeDigest: targetDigest },
  }
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

function requiredArgument(name: string): string {
  const value = argument(name)
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function recordedIdentity(
  prefix: "source" | "target"
): RecordedReleaseIdentity {
  return {
    tag: requiredArgument(`--${prefix}-tag`),
    tagObjectOid: requiredArgument(`--${prefix}-tag-object-oid`),
    starterCommitOid: requiredArgument(`--${prefix}-starter-commit-oid`),
    engineCommitOid: requiredArgument(`--${prefix}-engine-commit-oid`),
  }
}

function main(): void {
  if (hasArgument("--artifact")) {
    throw new Error(
      "--artifact is no longer supported; FormulaCMS has one release identity."
    )
  }
  const result = verifyReleaseIdentity({
    repoRoot: argument("--repo") ?? process.cwd(),
    source: recordedIdentity("source"),
    target: recordedIdentity("target"),
  })
  console.log(
    `Release identities verified: ${result.source.tag} (${result.source.tagObjectOid} -> starter ${result.source.starterCommitOid}, engine ${result.source.engineCommitOid}, tree ${result.source.generatedTreeDigest}) -> ${result.target.tag} (${result.target.tagObjectOid} -> starter ${result.target.starterCommitOid}, engine ${result.target.engineCommitOid}, tree ${result.target.generatedTreeDigest}).`
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
