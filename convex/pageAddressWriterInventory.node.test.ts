import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { beforeAll, describe, expect, test } from "vitest"
import ts from "typescript"

const publication = "convex/cms/publication.ts"
const snapshots = "convex/lib/publishing/snapshots.ts"
const guarded = new Set([
  ...[
    "initializeSuccessorPage",
    "saveLocaleDraft",
    "saveEditorDraft",
    "saveSharedDraft",
    "restoreSnapshotAsDraft",
    "discardLocaleDraft",
    "withdrawLocale",
    "transitionLifecycle",
    "publishLocale",
    "publishPreparedTargetLocale",
    "createTransitionTargetDraft",
    "prepareSnapshotMigrationPage",
  ].map((name) => `${publication}:${name}`),
  "convex/cms/settings.ts:bootstrapInstallation",
])
const guards = new Set([
  `${snapshots}:checkPageAddress`,
  `${snapshots}:allocatePageAddress`,
])
const barriers = new Set([
  `${snapshots}:assertLegacyPublicationWriterBlocked`,
  `${publication}:assertLegacySnapshotMigrationInstalled`,
])
// These operations release claims or only move blocked legacy draft content.
// Names are scoped: an identically named function elsewhere is not exempt.
const releaseOnly = new Set([
  ...[
    "deleteLocaleContent",
    "deleteTransitionTargetDraft",
    "deleteCancelledRetainedTargetDraft",
    "withdrawPreparedTargetLocale",
    "abortSnapshotMigrationPage",
  ].map((name) => `${publication}:${name}`),
  "convex/migrations.ts:hoistDraftContentToStaging",
])
const addressTables = new Set([
  "pages",
  "pageSharedDrafts",
  "pageLocaleDrafts",
  "pageLocalePublicationStates",
  "pagePublicationPageStates",
  "pageHistoricalLocaleRoutes",
  "siteSettings",
])
const addressFields = new Set([
  "slug",
  "parentId",
  "homePageId",
  "currentPath",
  "draftBaseSnapshotId",
  "lifecycleState",
  "fromPath",
  "releasedAt",
  "system",
])
type Facts = {
  id: string
  source: ts.SourceFile
  root: ts.Node
  writes: boolean
  calls: Set<string>
  resolveCall: (expression: ts.Expression) => string | undefined
}
function filename(file: string) {
  return path
    .relative(process.cwd(), path.resolve(file))
    .split(path.sep)
    .join("/")
}
// Same recursive production-file discovery as occurrenceUsage-writers.node.test.
function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === "_generated" ? [] : productionFiles(file)
    return entry.name.endsWith(".ts") &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".testFixtures.")
      ? [file]
      : []
  })
}
function inventory(source: ts.SourceFile, checker?: ts.TypeChecker): Facts[] {
  const file = filename(source.fileName)
  const imports = new Map<string, string>()
  const namespaces = new Map<string, string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.startsWith(".")) continue
    const target = filename(
      path.resolve(path.dirname(source.fileName), `${specifier}.ts`)
    )
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements)
        imports.set(
          binding.name.text,
          `${target}:${binding.propertyName?.text ?? binding.name.text}`
        )
    else if (bindings && ts.isNamespaceImport(bindings))
      namespaces.set(bindings.name.text, target)
  }
  const roots = source.statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name
      ? [{ name: statement.name.text, node: statement as ts.Node }]
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap((declaration) =>
            ts.isIdentifier(declaration.name) && declaration.initializer
              ? [
                  {
                    name: declaration.name.text,
                    node: declaration.initializer as ts.Node,
                  },
                ]
              : []
          )
        : []
  )
  const locals = new Set(roots.map((root) => root.name))
  function resolveCall(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression))
      return locals.has(expression.text)
        ? `${file}:${expression.text}`
        : (imports.get(expression.text) ?? `${file}:${expression.text}`)
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression)
    ) {
      const namespace = namespaces.get(expression.expression.text)
      if (namespace) return `${namespace}:${expression.name.text}`
    }
  }
  return roots.map((root) => {
    const bindings = new Map<string, ts.Expression>()
    function bind(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      )
        bindings.set(node.name.text, node.initializer)
      ts.forEachChild(node, bind)
    }
    bind(root.node)
    function ownsAddress(
      node: ts.Expression,
      seen = new Set<string>()
    ): boolean {
      if (
        ts.isAsExpression(node) ||
        ts.isParenthesizedExpression(node) ||
        ts.isSatisfiesExpression(node)
      )
        return ownsAddress(node.expression, seen)
      if (ts.isIdentifier(node)) {
        if (seen.has(node.text)) return false
        seen.add(node.text)
        const binding = bindings.get(node.text)
        return binding ? ownsAddress(binding, seen) : false
      }
      if (!ts.isObjectLiteralExpression(node)) return false
      return node.properties.some((property) =>
        ts.isSpreadAssignment(property)
          ? ownsAddress(property.expression, new Set(seen))
          : property.name &&
            addressFields.has(
              property.name
                .getText(source)
                .replaceAll('"', "")
                .replaceAll("'", "")
            )
      )
    }
    function mayWriteAddressTable(
      node: ts.CallExpression,
      method: string
    ): boolean {
      const first = node.arguments[0]
      if (!first) return true
      // insert(table, value), patch/replace(table, id, value).
      if (method === "insert" || node.arguments.length === 3)
        return !ts.isStringLiteral(first) || addressTables.has(first.text)
      // ID-only patch/replace: reuse the occurrence writer's typed-ID provenance.
      const type = checker?.getTypeAtLocation(first)
      const text =
        type &&
        checker!.typeToString(type, first, ts.TypeFormatFlags.NoTruncation)
      const tables =
        text && (text.includes("Id<") || text.includes("__tableName"))
          ? [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1])
          : []
      return (
        tables.length === 0 || tables.some((table) => addressTables.has(table))
      )
    }
    const item: Facts = {
      id: `${file}:${root.name}`,
      source,
      root: root.node,
      writes: false,
      calls: new Set(),
      resolveCall,
    }
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const call = resolveCall(node.expression)
        if (call) item.calls.add(call)
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ["insert", "patch", "replace"].includes(node.expression.name.text) &&
          mayWriteAddressTable(node, node.expression.name.text)
        ) {
          const value = node.arguments.at(-1)
          if (value && ownsAddress(value)) item.writes = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(root.node)
    return item
  })
}
function reaches(
  all: ReadonlyMap<string, Facts>,
  id: string,
  terminals: ReadonlySet<string>,
  seen = new Set<string>()
): boolean {
  if (terminals.has(id)) return true
  if (seen.has(id)) return false
  seen.add(id)
  return [...(all.get(id)?.calls ?? [])].some((call) =>
    reaches(all, call, terminals, new Set(seen))
  )
}
function violations(
  all: readonly Facts[],
  declared: ReadonlySet<string> = new Set()
) {
  const byId = new Map(all.map((facts) => [facts.id, facts]))
  const failed = new Set(
    [...declared].filter((id) => !byId.has(id) || !reaches(byId, id, guards))
  )
  for (const facts of all)
    if (
      facts.writes &&
      !releaseOnly.has(facts.id) &&
      !reaches(byId, facts.id, guards) &&
      !reaches(byId, facts.id, barriers)
    )
      failed.add(facts.id)
  return [...failed].sort()
}
function parse(file: string, source: string) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
}
function planted(source: string, file = "convex/addressControl.ts") {
  return inventory(parse(file, source))
}
function removeGuards(facts: Facts, all: readonly Facts[]): Facts {
  const byId = new Map(all.map((item) => [item.id, item]))
  const edits: { start: number; end: number }[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const id = facts.resolveCall(node.expression)
      if (id && reaches(byId, id, guards))
        edits.push({
          start: node.expression.getStart(facts.source),
          end: node.expression.end,
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(facts.root)
  expect(edits.length).toBeGreaterThan(0)
  let text = facts.source.text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text =
      text.slice(0, edit.start) + "omittedAddressGuard" + text.slice(edit.end)
  return inventory(parse(facts.source.fileName, text)).find(
    (item) => item.id === facts.id
  )!
}

describe("static address writer inventory", () => {
  let all: Facts[]
  beforeAll(() => {
    const root = process.cwd()
    const config = ts.readConfigFile(
      path.join(root, "tsconfig.json"),
      ts.sys.readFile
    )
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
    const files = productionFiles(path.join(root, "convex"))
    const program = ts.createProgram(files, {
      ...parsed.options,
      noEmit: true,
      incremental: false,
    })
    const checker = program.getTypeChecker()
    all = files.flatMap((file) =>
      inventory(program.getSourceFile(file)!, checker)
    )
  }, 60_000)
  test("every production address writer reaches its guard, release policy or disabled barrier", () => {
    expect(violations(all, guarded)).toEqual([])
  })
  test.each([...guarded])(
    "removing every reachable address guard rejects %s independently of write detection",
    (id) => {
      const original = all.find((facts) => facts.id === id)!
      const removed = removeGuards(original, all)
      expect(
        violations(
          all.map((facts) => (facts.id === id ? removed : facts)),
          guarded
        )
      ).toContain(id)
    }
  )
  test.each([
    "ctx.db.patch(id, {system: {parentId}})",
    "ctx.db.patch(id, {system: nextSystem})",
    "ctx.db.patch(id, {system})",
    'ctx.db.patch("pageSharedDrafts", id, {system: nextSystem})',
    "ctx.db.replace(id, {system: nextSystem})",
    'ctx.db.replace("pageSharedDrafts", id, {system})',
    'ctx.db.insert("pageLocaleDrafts", {slug: "held"})',
    'ctx.db.patch("pagePublicationPageStates", id, {lifecycleState: "active"})',
    'ctx.db.insert("pageHistoricalLocaleRoutes", {fromPath: "/held"})',
    'ctx.db.patch("siteSettings", id, {homePageId})',
    "const fields = {system: nextSystem}; ctx.db.patch(id, {...fields})",
  ])("unprotected address write is detected: %s", (write) => {
    const facts = planted(
      `export async function bypass(ctx, id, system, parentId, nextSystem, homePageId) { ${write} }`
    )
    expect(violations(facts)).toEqual(["convex/addressControl.ts:bypass"])
  })
  test("discovery includes a new nested production file and excludes generated/test files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "address-writers-"))
    try {
      mkdirSync(path.join(dir, "nested"))
      mkdirSync(path.join(dir, "_generated"))
      for (const name of [
        "nested/newWriter.ts",
        "ignored.test.ts",
        "ignored.testFixtures.ts",
        "_generated/ignored.ts",
      ])
        writeFileSync(
          path.join(dir, name),
          "export const bypass = mutation({handler: ctx => ctx.db.patch(id, {system: nextSystem})})"
        )
      const files = productionFiles(dir)
      expect(files).toEqual([path.join(dir, "nested/newWriter.ts")])
      expect(
        violations(
          files.flatMap((file) => planted(readFileSync(file, "utf8"), file))
        )
      ).toEqual([`${filename(files[0]!)}:bypass`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("identical function names, imported helpers and release exemptions are scoped by file", () => {
    const facts = [
      ...planted(
        'import {checkPageAddress as check} from "../lib/publishing/snapshots"; export async function create(ctx) { await check(ctx, {}); ctx.db.patch(id, {slug: "ok"}) }',
        "convex/cms/pages.ts"
      ),
      ...planted(
        'export function create(ctx) { ctx.db.patch(id, {slug: "bad"}) }',
        "convex/cms/redirects.ts"
      ),
      ...planted(
        'export function deleteLocaleContent(ctx) { ctx.db.patch(id, {slug: "bad"}) }',
        "convex/elsewhere.ts"
      ),
    ]
    expect(violations(facts)).toEqual([
      "convex/cms/redirects.ts:create",
      "convex/elsewhere.ts:deleteLocaleContent",
    ])
  })
  test("known non-address tables are excluded for literal-table and typed-ID write signatures", () => {
    const file = path.resolve("convex/addressControl.ts")
    const source = parse(
      file,
      `type Id<T extends string> = string & {__tableName: T};
      export function search(ctx: any, id: Id<"pageSearch">) {
        ctx.db.patch(id, {slug: "search projection"}); ctx.db.replace(id, {system: {parentId: "display"}});
        ctx.db.patch("pageSearch", id, {slug: "search projection"}); ctx.db.insert("pageSearch", {slug: "search projection"});
      }
      export function address(ctx: any, id: Id<"pages">) { ctx.db.patch(id, {slug: "held"}) }
      export function settings(ctx: any, id: Id<"siteSettings">) { ctx.db.patch(id, {siteName: "metadata"}) }
    `
    )
    const host = ts.createCompilerHost({ noLib: true })
    host.getSourceFile = (name) => (name === file ? source : undefined)
    const program = ts.createProgram(
      [file],
      { noLib: true, noResolve: true },
      host
    )
    expect(violations(inventory(source, program.getTypeChecker()))).toEqual([
      "convex/addressControl.ts:address",
    ])
  })
})
