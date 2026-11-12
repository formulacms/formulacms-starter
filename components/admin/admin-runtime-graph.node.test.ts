import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, test } from "vitest"

type Dependency = Readonly<{
  specifier: string | null
  runtime: boolean
  line: number
}>

type GraphResult = Readonly<{
  modules: Set<string>
  forbidden: string[]
  forbiddenTypeImports: string[]
  apiReferences: string[]
  unresolved: string[]
}>

const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../../", import.meta.url))
)
const TSCONFIG_PATH = join(REPOSITORY_ROOT, "tsconfig.json")
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]sx?)$/
const DECLARATION_EXTENSION = /\.d\.(?:ts|mts|cts)$/

type EntryExpectation = { entry: string; reaches: readonly string[] }

// FR2e (D-7): entries for routes the starter does not ship live in the
// private `admin-runtime-graph.sourceInventory.ts`; source merges them. The
// Settings > AI route ships, so its entry is in the base list below.
const SOURCE_ONLY_ENTRIES: readonly EntryExpectation[] = (Object.values(
  import.meta.glob("./admin-runtime-graph.sourceInventory.ts", { eager: true, import: "default" })
)[0] ?? []) as readonly EntryExpectation[]

const ENTRY_EXPECTATIONS: readonly EntryExpectation[] = [
  {
    entry: "app/(core)/admin/(authenticated)/layout.tsx",
    reaches: [
      "components/admin/admin-shell.tsx",
      "components/admin/command-palette.tsx",
      "components/admin/contributions/ai-help.ts",
      "components/admin/ai-help/help-participant.tsx",
      "components/admin/ai-help/help-chat.tsx",
    ],
  },
  {
    entry: "app/(core)/admin/(authenticated)/pages/new/page.tsx",
    reaches: ["components/admin/new-page-form.tsx"],
  },
  {
    entry: "app/(core)/admin/(authenticated)/pages/[id]/page.tsx",
    reaches: ["components/admin/page-editor.tsx"],
  },
  {
    entry: "app/(core)/admin/(authenticated)/settings/layout.tsx",
    reaches: ["components/admin/contributions/ai-settings.ts"],
  },
  {
    entry: "app/(core)/admin/(authenticated)/settings/ai/page.tsx",
    reaches: [
      "components/admin/contributions/ai-settings.server.ts",
      "components/admin/ai-settings-screen.tsx",
      "components/admin/ai-settings-model-picker.tsx",
    ],
  },
  ...SOURCE_ONLY_ENTRIES,
]

const FORBIDDEN_EXACT_MODULES = new Set([
  "app/(core)/admin/(authenticated)/pages/local-ai-routing",
  "app/(core)/admin/(authenticated)/help-ai-routing",
  "app/(core)/admin/(authenticated)/pages/ai-actions",
  "app/(core)/admin/(authenticated)/help-ai-actions",
  "app/(core)/admin/(authenticated)/settings/ai/actions",
  "components/admin/ai-settings",
  "components/admin/ai-settings-workbench",
  "components/admin/help-answer-panel",
  "components/admin/new-page-ai-wizard",
  "components/admin/help-availability",
  "components/admin/use-ai-configured",
  "components/admin/new-page/lib/ai-availability",
  "components/admin/new-page/lib/page-fill",
  "components/admin/new-page/lib/page-outline",
  "components/admin/page-editor/lib/field-generation",
  "components/admin/page-editor/lib/field-translation",
  "components/admin/page-editor/lib/page-meta",
  "components/admin/page-editor/lib/page-translation",
  "components/admin/page-editor/lib/translated-locale-apply",
  "scripts/lib/dev-ai-selection",
  "scripts/lib/dev-ai-connections",
  "scripts/lib/dev-task-execution",
  "scripts/lib/subscription-cli-capabilities",
])

const FORBIDDEN_DIRECTORIES = [
  "lib/ai/",
  "convex/lib/agents/",
  "convex/lib/help/",
] as const

function loadCompilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile)
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n")
    )
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    REPOSITORY_ROOT,
    undefined,
    TSCONFIG_PATH
  )
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n")
        )
        .join("\n")
    )
  }
  return parsed.options
}

const COMPILER_OPTIONS = loadCompilerOptions()

function repositoryPath(path: string): string {
  return relative(REPOSITORY_ROOT, path).split(sep).join("/")
}

