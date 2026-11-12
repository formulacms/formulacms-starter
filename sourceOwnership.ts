/**
 * Test-only source-ownership scanner. It parses production TypeScript with the
 * compiler API and reports, per file and enclosing function, every call of a
 * named function and every `.kind` comparison against a named literal. Source
 * ownership tests compare the result with a checked-in inventory keyed by
 * `file#function`, never by line number, so unrelated edits do not churn it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"

const SKIPPED_DIRECTORIES = new Set(["node_modules", "_generated", ".next"])

function isProductionSource(path: string): boolean {
  return (
    /\.(ts|tsx)$/.test(path) &&
    !/\.test\.(ts|tsx)$/.test(path) &&
    !path.endsWith(".d.ts")
  )
}

function listSources(root: string, entry: string): string[] {
  const path = join(root, entry)
  if (statSync(path).isFile()) return isProductionSource(path) ? [entry] : []
  const files: string[] = []
  for (const name of readdirSync(path)) {
    if (SKIPPED_DIRECTORIES.has(name) || name.startsWith(".")) continue
    files.push(...listSources(root, join(entry, name)))
  }
  return files
}

let cachedSourceProgram: {
  key: string
  program: ts.Program
  checker: ts.TypeChecker
} | null = null

function sourceProgram(
  root: string,
  files: string[],
  compilerOptions: ts.CompilerOptions
): { program: ts.Program; checker: ts.TypeChecker } {
  const key = JSON.stringify([root, compilerOptions, [...files].sort()])
  if (cachedSourceProgram?.key !== key) {
    const program = ts.createProgram(files, compilerOptions)
    cachedSourceProgram = { key, program, checker: program.getTypeChecker() }
  }
  return cachedSourceProgram
}

/**
 * The innermost named function declaration, otherwise the module-level
 * variable the expression belongs to (`export const x = mutation({...})`).
 */
function enclosingName(node: ts.Node): string {
  let moduleVariable: string | null = null
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text
    }
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      ts.isVariableStatement(current.parent.parent) &&
      ts.isSourceFile(current.parent.parent.parent)
    ) {
      moduleVariable = current.name.text
    }
  }
  return moduleVariable ?? "<module>"
}

/** Trust the exported owner binding, including an import alias, never its spelling. */
export function isOccurrenceUsageWriterCall(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
  root: string
): boolean {
  if (!ts.isCallExpression(receiver) || !ts.isIdentifier(receiver.expression))
    return false
  const symbol = checker.getSymbolAtLocation(receiver.expression)
  if (!symbol) return false
  const exported =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol
  return (
    exported.getName() === "occurrenceUsageWrites" &&
    !!exported.declarations?.some(
      (declaration) =>
        resolve(declaration.getSourceFile().fileName) ===
          resolve(root, "convex/lib/publishing/staging.ts") &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
    )
  )
}

export type SourceUse = `${string}#${string}#${string}`

/**
 * Sorted `file#function#name` entries (one per use) for every call of
 * `callees` and every `x.kind === "<literal>"` / `!==` with a literal in
 * `kindLiterals`, recorded as `.kind`.
 */
