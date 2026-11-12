import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import { z } from "zod"

export const RELEASE_TRANSITION_CHECKS = {
  "frozen-install": ["pnpm", "install", "--frozen-lockfile"],
  typecheck: ["pnpm", "typecheck"],
  lint: ["pnpm", "lint"],
  tests: ["pnpm", "test:run"],
  "slice-registration": ["pnpm", "slices:sync", "--check"],
  tokens: ["pnpm", "check:tokens"],
} as const

const CheckIdSchema = z.enum([
  "frozen-install",
  "typecheck",
  "lint",
  "tests",
  "slice-registration",
  "tokens",
])

const ImplementationSchema = z
  .object({
    path: z.string().min(1),
    marker: z.string().min(1),
  })
  .strict()

const ManualActionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    owner: z.string().min(1),
    entryPoint: z.string().min(1),
    precondition: z.string().min(1),
    successSignal: z.string().min(1),
    recoveryBoundary: z.string().min(1),
    transitionIds: z.array(z.string().min(1)),
    implementation: z.array(ImplementationSchema).min(1),
  })
  .strict()

const GitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const SEMVER_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

type ParsedSemVer = {
  core: [bigint, bigint, bigint]
  prerelease: string[] | null
}

function parseSemVerTag(tag: string): ParsedSemVer | null {
  const match = SEMVER_TAG.exec(tag)
  if (!match) return null
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4]?.split(".") ?? null,
  }
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index]! < right.core[index]!) return -1
    if (left.core[index]! > right.core[index]!) return 1
  }
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1
  if (right.prerelease === null) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart)
      const rightNumber = BigInt(rightPart)
      if (leftNumber < rightNumber) return -1
      if (leftNumber > rightNumber) return 1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

const SourceIdentitySchema = z
  .object({
    tag: z.string().min(1),
    tagObjectOid: GitOidSchema,
    starterCommitOid: GitOidSchema,
    engineCommitOid: GitOidSchema,
    generatedTreeDigest: Sha256Schema,
  })
  .strict()

const TransitionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9.]+(?:-[a-z0-9.]+)*$/),
    source: SourceIdentitySchema,
    targetTag: z.string().min(1),
    class: z.enum([
      "update",
      "guided-upgrade",
      "breaking-upgrade",
      "unsupported",
    ]),
    composable: z.boolean(),
    rollback: z
      .object({
        codeArtifact: z.enum(["supported", "unsupported"]),
        boundary: z.string().min(1),
      })
      .strict(),
    migrationIds: z.array(z.string().min(1)),
    configurationChanges: z.array(
      z
        .object({
          id: z.string().min(1),
          owner: z.string().min(1),
          instruction: z.string().min(1),
          successSignal: z.string().min(1),
          recoveryBoundary: z.string().min(1),
        })
        .strict()
    ),
    manualActionIds: z.array(z.string().min(1)),
    requirements: z.object({ membershipReconciliation: z.boolean() }).strict(),
    checks: z.array(CheckIdSchema).min(1),
  })
  .strict()

const TransitionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifact: z.literal("community"),
    manualActions: z.array(ManualActionSchema),
    transitions: z.array(TransitionSchema),
  })
  .strict()

const EngineMigrationSchema = z
  .object({
    id: z.string().min(1),
    transitionIds: z.array(z.string().min(1)),
    implementation: z
      .object({
        path: z.string().min(1),
        export: z.string().regex(/^[A-Za-z_$][\w$]*$/),
      })
      .strict(),
  })
  .passthrough()

const EngineManifestSchema = z
  .object({
    migrations: z.array(EngineMigrationSchema),
  })
  .passthrough()

export type ReleaseTransitionVerification = {
  artifact: "community"
  transition: z.infer<typeof TransitionSchema>
  declaredChecks: Array<{
    id: z.infer<typeof CheckIdSchema>
    command: string[]
  }>
}

