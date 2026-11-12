/** Shared strict creator/app receipt format. No filesystem or authentication. */
export const RELEASE_ARTIFACT = "community"
export const SHA256 = /^[a-f0-9]{64}$/
export const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
export const RECIPE_VERSION = /^\d+\.\d+\.\d+$/
export const CREATOR_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
export const MAX_PROJECT_NAME = 214

export type ReleaseIdentity = {
  artifact: "community"
  recipeVersion: string
  engineSha: string
  generatedTreeDigest: string
  lockSha256: string
}

export type CreationTransform =
  | { id: "creation-exclusions"; version: "1"; removedPaths: string[] }
  | { id: "package-name"; version: "1"; projectName: string }

/**
 * The receipt names what was created, never where. It carries no source path,
 * host, user, time, or environment value, and it does not contain the app's
 * initial commit: a file cannot name the commit that contains it, so that
 * commit is recorded by whoever makes it, outside this file.
 */
export type CreationReceipt = {
  format: "formulacms.creation-receipt"
  schemaVersion: 1
  creator: { name: "create-formulacms-app"; version: string }
  blueprint: ReleaseIdentity & { releaseBaselineDigest: string }
  transforms: CreationTransform[]
  postCreateBaselineDigest: string
}

export function assertProjectName(projectName: string): void {
  if (
    projectName.length > MAX_PROJECT_NAME ||
    !PROJECT_NAME.test(projectName) ||
    projectName.includes("..")
  ) {
    throw new Error(
      `The project name must already be a normalized package name: ${JSON.stringify(projectName)}`
    )
  }
}

function fail(message: string): never {
  throw new Error(`Invalid creation receipt: ${message}`)
}

function exactObject(
  value: unknown,
  keys: string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.join("\0") !== expected.join("\0")) {
    fail(`${label} must have exactly the keys ${expected.join(", ")}`)
  }
  return value as Record<string, unknown>
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value))
    fail(`${label} is malformed`)
  return value
}

function relativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value) ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(
      `removed path ${JSON.stringify(value)} is not a contained relative path`
    )
  }
  return value
}

/** A strict parser: exact keys, typed values, the fixed transform order. */
export function parseCreationReceipt(text: string): CreationReceipt {
  const root = exactObject(
    JSON.parse(text),
    [
      "format",
      "schemaVersion",
      "creator",
      "blueprint",
      "transforms",
      "postCreateBaselineDigest",
    ],
    "receipt"
  )
  if (root.format !== "formulacms.creation-receipt") fail("unknown format")
  if (root.schemaVersion !== 1) fail("unknown schema version")
  const creator = exactObject(root.creator, ["name", "version"], "creator")
  if (creator.name !== "create-formulacms-app") fail("unknown creator")
  const blueprint = exactObject(
    root.blueprint,
    [
      "artifact",
      "recipeVersion",
      "engineSha",
      "generatedTreeDigest",
      "lockSha256",
      "releaseBaselineDigest",
    ],
    "blueprint"
  )
  if (blueprint.artifact !== RELEASE_ARTIFACT) fail("foreign artifact")
  if (!Array.isArray(root.transforms) || root.transforms.length !== 2) {
    fail("transforms must be creation-exclusions then package-name")
  }
  const exclusions = exactObject(
    root.transforms[0],
    ["id", "version", "removedPaths"],
    "transform 1"
  )
  if (exclusions.id !== "creation-exclusions" || exclusions.version !== "1") {
    fail("transform 1 must be creation-exclusions version 1")
  }
  if (!Array.isArray(exclusions.removedPaths))
    fail("removedPaths must be a list")
  const removedPaths = exclusions.removedPaths.map(relativePath)
  const sorted = [...removedPaths].sort()
  if (
    new Set(removedPaths).size !== removedPaths.length ||
    sorted.some((entry, index) => entry !== removedPaths[index])
  ) {
    fail("removedPaths must be sorted and unique")
  }
  const naming = exactObject(
    root.transforms[1],
    ["id", "version", "projectName"],
    "transform 2"
  )
  if (naming.id !== "package-name" || naming.version !== "1") {
    fail("transform 2 must be package-name version 1")
  }
  if (typeof naming.projectName !== "string")
    fail("projectName must be a string")
  try {
    assertProjectName(naming.projectName)
  } catch {
    fail("projectName is not a normalized package name")
  }

  return {
    format: "formulacms.creation-receipt",
    schemaVersion: 1,
    creator: {
      name: "create-formulacms-app",
      version: matching(creator.version, CREATOR_VERSION, "creator version"),
    },
    blueprint: {
      artifact: RELEASE_ARTIFACT,
      recipeVersion: matching(
        blueprint.recipeVersion,
        RECIPE_VERSION,
        "recipe version"
      ),
      engineSha: matching(blueprint.engineSha, GIT_OID, "engine identity"),
      generatedTreeDigest: matching(
        blueprint.generatedTreeDigest,
        SHA256,
        "tree digest"
      ),
      lockSha256: matching(blueprint.lockSha256, SHA256, "lock digest"),
      releaseBaselineDigest: matching(
        blueprint.releaseBaselineDigest,
        SHA256,
        "release baseline digest"
      ),
    },
    transforms: [
      { id: "creation-exclusions", version: "1", removedPaths },
      { id: "package-name", version: "1", projectName: naming.projectName },
    ],
    postCreateBaselineDigest: matching(
      root.postCreateBaselineDigest,
      SHA256,
      "post-create baseline digest"
    ),
  }
}
