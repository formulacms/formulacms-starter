import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { expect, test } from "vitest"

// Follow the AST pattern in lib/rich-text/static-render.boundary.node.test.ts.
// This checks our local import boundary, not package internals or tree shaking.
const root = process.cwd()
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/
const forbidden = new Set(
  [
    "convex/_generated/server",
    "convex/schema",
    "convex/lib/publishing/staging",
  ].map((path) => resolve(root, path))
)

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return sourceExtension.test(path) && !path.endsWith(".d.ts") ? [path] : []
  })
}

function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = []
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      if (
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
      ) continue
      specifiers.push(statement.moduleSpecifier.text)
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.exportClause
      if (
        !clause ||
        !ts.isNamedExports(clause) ||
        clause.elements.length === 0 ||
        clause.elements.some((element) => !element.isTypeOnly)
      ) specifiers.push(statement.moduleSpecifier.text)
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) specifiers.push(statement.moduleReference.expression.text)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) specifiers.push(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(statement)
  }
  return specifiers
}

function localFile(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? resolve(root, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : undefined
  if (!base) return undefined
  const stems = /\.[cm]?jsx?$/.test(base)
    ? [base.replace(/\.[cm]?jsx?$/, ""), base]
    : [base]
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
  return stems.flatMap((stem) => [
    stem,
    ...extensions.map((extension) => `${stem}${extension}`),
    ...extensions.map((extension) => join(stem, `index${extension}`)),
  ]).find((candidate) => {
    try {
      return sourceExtension.test(candidate) && statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

test("client entry points cannot reach Convex server, schema, or staging at runtime", () => {
  const sources = new Map<string, ts.SourceFile>()
  const edges = new Map<string, string[]>()
  function source(file: string): ts.SourceFile {
    let parsed = sources.get(file)
    if (!parsed) {
      parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
      sources.set(file, parsed)
    }
    return parsed
  }
  function dependencies(file: string): string[] {
    let targets = edges.get(file)
    if (!targets) {
      targets = runtimeSpecifiers(source(file))
        .map((specifier) => localFile(file, specifier))
        .filter((target): target is string => target !== undefined)
      edges.set(file, targets)
    }
    return targets
  }
  const clients = ["app", "components", "lib"].flatMap((directory) =>
    sourceFiles(resolve(root, directory))
  ).filter((file) => {
    const first = source(file).statements[0]
    return first && ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) && first.expression.text === "use client"
  })
  expect(clients.length).toBeGreaterThan(0)
  const violations: string[] = []
  for (const entry of clients) {
    const pending = [[entry]]
    const seen = new Set<string>()
    while (pending.length) {
      const chain = pending.pop()!
      const file = chain[chain.length - 1]
      if (seen.has(file)) continue
      seen.add(file)
      if (forbidden.has(file.replace(sourceExtension, ""))) {
        violations.push(chain.map((path) => relative(root, path)).join(" -> "))
        continue
      }
      for (const target of dependencies(file)) pending.push([...chain, target])
    }
  }
  expect(violations, "Client runtime import chains into server-only code").toEqual([])
})
