/**
 * Shared TypeScript/TSX reading helpers for the design-system workspace
 * (Plan 033 Phase 0, ADR-0046).
 *
 * Both the inventory and the styling-system classifier need the same three
 * facts out of React source — what it imports, which class tokens it writes
 * into `className`, and where those live — so the AST plumbing lives here once
 * rather than being re-derived per module.
 *
 * Everything is pure: callers supply file contents, so fixtures, the current
 * checkout, and an opt-in external checkout all travel the same path.
 */

import ts from "typescript"

export interface DesignSystemSourceFile {
  path: string
  content: string
}

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/

export function isScriptPath(path: string): boolean {
  return SCRIPT_EXTENSION.test(path)
}

export function normalizeSourcePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "")
}

export function parseScript(file: DesignSystemSourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

export function walkScript(
  node: ts.Node,
  visit: (node: ts.Node) => void
): void {
  visit(node)
  node.forEachChild((child) => walkScript(child, visit))
}

/**
 * Class tokens a `className` attribute writes literally. Dynamic expressions
 * contribute only their literal string parts; nothing is guessed, because a
 * missed token must never become a silent classification or binding claim.
 */
export function staticClassTokens(
  initializer: ts.JsxAttributeValue | undefined
): string[] {
  if (!initializer) return []
  if (ts.isStringLiteral(initializer)) return splitClassList(initializer.text)
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    (ts.isStringLiteralLike(initializer.expression) ||
      ts.isNoSubstitutionTemplateLiteral(initializer.expression))
  ) {
    return splitClassList(initializer.expression.text)
  }
  return []
}

export function splitClassList(value: string): string[] {
  return value.split(/\s+/).filter(Boolean)
}

export interface ClassNameSite {
  /** Tag the attribute sits on, e.g. `div` or `Button`. */
  element: string
  tokens: string[]
  start: number
  end: number
}

/**
 * Every `className` attribute in one file, with the literal tokens it carries.
 * Literal strings nested inside helper calls (`cn("a", cond && "b")`) count,
 * since those are still statically-authored class tokens.
 */
export function classNameSites(file: DesignSystemSourceFile): ClassNameSite[] {
  const source = parseScript(file)
  const sites: ClassNameSite[] = []
  walkScript(source, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText(source) !== "className") {
      return
    }
    const owner = node.parent.parent
    const element =
      ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)
        ? owner.tagName.getText(source)
        : "unknown"
    const tokens = new Set(staticClassTokens(node.initializer))
    if (node.initializer && ts.isJsxExpression(node.initializer)) {
      walkScript(node.initializer, (child) => {
        if (
          ts.isStringLiteralLike(child) ||
          ts.isNoSubstitutionTemplateLiteral(child)
        ) {
          for (const token of splitClassList(child.text)) tokens.add(token)
        }
        if (ts.isTemplateExpression(child)) {
          for (const token of splitClassList(child.head.text)) tokens.add(token)
          for (const span of child.templateSpans) {
            for (const token of splitClassList(span.literal.text)) {
              tokens.add(token)
            }
          }
        }
      })
    }
    sites.push({
      element,
      tokens: [...tokens],
      start: node.getStart(source),
      end: node.getEnd(),
    })
  })
  return sites
}

export interface ImportRecord {
  specifier: string
  /** True when the specifier resolves inside the checkout rather than a package. */
  relative: boolean
  start: number
  end: number
}

export function importRecords(file: DesignSystemSourceFile): ImportRecord[] {
  const source = parseScript(file)
  const records: ImportRecord[] = []
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue
    }
    const specifier = statement.moduleSpecifier.text
    records.push({
      specifier,
      relative: specifier.startsWith(".") || specifier.startsWith("@/"),
      start: statement.getStart(source),
      end: statement.getEnd(),
    })
  }
  return records
}