function isRepositoryPath(path: string): boolean {
  const local = relative(REPOSITORY_ROOT, path)
  return local === "" || (!local.startsWith(`..${sep}`) && !isAbsolute(local))
}

function stripScriptExtension(path: string): string {
  return path.replace(SCRIPT_EXTENSION, "")
}

function isForbidden(path: string): boolean {
  const local = repositoryPath(path)
  const withoutExtension = stripScriptExtension(local)
  return (
    FORBIDDEN_EXACT_MODULES.has(withoutExtension) ||
    FORBIDDEN_DIRECTORIES.some((directory) => local.startsWith(directory))
  )
}

function importHasRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  if (!clause.namedBindings) return false
  if (ts.isNamespaceImport(clause.namedBindings)) return true
  return clause.namedBindings.elements.some((item) => !item.isTypeOnly)
}

function exportHasRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some((item) => !item.isTypeOnly)
}

function dependencyLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function sourceDependencies(source: ts.SourceFile): Dependency[] {
  const dependencies: Dependency[] = []
  const add = (specifier: string | null, runtime: boolean, node: ts.Node) => {
    dependencies.push({
      specifier,
      runtime,
      line: dependencyLine(source, node),
    })
  }

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      add(
        statement.moduleSpecifier.text,
        importHasRuntimeValue(statement),
        statement
      )
      continue
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      add(
        statement.moduleSpecifier.text,
        exportHasRuntimeValue(statement),
        statement
      )
      continue
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const expression = statement.moduleReference.expression
      add(
        expression && ts.isStringLiteralLike(expression)
          ? expression.text
          : null,
        true,
        statement
      )
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0]
      add(
        argument && ts.isStringLiteralLike(argument) ? argument.text : null,
        true,
        node
      )
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      add(node.argument.literal.text, false, node)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)

  return dependencies
}

function matchesPathAlias(specifier: string): boolean {
  return Object.keys(COMPILER_OPTIONS.paths ?? {}).some((pattern) => {
    const wildcard = pattern.indexOf("*")
    if (wildcard === -1) return specifier === pattern
    return (
      specifier.startsWith(pattern.slice(0, wildcard)) &&
      specifier.endsWith(pattern.slice(wildcard + 1))
    )
  })
}

function isPotentiallyLocal(specifier: string): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    matchesPathAlias(specifier)
  )
}

function declarationRuntimeSibling(path: string): string | null {
  const candidate = path.endsWith(".d.mts")
    ? path.slice(0, -6) + ".mjs"
    : path.endsWith(".d.cts")
      ? path.slice(0, -6) + ".cjs"
      : path.endsWith(".d.ts")
        ? path.slice(0, -5) + ".js"
        : null
  return candidate && existsSync(candidate) ? candidate : null
}

type ResolvedDependency = Readonly<{
  path: string
  local: boolean
  script: boolean
}>

function directAssetPath(
  specifier: string,
  containingFile: string
): string | null {
  const candidate = specifier.startsWith("/")
    ? specifier
    : specifier.startsWith(".")
      ? resolve(dirname(containingFile), specifier)
      : matchesPathAlias(specifier) && specifier.startsWith("@/")
        ? join(REPOSITORY_ROOT, specifier.slice(2))
        : null
  if (!candidate || !existsSync(candidate) || !statSync(candidate).isFile()) {
    return null
  }
  return candidate
}

function resolveDependency(
  dependency: Dependency,
  containingFile: string
): ResolvedDependency | null {
  if (dependency.specifier === null) return null
  const resolution = ts.resolveModuleName(
    dependency.specifier,
    containingFile,
    COMPILER_OPTIONS,
    ts.sys
  ).resolvedModule
  let path = resolution?.resolvedFileName
  if (!path)
    path = directAssetPath(dependency.specifier, containingFile) ?? undefined
  if (!path) return null

  const local =
    isRepositoryPath(path) &&
    !repositoryPath(path).startsWith("node_modules/") &&
    resolution?.isExternalLibraryImport !== true
  if (local && dependency.runtime && DECLARATION_EXTENSION.test(path)) {
    path = declarationRuntimeSibling(path) ?? path
  }
  return {
    path: resolve(path),
    local,
    script: SCRIPT_EXTENSION.test(path) && !DECLARATION_EXTENSION.test(path),
  }
}