export function scanSourceUses(options: {
  root: string
  entries: readonly string[]
  callees: readonly string[]
  kindLiterals: readonly string[]
}): SourceUse[] {
  const callees = new Set(options.callees)
  const kinds = new Set(options.kindLiterals)
  const uses: SourceUse[] = []
  const files = options.entries.flatMap((entry) =>
    listSources(options.root, entry)
  )
  for (const file of files) {
    const path = join(options.root, file)
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const name = relative(options.root, path)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null
        if (calleeName && callees.has(calleeName)) {
          uses.push(`${name}#${enclosingName(node)}#${calleeName}`)
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        const [access, literal] = ts.isStringLiteral(node.right)
          ? [node.left, node.right]
          : [node.right, node.left]
        if (
          ts.isPropertyAccessExpression(access) &&
          access.name.text === "kind" &&
          ts.isStringLiteral(literal) &&
          kinds.has(literal.text)
        ) {
          uses.push(`${name}#${enclosingName(node)}#.kind`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return uses.sort()
}

/**
 * Sorted `file#function` entries for every `.withIndex("<indexName>", ...)`
 * call in production sources.
 */
export function scanIndexReaders(options: {
  root: string
  entries: readonly string[]
  indexName: string
}): string[] {
  const readers: string[] = []
  const files = options.entries.flatMap((entry) =>
    listSources(options.root, entry)
  )
  for (const file of files) {
    const path = join(options.root, file)
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const name = relative(options.root, path)
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "withIndex" &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text === options.indexName
      ) {
        readers.push(`${name}#${enclosingName(node)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return readers.sort()
}

/**
 * Sorted `file#function#operation#table` entries for every `ctx.db.insert`,
 * `patch`, `replace` or `delete` under `entries` whose table is in `tables`.
 * The table comes from a string-literal first argument or, for an id argument,
 * from its `Id<"table">` type, so the scan needs the type checker.
 */
export function scanTableWriters(options: {
  root: string
  entries: readonly string[]
  tables: readonly string[]
}): string[] {
  const tables = new Set(options.tables)
  const config = ts.readConfigFile(
    join(options.root, "tsconfig.json"),
    ts.sys.readFile
  )
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    options.root
  )
  const files = options.entries
    .flatMap((entry) => listSources(options.root, entry))
    .map((file) => join(options.root, file))
  const { program, checker } = sourceProgram(
    options.root,
    files,
    parsed.options
  )
  const scanned = new Set(files)
  const writers = new Set<string>()
  for (const source of program.getSourceFiles()) {
    if (!scanned.has(source.fileName)) continue
    const name = relative(options.root, source.fileName)
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["insert", "patch", "replace", "delete"].includes(
          node.expression.name.text
        ) &&
        ((ts.isPropertyAccessExpression(node.expression.expression) &&
          node.expression.expression.name.text === "db") ||
          isOccurrenceUsageWriterCall(
            node.expression.expression,
            checker,
            options.root
          )) &&
        node.arguments[0] !== undefined
      ) {
        const first = node.arguments[0]
        const table = ts.isStringLiteralLike(first)
          ? first.text
          : /(?:Id<"|__tableName: ")(\w+)"/.exec(
              checker.typeToString(checker.getTypeAtLocation(first))
            )?.[1]
        if (table && tables.has(table)) {
          writers.add(
            `${name}#${enclosingName(node)}#${node.expression.name.text}#${table}`
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...writers].sort()
}

/**
 * Sorted `file#function#operation#table#field` entries for database writes
 * whose value contains an object property named `field`. The property search
 * descends through conditional and spread expressions, so inline forms such
 * as `...(path === null ? { currentPath: undefined } : { currentPath: path })`
 * cannot evade a source-ownership inventory.
 */
export function scanTableFieldWriters(options: {
  root: string
  entries: readonly string[]
  table: string
  field: string
}): string[] {
  const config = ts.readConfigFile(
    join(options.root, "tsconfig.json"),
    ts.sys.readFile
  )
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    options.root
  )
  const files = options.entries
    .flatMap((entry) => listSources(options.root, entry))
    .map((file) => join(options.root, file))
  const { program, checker } = sourceProgram(
    options.root,
    files,
    parsed.options
  )
  const scanned = new Set(files)
  const writers = new Set<string>()

  const containsField = (root: ts.Node): boolean => {
    let found = false
    const visit = (node: ts.Node) => {
      if (found) return
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        ((ts.isIdentifier(node.name) && node.name.text === options.field) ||
          (ts.isStringLiteralLike(node.name) &&
            node.name.text === options.field))
      ) {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    return found
  }

  for (const source of program.getSourceFiles()) {
    if (!scanned.has(source.fileName)) continue
    const name = relative(options.root, source.fileName)
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["insert", "patch", "replace"].includes(node.expression.name.text) &&
        ((ts.isPropertyAccessExpression(node.expression.expression) &&
          node.expression.expression.name.text === "db") ||
          isOccurrenceUsageWriterCall(
            node.expression.expression,
            checker,
            options.root
          )) &&
        node.arguments[0] !== undefined &&
        node.arguments.length >= 2
      ) {
        const first = node.arguments[0]
        const table = ts.isStringLiteralLike(first)
          ? first.text
          : /(?:Id<"|__tableName: ")(\w+)"/.exec(
              checker.typeToString(checker.getTypeAtLocation(first))
            )?.[1]
        const value = node.arguments[node.arguments.length - 1]!
        if (table === options.table && containsField(value)) {
          writers.add(
            `${name}#${enclosingName(node)}#${node.expression.name.text}#${table}#${options.field}`
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...writers].sort()
}