export function verifyReleaseTransition(options: {
  repoRoot: string
  sourceTag: string
  targetTag: string
  manifestPath?: string
  engineManifestPath?: string
}): ReleaseTransitionVerification {
  const root = resolve(options.repoRoot)
  const manifest = TransitionManifestSchema.parse(
    JSON.parse(
      readFileSync(
        join(root, options.manifestPath ?? "starter.transitions.json"),
        "utf8"
      )
    )
  )
  const engineManifest = EngineManifestSchema.parse(
    JSON.parse(
      readFileSync(
        join(root, options.engineManifestPath ?? "engine.manifest.json"),
        "utf8"
      )
    )
  )
  const transition = manifest.transitions.find(
    (candidate) =>
      candidate.source.tag === options.sourceTag &&
      candidate.targetTag === options.targetTag
  )
  if (!transition) {
    throw new Error(
      `Unsupported transition: ${options.sourceTag} -> ${options.targetTag}.`
    )
  }
  const sourceVersion = parseSemVerTag(transition.source.tag)
  const targetVersion = parseSemVerTag(transition.targetTag)
  if (!sourceVersion || !targetVersion) {
    throw new Error("Transition tags must be strict v-prefixed SemVer.")
  }
  if (compareSemVer(sourceVersion, targetVersion) >= 0) {
    throw new Error(
      `Transition target ${transition.targetTag} must be greater than source ${transition.source.tag}.`
    )
  }
  const isPatch =
    sourceVersion.core[0] === targetVersion.core[0] &&
    sourceVersion.core[1] === targetVersion.core[1]
  if (
    isPatch &&
    transition.class !== "update" &&
    transition.class !== "unsupported"
  ) {
    throw new Error(
      `Patch transition ${transition.source.tag} -> ${transition.targetTag} must be an update or unsupported.`
    )
  }
  if (
    transition.requirements.membershipReconciliation &&
    !transition.manualActionIds.includes("membership-reconciliation")
  ) {
    throw new Error(
      `Transition ${transition.id} requires manual action membership-reconciliation.`
    )
  }
  if (
    transition.class === "update" &&
    (transition.migrationIds.length > 0 ||
      transition.configurationChanges.length > 0 ||
      transition.manualActionIds.length > 0 ||
      transition.requirements.membershipReconciliation)
  ) {
    throw new Error(
      `Update ${transition.id} cannot require migrations, configuration changes, or manual actions.`
    )
  }
  if (
    transition.class !== "breaking-upgrade" &&
    transition.rollback.codeArtifact !== "supported"
  ) {
    throw new Error(
      `Non-breaking transition ${transition.id} must support code-artifact rollback.`
    )
  }
  const transitionsById = new Map(
    manifest.transitions.map((candidate) => [candidate.id, candidate])
  )
  const actionsById = new Map(
    manifest.manualActions.map((action) => [action.id, action])
  )
  const migrationsById = new Map(
    engineManifest.migrations.map((migration) => [migration.id, migration])
  )
  const referencedMigrations = new Set<string>()
  for (const candidate of manifest.transitions) {
    for (const migrationId of candidate.migrationIds) {
      const migration = migrationsById.get(migrationId)
      if (!migration) {
        throw new Error(
          `Transition ${candidate.id} references unknown target migration ${migrationId}.`
        )
      }
      if (!migration.transitionIds.includes(candidate.id)) {
        throw new Error(
          `Transition ${candidate.id} references migration ${migrationId}, but the implementation omits the reverse reference.`
        )
      }
      referencedMigrations.add(migrationId)
    }
  }
  for (const migration of engineManifest.migrations) {
    if (!referencedMigrations.has(migration.id)) {
      throw new Error(
        `Target migration ${migration.id} is not referenced by a transition.`
      )
    }
    for (const transitionId of migration.transitionIds) {
      const owner = transitionsById.get(transitionId)
      if (!owner) {
        throw new Error(
          `Migration ${migration.id} references unknown transition ${transitionId}.`
        )
      }
      if (!owner.migrationIds.includes(migration.id)) {
        throw new Error(
          `Migration ${migration.id} names transition ${transitionId}, but the transition does not reference it.`
        )
      }
    }
    const implementationPath = join(root, migration.implementation.path)
    if (!existsSync(implementationPath)) {
      throw new Error(
        `Migration ${migration.id} implementation is missing: ${migration.implementation.path}.`
      )
    }
    const implementationSource = readFileSync(implementationPath, "utf8")
    const exportPattern = new RegExp(
      `export\\s+(?:const|let|var|function|class)\\s+${migration.implementation.export}\\b`
    )
    if (!exportPattern.test(implementationSource)) {
      throw new Error(
        `Migration ${migration.id} export ${migration.implementation.export} is missing from ${migration.implementation.path}.`
      )
    }
  }
  for (const candidate of manifest.transitions) {
    for (const actionId of candidate.manualActionIds) {
      const action = actionsById.get(actionId)
      if (!action) {
        throw new Error(
          `Transition ${candidate.id} references unknown manual action ${actionId}.`
        )
      }
      if (!action.transitionIds.includes(candidate.id)) {
        throw new Error(
          `Transition ${candidate.id} references manual action ${actionId}, but the implementation omits the reverse reference.`
        )
      }
    }
  }
  for (const action of manifest.manualActions) {
    for (const transitionId of action.transitionIds) {
      const owner = transitionsById.get(transitionId)
      if (!owner) {
        throw new Error(
          `Manual action ${action.id} references unknown transition ${transitionId}.`
        )
      }
      if (!owner.manualActionIds.includes(action.id)) {
        throw new Error(
          `Manual action ${action.id} names transition ${transitionId}, but the transition does not reference it.`
        )
      }
    }
    for (const implementation of action.implementation) {
      const path = join(root, implementation.path)
      if (!existsSync(path)) {
        throw new Error(
          `Manual action ${action.id} implementation is missing: ${implementation.path}.`
        )
      }
      if (!readFileSync(path, "utf8").includes(implementation.marker)) {
        throw new Error(
          `Manual action ${action.id} marker is missing from ${implementation.path}.`
        )
      }
    }
  }
  return {
    artifact: manifest.artifact,
    transition,
    declaredChecks: transition.checks.map((id) => ({
      id,
      command: [...RELEASE_TRANSITION_CHECKS[id]],
    })),
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

function requiredArgument(name: string): string {
  const value = argument(name)
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function main(): void {
  const result = verifyReleaseTransition({
    repoRoot: argument("--repo") ?? process.cwd(),
    sourceTag: requiredArgument("--source-tag"),
    targetTag: requiredArgument("--target-tag"),
    manifestPath: argument("--manifest"),
    engineManifestPath: argument("--engine-manifest"),
  })
  console.log(
    `Release transition verified: ${result.transition.source.tag} -> ${result.transition.targetTag} (${result.transition.class}; ${result.transition.checks.length} ordered checks).`
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