function scanRuntimeGraph(entry: string): GraphResult {
  const entryPath = join(REPOSITORY_ROOT, entry)
  const pending = [entryPath]
  const seen = new Set<string>()
  const modules = new Set<string>()
  const forbidden = new Set<string>()
  const forbiddenTypeImports = new Set<string>()
  const apiReferences = new Set<string>()
  const unresolved = new Set<string>()

  while (pending.length > 0) {
    const path = resolve(pending.pop()!)
    if (seen.has(path)) continue
    seen.add(path)
    modules.add(repositoryPath(path))

    const text = readFileSync(path, "utf8")
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const apiPattern = /\bapi\.(?:cms\.(?:ai|agents)|agents)\b/g
    for (const match of text.matchAll(apiPattern)) {
      const line = source.getLineAndCharacterOfPosition(match.index).line + 1
      apiReferences.add(`${repositoryPath(path)}:${line} ${match[0]}`)
    }

    for (const dependency of sourceDependencies(source)) {
      const kind = dependency.runtime ? "runtime" : "type-only"
      if (dependency.specifier === null) {
        if (dependency.runtime) {
          unresolved.add(
            `${repositoryPath(path)}:${dependency.line} non-literal dynamic import`
          )
        }
        continue
      }
      const resolved = resolveDependency(dependency, path)
      if (!resolved) {
        if (isPotentiallyLocal(dependency.specifier)) {
          unresolved.add(
            `${repositoryPath(path)}:${dependency.line} ${kind} ${dependency.specifier}`
          )
        }
        continue
      }
      if (!resolved.local) continue
      if (dependency.runtime && DECLARATION_EXTENSION.test(resolved.path)) {
        unresolved.add(
          `${repositoryPath(path)}:${dependency.line} runtime ${dependency.specifier} resolved only to ${repositoryPath(resolved.path)}`
        )
        continue
      }
      if (isForbidden(resolved.path)) {
        const edge = `${repositoryPath(path)}:${dependency.line} -> ${repositoryPath(resolved.path)}`
        if (dependency.runtime) forbidden.add(edge)
        else forbiddenTypeImports.add(edge)
        continue
      }
      if (dependency.runtime && resolved.script) pending.push(resolved.path)
    }
  }

  return {
    modules,
    forbidden: [...forbidden].sort(),
    forbiddenTypeImports: [...forbiddenTypeImports].sort(),
    apiReferences: [...apiReferences].sort(),
    unresolved: [...unresolved].sort(),
  }
}

// Core reaches AI only through the Writing, Translation and Help seams.
// AI-owned files reached through a seam may name AI functions; every other
// reached file may not.
const WRITING_SEAM = "components/admin/contributions/ai-writing.ts"
const TRANSLATION_SEAM = "components/admin/contributions/ai-translation.ts"
const HELP_SEAM = "components/admin/contributions/ai-help.ts"
const AI_SEAMS = [WRITING_SEAM, TRANSLATION_SEAM, HELP_SEAM] as const
// The Help chat names its link ids with the `HelpIntentId` type. Only that
// type-only edge, only from a seam-reached AI-owned file, is allowed; every
// runtime edge into `convex/lib/help/` stays forbidden.
const HELP_INTENTS_MODULE = "convex/lib/help/intents.ts"
// The AI-owned files that the seams reach. A source-only test checks this
// list against the AI module's owned paths, which the starter does not ship.
const AI_OWNED_PATHS: ReadonlySet<string> = new Set([
  "components/admin/ai-help/help-chat.tsx",
  "components/admin/ai-help/help-errors.ts",
  "components/admin/ai-help/help-participant.tsx",
  "components/admin/ai-translation/page-editor-participant.tsx",
  "components/admin/ai-translation/translation-review.tsx",
  "components/admin/ai-writing/new-page-participant.tsx",
  "components/admin/ai-writing/page-jobs.tsx",
  "components/admin/ai-writing/page-wizard.tsx",
])

function seamExemptFiles(): Set<string> {
  return new Set(
    AI_SEAMS.flatMap((seam) => [...scanRuntimeGraph(seam).modules]).filter(
      (path) => AI_OWNED_PATHS.has(path)
    )
  )
}

function typeEdgeViolations(
  edges: readonly string[],
  exempt: ReadonlySet<string>
): string[] {
  return edges.filter((edge) => {
    const [from = "", to] = edge.split(" -> ")
    return !(to === HELP_INTENTS_MODULE && exempt.has(from.replace(/:\d+$/, "")))
  })
}

function apiReferenceViolations(
  references: readonly string[],
  exempt: ReadonlySet<string>
): string[] {
  return references.filter(
    (reference) => !exempt.has(reference.replace(/:\d+ .*$/, ""))
  )
}

