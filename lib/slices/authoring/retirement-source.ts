import { readFile, readdir } from "node:fs/promises"
import { join, posix } from "node:path"
import ts from "typescript"

/** Same bounded seed/seeds filename convention as inventory-core-projection. */
const SEED_PATH = /(?:^|\/)(?:seed|seeds)(?:\/|\.|-)/i
const SETTINGS_PATH = "convex/cms/settings.ts"
const RELEASE_PATH = "scripts/starter/release.manifest.json"
const DISTRIBUTION_PATH = "scripts/starter/distribution.manifest.json"

export class SeedFreeRetirementError extends Error {
  constructor(message: string) {
    super(`Block Type deletion requires a verified seed-free setup. ${message}`)
    this.name = "SeedFreeRetirementError"
  }
}

function refuse(message: string): never {
  throw new SeedFreeRetirementError(message)
}

async function optionalSource(root: string, path: string) {
  try {
    return await readFile(join(root, path), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    refuse("A distribution source path is unknown or invalid.")
  }
  if (SEED_PATH.test(value)) refuse(`Seed source is declared at ${value}.`)
}

async function assertManifestInputs(root: string) {
  const [releaseSource, distributionSource, shipList] = await Promise.all([
    optionalSource(root, RELEASE_PATH),
    optionalSource(root, DISTRIBUTION_PATH),
    optionalSource(root, "scripts/starter/ship-list.json"),
  ])
  // These inputs are deliberately absent from a created customer application.
  // A partial/malformed engine input set must not silently become that state.
  if (
    releaseSource === null &&
    distributionSource === null &&
    shipList === null
  )
    return
  if (releaseSource === null || distributionSource === null)
    refuse("The engine distribution manifests are incomplete.")
  const release: unknown = JSON.parse(releaseSource)
  const distribution: unknown = JSON.parse(distributionSource)
  if (
    !record(release) ||
    release.schemaVersion !== 1 ||
    !Array.isArray(release.includePaths) ||
    !Array.isArray(release.excludePaths) ||
    !record(release.overlay) ||
    !Array.isArray(release.overlay.overrides) ||
    !record(distribution) ||
    distribution.schemaVersion !== 1 ||
    !Array.isArray(distribution.entries) ||
    !Array.isArray(distribution.runtimeOverlay)
  ) {
    refuse("The engine distribution source inventory is unknown.")
  }
  for (const path of [
    ...release.includePaths,
    ...release.excludePaths,
    ...release.overlay.overrides,
  ])
    assertPath(path)
  assertPath(release.overlay.sourcePath)
  for (const entry of distribution.entries) {
    if (!record(entry)) refuse("A distribution entry is invalid.")
    if (entry.origin !== "engine" && entry.origin !== "overlay")
      refuse("A distribution entry has an unknown source origin.")
    if (entry.disposition === "ship" || entry.disposition === "transform") {
      assertPath(entry.source)
      assertPath(entry.target)
    } else if (entry.disposition === "private") {
      // Private seed declarations are conservatively unsupported too.
      assertPath(entry.path)
    } else refuse("A distribution entry has an unknown disposition.")
  }
  for (const entry of distribution.runtimeOverlay) {
    if (!record(entry)) refuse("A runtime overlay entry is invalid.")
    assertPath(entry.path)
  }
}

async function assertNoSeedSources(root: string, directory: string) {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`
    if (SEED_PATH.test(`${path}${entry.isDirectory() ? "/" : ""}`))
      refuse(`Seed source is present at ${path}.`)
    if (entry.isSymbolicLink())
      refuse(`Source inventory is unknown at ${path}.`)
    if (entry.isDirectory()) await assertNoSeedSources(root, path)
  }
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  if (
    object.properties.some(
      (item) =>
        !ts.isPropertyAssignment(item) || ts.isComputedPropertyName(item.name)
    )
  )
    refuse("Bootstrap content uses an unsupported property or spread.")
  const matches = object.properties.filter(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === name
  )
  if (matches.length > 1) refuse("Bootstrap content repeats a property.")
  return matches[0]?.initializer
}

function assertEmptyLocaleContent(value: ts.Expression | undefined) {
  if (
    !value ||
    !ts.isObjectLiteralExpression(value) ||
    value.properties.length !== 1 ||
    !ts.isPropertyAssignment(value.properties[0]!) ||
    !ts.isComputedPropertyName(value.properties[0]!.name)
  ) {
    refuse("The bootstrap locale content constructor is unknown.")
  }
  const content = value.properties[0]!.initializer
  if (!ts.isObjectLiteralExpression(content) || content.properties.length !== 2)
    refuse("The bootstrap Home content constructor is unknown.")
  if (!property(content, "title"))
    refuse("The bootstrap Home title is unknown.")
  const slices = property(content, "slices")
  if (!slices || !ts.isArrayLiteralExpression(slices) || slices.elements.length)
    refuse("Bootstrap Home content is not a literal empty Slice array.")
}

/** The bounded bootstrap proof accepts only the actual imported owner binding. */
function occurrenceWriterBindings(file: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const clause = statement.importClause
    if (
      !clause ||
      clause.isTypeOnly ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      continue
    const specifier = statement.moduleSpecifier.text
    const target = specifier.startsWith("@/")
      ? specifier.slice(2)
      : specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(SETTINGS_PATH), specifier))
        : null
    if (target?.replace(/\.(?:js|ts)$/, "") !== "convex/lib/publishing/staging")
      continue
    for (const binding of clause.namedBindings.elements)
      if (
        !binding.isTypeOnly &&
        (binding.propertyName ?? binding.name).text === "occurrenceUsageWrites"
      )
        names.add(binding.name.text)
  }
  // A shadowed/local binding cannot establish the import's provenance. Refuse
  // conservatively rather than guessing which constructor a caller intended.
  const inspect = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isBindingElement(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      names.delete(node.name.text)
    ts.forEachChild(node, inspect)
  }
  inspect(file)
  return names
}

function assertEmptyBootstrap(source: string) {
  const file = ts.createSourceFile(
    SETTINGS_PATH,
    source,
    ts.ScriptTarget.Latest,
    true
  )
  if (
    (file as ts.SourceFile & { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics.length
  )
    refuse("The bootstrap source cannot be parsed.")
  const writerBindings = occurrenceWriterBindings(file)
  for (const name of ["bootstrapInstallation", "completeOnboarding"]) {
    const declarations: ts.VariableDeclaration[] = []
    const find = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name
      )
        declarations.push(node)
      ts.forEachChild(node, find)
    }
    find(file)
    if (declarations.length !== 1 || !declarations[0]!.initializer)
      refuse(`The ${name} bootstrap constructor is unknown.`)
    const pages: ts.CallExpression[] = []
    const successors: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "insert" &&
          (node.expression.expression.getText(file) === "ctx.db" ||
            (ts.isCallExpression(node.expression.expression) &&
              ts.isIdentifier(node.expression.expression.expression) &&
              writerBindings.has(node.expression.expression.expression.text) &&
              node.expression.expression.arguments.length === 1 &&
              node.expression.expression.arguments[0]!.getText(file) ===
                "ctx")) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === "pages"
        )
          pages.push(node)
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "initializeSuccessorPage"
        )
          successors.push(node)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(declarations[0]!.initializer)
    if (
      pages.length !== 1 ||
      !pages[0]!.arguments[1] ||
      !ts.isObjectLiteralExpression(pages[0]!.arguments[1])
    )
      refuse(`The ${name} Home creation path is unknown.`)
    const content = property(pages[0]!.arguments[1], "content")
    if (name === "bootstrapInstallation") {
      if (
        !content ||
        !ts.isObjectLiteralExpression(content) ||
        content.properties.length !== 0 ||
        successors.length !== 1
      )
        refuse("The snapshot bootstrap Home creation path is unknown.")
      assertEmptyLocaleContent(successors[0]!.arguments[3])
    } else {
      if (successors.length !== 0)
        refuse("The legacy bootstrap path is unknown.")
      assertEmptyLocaleContent(content)
    }
  }
}

/**
 * ADR-0045's bounded source contract: current bootstrap constructors plus
 * seed/seeds paths under convex/ and scripts/, including engine overlays.
 * This never executes seed code or claims to analyze arbitrary hidden helpers.
 */
export async function assertSeedFreeRetirement(root: string): Promise<void> {
  try {
    await assertManifestInputs(root)
    await assertNoSeedSources(root, "convex")
    // scripts/ is optional in customer applications; convex/settings is not.
    const scripts = await readdir(join(root, "scripts")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    })
    if (scripts !== null) await assertNoSeedSources(root, "scripts")
    const settings = await readFile(join(root, SETTINGS_PATH), "utf8")
    assertEmptyBootstrap(settings)
  } catch (error) {
    if (error instanceof SeedFreeRetirementError) throw error
    refuse("The bootstrap or distribution source inventory could not be read.")
  }
}
