import { isOccurrenceUsageWriterCall } from "../../../sourceOwnership"
import { readdirSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const occurrenceTables = new Set([
  "pages",
  "pageStaging",
  "pageLocaleDrafts",
  "pageSharedDrafts",
  "pageLocalePublicationCandidates",
  "pagePublishedSnapshots",
  "pagePublicationSliceReferences",
  "pagePublicationPageStates",
  "pageLocalePublicationStates",
])
// The existing tags migration changes only the named metadata field.
// All occurrence content and lifecycle writes must use the shared wrapper.
const metadataOnlyExceptions: Readonly<Record<string, readonly string[]>> = {
  "convex/cms/tags.ts:backfill": ["tags"],
}

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

function findings(source: ts.SourceFile, checker?: ts.TypeChecker): string[] {
  const result: string[] = []
  const aliases = new Set(["db", "innerDb", "rawDb"])
  const warn = (node: ts.Node, reason: string) =>
    result.push(
      `${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${reason}`
    )
  function rawReceiver(node: ts.Expression): boolean {
    if (ts.isCallExpression(node)) {
      if (!checker) return true
      const value = checker.getTypeAtLocation(node)
      return (
        !!(value.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ||
        (!!checker.getPropertyOfType(value, "normalizeId") &&
          !!checker.getPropertyOfType(value, "query"))
      )
    }
    return (
      (ts.isPropertyAccessExpression(node) &&
        ["db", "innerDb", "rawDb"].includes(node.name.text)) ||
      (ts.isIdentifier(node) && aliases.has(node.text))
    )
  }
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      rawReceiver(node.initializer)
    )
      aliases.add(node.name.text)
    if (ts.isCallExpression(node)) {
      const access = node.expression
      let method: string | undefined
      let receiver: ts.Expression | undefined
      if (ts.isPropertyAccessExpression(access)) {
        method = access.name.text
        receiver = access.expression
      }
      if (ts.isElementAccessExpression(access)) {
        receiver = access.expression
        method =
          access.argumentExpression &&
          ts.isStringLiteral(access.argumentExpression)
            ? access.argumentExpression.text
            : undefined
        if (rawReceiver(receiver) && !method)
          warn(node, "unclassified dynamic raw database operation")
      }
      if (
        receiver &&
        rawReceiver(receiver) &&
        !(
          checker &&
          isOccurrenceUsageWriterCall(receiver, checker, process.cwd())
        ) &&
        method &&
        ["insert", "patch", "replace", "delete"].includes(method)
      ) {
        const first = node.arguments[0]
        let owner: string | undefined
        for (
          let parent: ts.Node | undefined = node;
          parent;
          parent = parent.parent
        )
          if (
            ts.isVariableDeclaration(parent) &&
            ts.isIdentifier(parent.name) &&
            parent.initializer &&
            ts.isCallExpression(parent.initializer)
          ) {
            owner = parent.name.text
            break
          }
        const relative = path.relative(process.cwd(), source.fileName)
        const allowed = owner && metadataOnlyExceptions[`${relative}:${owner}`]
        const patch = node.arguments[node.arguments.length - 1]
        const safeMetadata =
          method === "patch" &&
          allowed &&
          patch &&
          ts.isObjectLiteralExpression(patch) &&
          patch.properties.every(
            (property) =>
              ts.isPropertyAssignment(property) &&
              allowed.includes(property.name.getText(source))
          )
        if (!first) warn(node, "raw database write without table/ID provenance")
        else if (ts.isStringLiteral(first)) {
          if (occurrenceTables.has(first.text) && !safeMetadata)
            warn(node, `raw ${method} on ${first.text}`)
        } else {
          const type = checker?.getTypeAtLocation(first)
          const text =
            type &&
            checker!.typeToString(type, first, ts.TypeFormatFlags.NoTruncation)
          const names =
            text && (text.includes("Id<") || text.includes("__tableName"))
              ? [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1])
              : []
          if (names.some((name) => occurrenceTables.has(name)) && !safeMetadata)
            warn(node, `raw ${method} on ${text}`)
          else if (names.length === 0)
            warn(
              node,
              `unclassified raw ${method} ID: ${text ?? first.getText(source)}`
            )
        }
      }
      // A migration's returned partial is a hidden library patch. Require
      // explicit wrapped DML rather than silently exempting that consumer.
      if (
        ts.isPropertyAccessExpression(access) &&
        access.name.text === "define"
      ) {
        const spec = node.arguments[0]
        if (spec && ts.isObjectLiteralExpression(spec)) {
          const table = spec.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === "table"
          )
          if (
            table &&
            ts.isPropertyAssignment(table) &&
            ts.isStringLiteral(table.initializer) &&
            occurrenceTables.has(table.initializer.text)
          ) {
            const callback = spec.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(source) === "migrateOne"
            )
            if (callback && ts.isPropertyAssignment(callback) && checker) {
              const signature = checker.getSignaturesOfType(
                checker.getTypeAtLocation(callback.initializer),
                ts.SignatureKind.Call
              )[0]
              const returns =
                signature &&
                checker.typeToString(
                  checker.getReturnTypeOfSignature(signature)
                )
              if (returns && returns !== "void" && returns !== "Promise<void>")
                warn(
                  callback,
                  "occurrence migration must not return an implicit raw patch"
                )
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

describe("occurrence source writer boundary", () => {
  test("production has no raw source DML outside the shared occurrenceUsage writer", () => {
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
    const violations = files.flatMap((file) =>
      findings(program.getSourceFile(file)!, checker)
    )
    expect(violations).toEqual([])
  }, 60_000)
  test("planted raw writes fail the guard, including aliases and computed writes", () => {
    const source = ts.createSourceFile(
      "planted.ts",
      `
      async function planted(ctx) {
        await ctx.db.insert("pages", {});
        const db = ctx.db;
        await db["replace"]("pageStaging", "id", {});
        await ctx.db.patch("pageLocaleDrafts", "id", {});
      }
    `,
      ts.ScriptTarget.Latest,
      true
    )
    const rejected = findings(source)
    expect(rejected).toHaveLength(3)
    expect(rejected.every((failure) => failure.includes("raw"))).toBe(true)
  })
  test("a local wrapper look-alike is refused; unrelated literal-table writes are unaffected", () => {
    const source = ts.createSourceFile(
      "allowed.ts",
      `
      function occurrenceUsageWrites(ctx) { return ctx.db }
      async function allowed(ctx) {
        await occurrenceUsageWrites(ctx).insert("pages", {});
        await ctx.db.insert("pageRevisions", {});
      }
    `,
      ts.ScriptTarget.Latest,
      true
    )
    expect(findings(source)).toEqual([
      expect.stringContaining("raw insert on pages"),
    ])
  })
  test.each([
    { operation: "patch", fields: "tags: []", safe: true },
    { operation: "patch", fields: "tags: [], content: {}", safe: false },
    { operation: "replace", fields: "tags: []", safe: false },
  ])(
    "table-first $operation metadata exception: $fields",
    ({ operation, fields, safe }) => {
      const source = ts.createSourceFile(
        path.join(process.cwd(), "convex/cms/tags.ts"),
        `const backfill = migration({ migrateOne: async (ctx, id) => { await ctx.db.${operation}("pages", id, { ${fields} }); } })`,
        ts.ScriptTarget.Latest,
        true
      )
      expect(findings(source)).toEqual(
        safe ? [] : [expect.stringContaining(`raw ${operation} on pages`)]
      )
    }
  )
})
