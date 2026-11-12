import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import {
  verifyReleaseIdentity,
  type RecordedReleaseIdentity,
} from "./check-release-identity"
import { verifyReleaseProvenance } from "./check-release-provenance"
import { verifyReleaseTransition } from "./check-release-transition"

type CommandEvidence = {
  id: string
  command: string[]
  exitCode: 0
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error || result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      result.error?.message ||
      "unknown command error"
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`)
  }
  return result.stdout.trim()
}

function git(root: string, args: string[]): string {
  return run("git", args, { cwd: root })
}

function extractTaggedTree(
  repoRoot: string,
  commitOid: string,
  outputRoot: string
): void {
  mkdirSync(outputRoot, { recursive: true })
  const archive = join(outputRoot, "..", `${commitOid}.tar`)
  git(repoRoot, ["archive", "--format=tar", "--output", archive, commitOid])
  run("tar", ["-xf", archive, "-C", outputRoot], { cwd: repoRoot })
}

export type RehearsalEvidence = {
  schemaVersion: 1
  artifact: "community"
  source: RecordedReleaseIdentity & {
    generatedTreeDigest: string
    provenanceEntries: number
  }
  target: RecordedReleaseIdentity & {
    generatedTreeDigest: string
    provenanceEntries: number
  }
  transition: {
    id: string
    class: string
    composable: boolean
    rollback: { codeArtifact: string; boundary: string }
    membershipReconciliation: boolean
  }
  fork: {
    applicability: "clean"
    originOwnedByCustomer: true
    starterFetchOnly: true
    starterPushUrl: "DISABLED"
    sourceIsAncestorOfTarget: true
    sourceTreeOid: string
    mergeIndexTreeOid: string
    targetTreeOid: string
    mergeTreeMatchesTarget: true
  }
  checks: CommandEvidence[]
  deployment: {
    performed: false
    convexDeployKeyUsed: false
  }
}

function writeGitHubOutputs(evidence: RehearsalEvidence): void {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  appendFileSync(
    outputPath,
    [
      `source_tag_object_oid=${evidence.source.tagObjectOid}`,
      `source_starter_commit_oid=${evidence.source.starterCommitOid}`,
      `source_engine_commit_oid=${evidence.source.engineCommitOid}`,
      `source_tree_digest=${evidence.source.generatedTreeDigest}`,
      `target_tag_object_oid=${evidence.target.tagObjectOid}`,
      `target_starter_commit_oid=${evidence.target.starterCommitOid}`,
      `target_engine_commit_oid=${evidence.target.engineCommitOid}`,
      `target_tree_digest=${evidence.target.generatedTreeDigest}`,
      `transition_class=${evidence.transition.class}`,
      `fork_applicability=${evidence.fork.applicability}`,
      "",
    ].join("\n")
  )
}

export function rehearseReleaseTransition(options: {
  repoRoot: string
  sourceTag: string
  target: RecordedReleaseIdentity
  evidencePath: string
}): RehearsalEvidence {
  if (process.env.CONVEX_DEPLOY_KEY) {
    throw new Error(
      "Release transition rehearsal refuses CONVEX_DEPLOY_KEY; this workflow must never deploy."
    )
  }

  const repoRoot = resolve(options.repoRoot)
  const transitionVerification = verifyReleaseTransition({
    repoRoot,
    sourceTag: options.sourceTag,
    targetTag: options.target.tag,
  })
  const source = transitionVerification.transition.source
  const identity = verifyReleaseIdentity({
    repoRoot,
    source: {
      tag: source.tag,
      tagObjectOid: source.tagObjectOid,
      starterCommitOid: source.starterCommitOid,
      engineCommitOid: source.engineCommitOid,
    },
    target: options.target,
  })
  if (identity.source.generatedTreeDigest !== source.generatedTreeDigest) {
    throw new Error(
      `Recorded source tree digest ${source.generatedTreeDigest} does not match tagged source ${identity.source.generatedTreeDigest}.`
    )
  }

  const temporary = mkdtempSync(join(tmpdir(), "formulacms-release-rehearsal-"))
  const sourceRoot = join(temporary, "source")
  const targetRoot = join(temporary, "target")
  extractTaggedTree(repoRoot, identity.source.starterCommitOid, sourceRoot)
  extractTaggedTree(repoRoot, identity.target.starterCommitOid, targetRoot)
  const sourceProvenance = verifyReleaseProvenance({
    root: sourceRoot,
  })
  const targetProvenance = verifyReleaseProvenance({
    root: targetRoot,
  })

  const ownerOrigin = join(temporary, "owner.git")
  const forkRoot = join(temporary, "fork")
  run("git", ["init", "--bare", ownerOrigin], { cwd: temporary })
  run("git", ["clone", "--no-local", ownerOrigin, forkRoot], {
    cwd: temporary,
  })
  git(forkRoot, ["config", "user.name", "formulacms release rehearsal"])
  git(forkRoot, ["config", "user.email", "rehearsal@example.invalid"])
  git(forkRoot, ["remote", "add", "starter", repoRoot])
  git(forkRoot, ["remote", "set-url", "--push", "starter", "DISABLED"])
  git(forkRoot, [
    "fetch",
    "starter",
    `refs/tags/${identity.source.tag}:refs/tags/${identity.source.tag}`,
    `refs/tags/${identity.target.tag}:refs/tags/${identity.target.tag}`,
  ])
  git(forkRoot, [
    "switch",
    "--create",
    "main",
    identity.source.starterCommitOid,
  ])
  git(forkRoot, ["push", "--set-upstream", "origin", "main"])
  git(forkRoot, [
    "switch",
    "--create",
    `upgrade/${identity.target.tag.replace(/^v/, "")}`,
  ])
  git(forkRoot, [
    "merge",
    "--no-ff",
    "--no-commit",
    identity.target.starterCommitOid,
  ])
  const unresolved = git(forkRoot, ["diff", "--name-only", "--diff-filter=U"])
  if (unresolved) {
    throw new Error(`Clean-fork rehearsal has unresolved paths:\n${unresolved}`)
  }
  const sourceTreeOid = git(repoRoot, [
    "rev-parse",
    `${identity.source.starterCommitOid}^{tree}`,
  ])
  const targetTreeOid = git(repoRoot, [
    "rev-parse",
    `${identity.target.starterCommitOid}^{tree}`,
  ])
  const mergeIndexTreeOid = git(forkRoot, ["write-tree"])
  if (mergeIndexTreeOid !== targetTreeOid) {
    throw new Error(
      `Clean-fork merge tree ${mergeIndexTreeOid} does not equal target tree ${targetTreeOid}.`
    )
  }

  const checkEnvironment = { ...process.env }
  delete checkEnvironment.CONVEX_DEPLOY_KEY
  const checks: CommandEvidence[] = []
  for (const declared of transitionVerification.declaredChecks) {
    run(declared.command[0], declared.command.slice(1), {
      cwd: forkRoot,
      env: checkEnvironment,
    })
    checks.push({
      id: declared.id,
      command: declared.command,
      exitCode: 0,
    })
  }

  const transition = transitionVerification.transition
  const evidence: RehearsalEvidence = {
    schemaVersion: 1,
    artifact: transitionVerification.artifact,
    source: {
      ...identity.source,
      provenanceEntries: sourceProvenance.files,
    },
    target: {
      ...identity.target,
      provenanceEntries: targetProvenance.files,
    },
    transition: {
      id: transition.id,
      class: transition.class,
      composable: transition.composable,
      rollback: transition.rollback,
      membershipReconciliation:
        transition.requirements.membershipReconciliation,
    },
    fork: {
      applicability: "clean",
      originOwnedByCustomer: true,
      starterFetchOnly: true,
      starterPushUrl: "DISABLED",
      sourceIsAncestorOfTarget: true,
      sourceTreeOid,
      mergeIndexTreeOid,
      targetTreeOid,
      mergeTreeMatchesTarget: true,
    },
    checks,
    deployment: {
      performed: false,
      convexDeployKeyUsed: false,
    },
  }
  writeFileSync(
    resolve(options.evidencePath),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  return evidence
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

function requiredArgument(name: string): string {
  const value = argument(name)
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function main(): void {
  if (process.env.CONVEX_DEPLOY_KEY) {
    throw new Error(
      "Release transition rehearsal refuses CONVEX_DEPLOY_KEY; this workflow must never deploy."
    )
  }
  const target: RecordedReleaseIdentity = {
    tag: requiredArgument("--target-tag"),
    tagObjectOid: requiredArgument("--target-tag-object-oid"),
    starterCommitOid: requiredArgument("--target-starter-commit-oid"),
    engineCommitOid: requiredArgument("--target-engine-commit-oid"),
  }
  const result = rehearseReleaseTransition({
    repoRoot: argument("--repo") ?? process.cwd(),
    sourceTag: requiredArgument("--source-tag"),
    target,
    evidencePath: requiredArgument("--evidence"),
  })
  writeGitHubOutputs(result)
  console.log(
    `Release transition rehearsed: ${result.source.tag} -> ${result.target.tag}; ${result.checks.length} checks passed; fork applicability ${result.fork.applicability}.`
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
