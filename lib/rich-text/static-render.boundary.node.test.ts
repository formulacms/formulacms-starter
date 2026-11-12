import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const publicClientIslands = [
  "components/public/mobile-nav.tsx",
  "components/public/navigation/main-nav.tsx",
  "components/public/navigation/locale-switcher.tsx",
  "components/public/header-auth-controls.tsx",
  "components/public/presentation-locale.tsx",
  "components/ui/accordion.tsx",
]

function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const imports: string[] = []
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
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
      )
        continue
      imports.push(statement.moduleSpecifier.text)
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        imports.push(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(statement)
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
        clause.elements.some((element) => !element.isTypeOnly)
      )
        imports.push(statement.moduleSpecifier.text)
    }
  }
  return imports
}

function localFile(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? resolve(root, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(from, "..", specifier)
      : undefined
  if (!base) return undefined
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"].map(
      (extension) => `${base}${extension}`
    ),
    ...[
      "index.ts",
      "index.tsx",
      "index.mts",
      "index.cts",
      "index.js",
      "index.jsx",
    ].map((name) => join(base, name)),
  ]
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile() && extname(candidate) !== ".json"
    } catch {
      return false
    }
  })
}

function runtimeGraph(
  entry: string
): Array<{ file: string; specifier: string }> {
  const pending = [entry]
  const seen = new Set<string>()
  const result: Array<{ file: string; specifier: string }> = []
  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || seen.has(file)) continue
    seen.add(file)
    for (const specifier of runtimeSpecifiers(file)) {
      result.push({ file, specifier })
      const resolved = localFile(file, specifier)
      if (resolved) pending.push(resolved)
    }
  }
  return result
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [path] : []
  })
}

function reactHookCalls(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const restrictedMembers = new Set([
    "createContext",
    "useCallback",
    "useContext",
    "useEffect",
    "useMemo",
    "useReducer",
    "useRef",
    "useState",
  ])
  const directImports = new Set<string>()
  const reactObjects = new Set<string>()

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "react" ||
      !statement.importClause
    )
      continue

    const bindings = statement.importClause.namedBindings
    if (statement.importClause.name)
      reactObjects.add(statement.importClause.name.text)
    if (bindings && ts.isNamespaceImport(bindings))
      reactObjects.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text
        if (restrictedMembers.has(imported))
          directImports.add(element.name.text)
      }
    }
  }

  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        directImports.has(node.expression.text)
      ) {
        found.push(node.expression.text)
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        reactObjects.has(node.expression.expression.text) &&
        restrictedMembers.has(node.expression.name.text)
      ) {
        found.push(node.expression.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("R1 import and client-island boundaries", () => {
  it("keeps the eight public client islands free of TipTap, rich-text, and kit-barrel imports", () => {
    for (const relative of publicClientIslands) {
      const entry = resolve(root, relative)
      expect(existsSync(entry), relative).toBe(true)
      const offenders = runtimeGraph(entry).filter(({ file, specifier }) => {
        const local = localFile(file, specifier)
        return (
          specifier.startsWith("@tiptap/") ||
          specifier === "happy-dom" ||
          specifier.startsWith("happy-dom/") ||
          specifier.includes("lib/rich-text") ||
          Boolean(local?.startsWith(`${resolve(root, "lib/rich-text")}/`)) ||
          local === resolve(root, "components/slice-kit/index.tsx")
        )
      })
      expect(offenders, relative).toEqual([])
    }
  })

  it("isolates the sole @tiptap/html import in legacy-html.ts", () => {
    const roots = ["app", "components", "convex", "lib", "scripts"]
      .map((directory) => resolve(root, directory))
      .filter(existsSync)
    const files = roots
      .flatMap(sourceFiles)
      .filter(
        (file) => !/\.(?:test|spec|oracle)\.(?:ts|tsx|mts|cts)$/.test(file)
      )
    const importers = files.filter((file) =>
      runtimeSpecifiers(file).includes("@tiptap/html")
    )
    expect(importers.map((file) => file.replace(`${root}/`, ""))).toEqual([
      "lib/rich-text/legacy-html.ts",
    ])
  })

  it("keeps the client-compatible adapter directive-free and hook-free", () => {
    const file = resolve(root, "lib/rich-text/static-render.tsx")
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const useClient = source.statements.some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression) &&
        statement.expression.text === "use client"
    )
    expect(useClient).toBe(false)
    expect(reactHookCalls(file)).toEqual([])
  })

  it("keeps the PM React renderer in the adapter and excludes production JSON walking", () => {
    const roots = ["app", "components", "convex", "lib", "scripts"]
      .map((directory) => resolve(root, directory))
      .filter(existsSync)
    const files = roots
      .flatMap(sourceFiles)
      .filter(
        (file) => !/\.(?:test|spec|oracle)\.(?:ts|tsx|mts|cts)$/.test(file)
      )
    const importers = files.flatMap((file) =>
      runtimeSpecifiers(file)
        .filter((specifier) => specifier.startsWith("@tiptap/static-renderer"))
        .map((specifier) => ({ file: file.replace(`${root}/`, ""), specifier }))
    )
    expect(importers).toEqual([
      {
        file: "lib/rich-text/static-render.tsx",
        specifier: "@tiptap/static-renderer/pm/react",
      },
    ])
    const productionRenderFiles = files.filter((file) =>
      file.startsWith(resolve(root, "lib/rich-text"))
    )
    for (const file of productionRenderFiles) {
      const source = readFileSync(file, "utf8")
      expect(source, file).not.toMatch(/@tiptap\/static-renderer\/json/)
    }

    for (const relative of [
      "lib/rich-text/static-render.tsx",
      "lib/rich-text/tolerant-reader.ts",
      "lib/rich-text/link-grouping.tsx",
    ]) {
      const file = resolve(root, relative)
      const source = readFileSync(file, "utf8")
      expect(source, relative).not.toMatch(/^\s*["']use client["']/m)
      expect(reactHookCalls(file), relative).toEqual([])
    }
  })

  it("keeps declared and installed TipTap packages pinned and renderer peers satisfied", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8")
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = { ...manifest.dependencies, ...manifest.devDependencies }
    const entries = Object.entries(declared).filter(([name]) =>
      name.startsWith("@tiptap/")
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const [name, version] of entries) {
      expect(version, `${name} package.json`).toBe("3.32.0")
    }
    for (const peer of ["@tiptap/core", "@tiptap/pm"]) {
      expect(declared[peer]).toBe("3.32.0")
    }

  })
})