const EFFECTIVE_READERS = new Set([
  "components/admin/admin-module-state-provider.tsx",
  "components/admin/authenticated-admin-shell.tsx",
])

function moduleStateReaders(text: string): string[] {
  const source = ts.createSourceFile(
    "reader.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const apiNames = new Set(["api"])
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith("/convex/_generated/api")
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const specifier of bindings.elements) {
        if ((specifier.propertyName?.text ?? specifier.name.text) === "api")
          apiNames.add(specifier.name.text)
      }
  }
  function chain(node: ts.Node): string[] {
    if (ts.isIdentifier(node)) return [node.text]
    if (ts.isPropertyAccessExpression(node))
      return [...chain(node.expression), node.name.text]
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
    )
      return [...chain(node.expression), node.argumentExpression.text]
    return []
  }
  const readers: string[] = []
  function visit(node: ts.Node) {
    if (ts.isTypeNode(node)) return
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      )
    ) {
      const parts = chain(node)
      if (
        apiNames.has(parts[0] ?? "") &&
        parts[1] === "cms" &&
        (["modules", "redirects"].includes(parts[2] ?? "") ||
          (parts[2] === "multilingual" && parts[3] === "getMultilingualState"))
      ) {
        readers.push(["api", ...parts.slice(1)].join("."))
      }
    }
    if (
      ts.isIdentifier(node) &&
      /^(?:readModuleState|resolveModuleGuardState|resolveOptionalModuleGuardState|resolveEffectiveModuleState|resolveEffectiveModuleStateFromEnabled)$/.test(
        node.text
      )
    )
      readers.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return readers
}

function moduleStateReadViolations(
  files: Iterable<readonly [string, string]>
): string[] {
  const violations: string[] = []
  for (const [path, text] of files) {
    const readers = moduleStateReaders(text)
    if (
      readers.length &&
      (!EFFECTIVE_READERS.has(path) ||
        readers.length !== 1 ||
        readers[0] !== "api.cms.modules.effective")
    )
      violations.push(`${path}: ${readers.join(", ")}`)
  }
  return violations
}

