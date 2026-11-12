// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import { expect, test } from "vitest"

const root = fileURLToPath(new URL(".", import.meta.url))
const surfaces = [
  {
    file: "actions.ts",
    gate: "assertLocalSliceWrite",
    delegates: ["loadSliceAuthoring", "loadSliceService"],
  },
  { file: "ai-actions.ts", gate: "assertLocalDevelopment", delegates: [] },
  { file: "create/actions.ts", gate: "assertLocalDevelopment", delegates: [] },
]

// Inspect executable calls, not comments, strings or unused nested callbacks.
function callsGate(body: ts.Node, names: ReadonlySet<string>): boolean {
  if (ts.isFunctionLike(body)) return false
  if (
    ts.isCallExpression(body) &&
    ts.isIdentifier(body.expression) &&
    names.has(body.expression.text)
  ) {
    return true
  }
  return ts.forEachChild(body, (child) => callsGate(child, names)) ?? false
}

test("every Slice authoring action file has a production-gate disposition", () => {
  const files = readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => /(^|\/)(?:ai-)?actions\.ts$/.test(file))
    .sort()
  expect(files).toEqual(surfaces.map(({ file }) => file).sort())
})

// Resolve local bodies first: export lists and defaults can precede declarations.
// Anything outside these supported forms remains an unsupported value export.
function ungatedExports(
  sourceText: string,
  gate: string,
  delegates: readonly string[] = []
): string[] {
  const source = ts.createSourceFile(
    "actions.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true
  )
  const locals = new Map<string, ts.Node | undefined>()
  const exports = new Map<string, ts.Node | undefined>()
  const bodyOf = (node: ts.Node | undefined): ts.Node | undefined => {
    if (node && ts.isParenthesizedExpression(node))
      return bodyOf(node.expression)
    return node &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node))
      ? node.body
      : undefined
  }
  const bindingNames = (name: ts.BindingName): string[] =>
    ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap((element) =>
          ts.isBindingElement(element) ? bindingNames(element.name) : []
        )

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.set(statement.name.text, bodyOf(statement))
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          locals.set(
            name,
            ts.isIdentifier(declaration.name)
              ? bodyOf(declaration.initializer)
              : undefined
          )
        }
      }
    }
  }

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (!element.isTypeOnly) {
            exports.set(
              element.name.text,
              statement.moduleSpecifier
                ? undefined
                : locals.get((element.propertyName ?? element.name).text)
            )
          }
        }
      } else {
        exports.set(
          clause && ts.isNamespaceExport(clause) ? clause.name.text : "*",
          undefined
        )
      }
      continue
    }
    if (ts.isExportAssignment(statement)) {
      exports.set(
        "default",
        statement.isExportEquals
          ? undefined
          : ts.isIdentifier(statement.expression)
            ? locals.get(statement.expression.text)
            : bodyOf(statement.expression)
      )
      continue
    }
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined
    if (
      !modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    )
      continue
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    )
      continue
    if (ts.isFunctionDeclaration(statement)) {
      const isDefault = modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
      )
      exports.set(
        isDefault ? "default" : (statement.name?.text ?? "<anonymous>"),
        bodyOf(statement)
      )
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name))
          exports.set(name, locals.get(name))
      }
    } else {
      const name = (statement as ts.DeclarationStatement).name
      exports.set(name?.getText(source) ?? "<unsupported export>", undefined)
    }
  }

  const invalid = new Set<string>()
  const allowed = new Set([gate])
  for (const delegate of delegates) {
    const body = locals.get(delegate)
    if (body && callsGate(body, new Set([gate]))) allowed.add(delegate)
    else invalid.add(delegate)
  }
  for (const [name, body] of exports) {
    if (!body || !callsGate(body, allowed)) invalid.add(name)
  }
  return [...invalid]
}