describe("all-off admin runtime graph", () => {
  test("extracts value edges and erases type-only edges", () => {
    const source = ts.createSourceFile(
      "dependency-fixture.tsx",
      [
        'import type { TypeOnly } from "./type-only"',
        'import { type AlsoTypeOnly } from "./also-type-only"',
        'import { type MixedType, runtimeValue } from "./mixed"',
        'export type { ExportedType } from "./exported-type"',
        'export { runtimeExport } from "./runtime-export"',
        'const lazyValue = lazy(() => import("./lazy-runtime"))',
        "void runtimeValue",
        "void lazyValue",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const dependencies = sourceDependencies(source)

    expect(
      dependencies.filter((item) => item.runtime).map((item) => item.specifier)
    ).toEqual(["./mixed", "./runtime-export", "./lazy-runtime"])
    expect(
      dependencies.filter((item) => !item.runtime).map((item) => item.specifier)
    ).toEqual(["./type-only", "./also-type-only", "./exported-type"])
  })

  test("resolves the generated Convex API declaration to runtime JavaScript", () => {
    const resolved = resolveDependency(
      { specifier: "@/convex/_generated/api", runtime: true, line: 1 },
      join(REPOSITORY_ROOT, "components/admin/page-editor.tsx")
    )

    expect(resolved?.local).toBe(true)
    expect(resolved && repositoryPath(resolved.path)).toBe(
      "convex/_generated/api.js"
    )
  })

  // M01c-P6 / C5: only the two named hosts may read committed visibility.
  test("ratchets the shell to its two exact effective readers", () => {
    const result = scanRuntimeGraph(
      "app/(core)/admin/(authenticated)/layout.tsx"
    )
    expect(result.modules.has("components/admin/navigation.ts")).toBe(true)
    const files = [...result.modules].map(
      (path) =>
        [path, readFileSync(join(REPOSITORY_ROOT, path), "utf8")] as const
    )
    expect(moduleStateReadViolations(files)).toEqual([])
    for (const path of EFFECTIVE_READERS) {
      expect(result.modules.has(path)).toBe(true)
      expect(
        moduleStateReaders(readFileSync(join(REPOSITORY_ROOT, path), "utf8"))
      ).toEqual(["api.cms.modules.effective"])
    }
  })

  test("rejects an injected second reader, alias, bracket access and other resolver", () => {
    expect(
      moduleStateReadViolations([
        [
          "components/admin/admin-module-state-provider.tsx",
          "api.cms.modules.effective; api.cms.modules.effective",
        ],
        [
          "components/admin/sidebar.tsx",
          'import { api as backend } from "@/convex/_generated/api"; backend["cms"].modules.effective',
        ],
        [
          "components/admin/authenticated-admin-shell.tsx",
          "api.cms.modules.preview",
        ],
        ["components/admin/navigation.ts", "resolveEffectiveModuleState(ctx)"],
      ])
    ).toHaveLength(4)
  })


  test("exempts only AI-owned files reached through the AI seams from the API scan", () => {
    const exempt = seamExemptFiles()
    const owned = "components/admin/ai-writing/page-wizard.tsx"
    expect(exempt.has(owned)).toBe(true)
    expect(
      exempt.has("components/admin/ai-translation/page-editor-participant.tsx")
    ).toBe(true)
    expect(exempt.has("components/admin/ai-help/help-chat.tsx")).toBe(true)
    expect(exempt.has("components/admin/command-palette.tsx")).toBe(false)
    expect(exempt.has(TRANSLATION_SEAM)).toBe(false)
    expect(exempt.has(HELP_SEAM)).toBe(false)
    for (const path of exempt) expect(AI_OWNED_PATHS.has(path)).toBe(true)
    expect(exempt.has("components/admin/new-page-form.tsx")).toBe(false)
    expect(exempt.has(WRITING_SEAM)).toBe(false)
    expect(
      apiReferenceViolations(
        [
          "components/admin/new-page-form.tsx:12 api.cms.agents",
          "components/admin/page-editor.tsx:40 api.cms.ai",
          `${owned}:7 api.agents`,
        ],
        new Set([owned])
      )
    ).toEqual([
      "components/admin/new-page-form.tsx:12 api.cms.agents",
      "components/admin/page-editor.tsx:40 api.cms.ai",
    ])
  })

  test("allows only the Help link-id type edge from a seam-reached AI-owned file", () => {
    const chat = "components/admin/ai-help/help-chat.tsx"
    const exempt = new Set([chat])
    expect(
      typeEdgeViolations(
        [
          `${chat}:40 -> ${HELP_INTENTS_MODULE}`,
          `${chat}:41 -> convex/lib/help/corpus.ts`,
          `components/admin/command-palette.tsx:9 -> ${HELP_INTENTS_MODULE}`,
          `${chat}:42 -> lib/ai/execution-contract.ts`,
        ],
        exempt
      )
    ).toEqual([
      `${chat}:41 -> convex/lib/help/corpus.ts`,
      `components/admin/command-palette.tsx:9 -> ${HELP_INTENTS_MODULE}`,
      `${chat}:42 -> lib/ai/execution-contract.ts`,
    ])
    const layout = scanRuntimeGraph("app/(core)/admin/(authenticated)/layout.tsx")
    expect(layout.forbidden).toEqual([])
    expect(
      layout.forbiddenTypeImports.some((edge) =>
        edge.startsWith(`${chat}:`)
      )
    ).toBe(true)
  })

  test("keeps every real all-off entry outside the forbidden AI graph", () => {
    const failures: string[] = []
    const exempt = seamExemptFiles()

    for (const expectation of ENTRY_EXPECTATIONS) {
      const result = scanRuntimeGraph(expectation.entry)
      for (const requiredModule of expectation.reaches) {
        if (!result.modules.has(requiredModule)) {
          failures.push(`${expectation.entry}: did not reach ${requiredModule}`)
        }
      }
      for (const edge of result.forbidden) {
        failures.push(`${expectation.entry}: forbidden runtime edge ${edge}`)
      }
      for (const edge of typeEdgeViolations(
        result.forbiddenTypeImports,
        exempt
      )) {
        failures.push(`${expectation.entry}: forbidden type-only edge ${edge}`)
      }
      for (const reference of apiReferenceViolations(
        result.apiReferences,
        exempt
      )) {
        failures.push(
          `${expectation.entry}: forbidden API reference ${reference}`
        )
      }
      for (const unresolved of result.unresolved) {
        failures.push(
          `${expectation.entry}: unresolved local edge ${unresolved}`
        )
      }
    }

    expect(failures, failures.join("\n")).toEqual([])
  })
})