const rejectedExports = [
  {
    form: "function declaration",
    source: "export async function action() { return 1 }",
    name: "action",
  },
  ...["const", "let", "var"].flatMap((kind) => [
    {
      form: `${kind} arrow`,
      source: `export ${kind} action = async () => 1`,
      name: "action",
    },
    {
      form: `${kind} function expression`,
      source: `export ${kind} action = async function () { return 1 }`,
      name: "action",
    },
  ]),
  {
    form: "export list",
    source: "async function action() { return 1 }; export { action }",
    name: "action",
  },
  {
    form: "aliased export",
    source:
      "async function action() { return 1 }; export { action as renamed }",
    name: "renamed",
  },
  {
    form: "named re-export",
    source: 'export { action as renamed } from "./other"',
    name: "renamed",
  },
  { form: "star re-export", source: 'export * from "./other"', name: "*" },
  {
    form: "namespace re-export",
    source: 'export * as actions from "./other"',
    name: "actions",
  },
  {
    form: "default anonymous function",
    source: "export default async function () { return 1 }",
    name: "default",
  },
  {
    form: "default named function",
    source: "export default async function action() { return 1 }",
    name: "default",
  },
  {
    form: "default arrow",
    source: "export default async () => 1",
    name: "default",
  },
  {
    form: "default local reference",
    source: "async function action() { return 1 }; export default action",
    name: "default",
  },
  {
    form: "non-function initializer",
    source: "export const action = 1",
    name: "action",
  },
  {
    form: "unresolved local reference",
    source: 'import { action } from "./other"; export { action }',
    name: "action",
  },
  {
    form: "nested unused gate",
    source:
      "export const action = async () => { const unused = () => gate(); return 1 }",
    name: "action",
  },
  { form: "non-function default", source: "export default 1", name: "default" },
]

test.each(rejectedExports)(
  "rejects ungated or unsupported $form",
  ({ source, name }) => {
    expect(ungatedExports(source, "gate")).toEqual([name])
  }
)

const gatedExports = [
  {
    form: "function declaration",
    source: "export async function action() { gate() }",
  },
  ...["const", "let", "var"].flatMap((kind) => [
    {
      form: `${kind} arrow`,
      source: `export ${kind} action = async () => { gate() }`,
    },
    {
      form: `${kind} function expression`,
      source: `export ${kind} action = async function () { gate() }`,
    },
  ]),
  {
    form: "expression-body arrow",
    source: "export const action = async () => gate()",
  },
  {
    form: "export list with alias",
    source:
      "export { action, other as renamed }; async function action() { gate() }; const other = async () => gate()",
  },
  {
    form: "default anonymous function",
    source: "export default async function () { gate() }",
  },
  {
    form: "default named function",
    source: "export default async function action() { gate() }",
  },
  { form: "default arrow", source: "export default async () => gate()" },
  {
    form: "default local reference",
    source: "const action = async () => gate(); export default action",
  },
  {
    form: "type-only exports",
    source:
      'export type X = string; export interface Y {}; export type { Z } from "./other"; export { type Z } from "./other"; export { type X, type Y }',
  },
  {
    form: "mixed type and value list",
    source:
      "type X = string; const action = async () => gate(); export { type X, action }",
  },
]

test.each(gatedExports)("accepts gated or type-only $form", ({ source }) => {
  expect(ungatedExports(source, "gate")).toEqual([])
})

test("only trusts delegates whose bodies call the gate", () => {
  expect(
    ungatedExports(
      "async function delegate() { gate() }; export async function action() { delegate() }",
      "gate",
      ["delegate"]
    )
  ).toEqual([])
  expect(
    ungatedExports(
      "async function delegate() {}; export async function action() { delegate() }",
      "gate",
      ["delegate"]
    )
  ).toContain("delegate")
})

test.each(surfaces)("$file gates every value export", (surface) => {
  expect(
    ungatedExports(
      readFileSync(join(root, surface.file), "utf8"),
      surface.gate,
      surface.delegates
    ),
    `${surface.file}: production refusal must be enforced; unsupported exports fail closed`
  ).toEqual([])
})
