import ts from "typescript"
import type { FieldContract } from "@/convex/lib/richtext/contracts"

/**
 * Every semantic heading in a slice renderer is editor-authored inline rich
 * text. This pure source check is shared by the pre-write persistence boundary
 * and the post-write verify-slice gate so generated and hand-authored JSX
 * cannot bypass the same invariant.
 */

const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi
const RICH_TEXT_COMPONENT_RE = /<(RichText|RichTextContent)\b[^>]*\/?\s*>/gi
const KIT_HEADING_RE =
  /<(RichText|Text)\b([^>]*?)\bas=["'](h[1-6])["']([^>]*)\/?\s*>/gi
const INLINE_PROFILE_RE = /\bprofile=["']inline["']/i
const FIELD_VALUE_RE =
  /\bvalue=\{\s*((?:slice\.)?primary|[A-Za-z_$][A-Za-z0-9_$]*)((?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)+)\s*\}/i

export interface RendererHeadingFieldAccess {
  root: "primary" | "item"
  path: string[]
}

export type IsInlineRichTextField = (
  access: RendererHeadingFieldAccess
) => boolean

export type ResolveRendererFieldContract = (
  access: RendererHeadingFieldAccess
) => RendererFieldContractResolution

export type RendererFieldContractResolution =
  | {
      state: "resolved"
      contract?: FieldContract
      /** Declared heading in the descriptor or the existing page outline. */
      outlineHeading?: boolean
      /** No adopted title anywhere in this slice; own inline heading only. */
      legacyHeading?: boolean
      /** Qualified server kit Accordion row owns this title's heading host. */
      inlineTitleHost?: "accordion-row"
    }
  | { state: "unresolved" }

type GovernedFieldBinding =
  | { state: "resolved"; access: RendererHeadingFieldAccess }
  | { state: "unresolved" }
  | { state: "not-governed" }

function jsxName(node: ts.JsxTagNameExpression): string {
  return node.getText()
}

function jsxAttribute(
  attributes: ts.JsxAttributes,
  name: string
): ts.JsxAttribute | undefined {
  return attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name
  )
}

function attributeString(
  attributes: ts.JsxAttributes,
  name: string
): string | undefined {
  const attribute = jsxAttribute(attributes, name)
  if (!attribute?.initializer) return undefined
  if (ts.isStringLiteral(attribute.initializer))
    return attribute.initializer.text
  if (ts.isJsxExpression(attribute.initializer)) {
    const expression = unwrapExpression(attribute.initializer.expression)
    if (
      expression &&
      (ts.isStringLiteral(expression) ||
        ts.isNoSubstitutionTemplateLiteral(expression))
    )
      return expression.text
    if (expression && ts.isTemplateExpression(expression)) {
      return expression.getText().slice(1, -1)
    }
  }
  return undefined
}

function unwrapExpression(
  expression: ts.Expression | undefined
): ts.Expression | undefined {
  let current = expression
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function accessFromPath(rawPath: string): RendererHeadingFieldAccess | null {
  const path = rawPath.replaceAll("?.", ".").replace(/^slice\./, "")
  const segments: string[] = []
  let segment = ""
  const pushSegment = () => {
    if (!segment) return
    if (!/^\d+$/.test(segment) && !/^\$\{[A-Za-z_$][\w$]*\}$/.test(segment)) {
      segments.push(segment)
    }
    segment = ""
  }

  for (let index = 0; index < path.length; index += 1) {
    const character = path[index]
    if (character === ".") {
      pushSegment()
      continue
    }
    if (character !== "[") {
      if (character === "]") return null
      segment += character
      continue
    }

    pushSegment()
    const close = path.indexOf("]", index + 1)
    if (close < 0) return null
    const key = path.slice(index + 1, close).trim()
    index = close
    if (/^\d+$/.test(key) || /^\$\{[A-Za-z_$][\w$]*\}$/.test(key)) continue
    if (
      key.length >= 2 &&
      ((key.startsWith('"') && key.endsWith('"')) ||
        (key.startsWith("'") && key.endsWith("'")))
    ) {
      const literalKey = key.slice(1, -1).replace(/\\([\\"'])/g, "$1")
      if (!/^\d+$/.test(literalKey)) segments.push(literalKey)
      continue
    }
    return null
  }
  pushSegment()

  const [root, ...fieldPath] = segments
  if (root === "primary") return { root, path: fieldPath }
  if (root === "items") return { root: "item", path: fieldPath }
  return null
}

function appendAccess(
  access: RendererHeadingFieldAccess,
  segment: string
): RendererHeadingFieldAccess {
  return { root: access.root, path: [...access.path, segment] }
}

function supportedListIndex(expression: ts.Expression): boolean {
  const index = unwrapExpression(expression)
  if (!index) return false
  if (ts.isNumericLiteral(index) || ts.isIdentifier(index)) return true
  if (ts.isNoSubstitutionTemplateLiteral(index)) return /^\d+$/.test(index.text)
  return (
    ts.isTemplateExpression(index) &&
    index.head.text === "" &&
    index.templateSpans.length === 1 &&
    ts.isIdentifier(index.templateSpans[0]?.expression) &&
    index.templateSpans[0]?.literal.text === ""
  )
}

function accessFromExpression(
  expression: ts.Expression | undefined,
  aliases: ReadonlyMap<string, RendererHeadingFieldAccess>
): RendererHeadingFieldAccess | null {
  const current = unwrapExpression(expression)
  if (!current) return null
  if (ts.isPropertyAccessExpression(current)) {
    if (
      ts.isIdentifier(current.expression) &&
      current.expression.text === "slice"
    ) {
      if (current.name.text === "primary") return { root: "primary", path: [] }
      if (current.name.text === "items") return { root: "item", path: [] }
    }
    const base = accessFromExpression(current.expression, aliases)
    return base ? appendAccess(base, current.name.text) : null
  }
  if (ts.isElementAccessExpression(current)) {
    const base = accessFromExpression(current.expression, aliases)
    const argument = unwrapExpression(current.argumentExpression)
    if (!base || !argument) return null
    if (
      ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument)
    ) {
      return /^\d+$/.test(argument.text)
        ? base
        : appendAccess(base, argument.text)
    }
    return supportedListIndex(argument) ? base : null
  }
  if (!ts.isIdentifier(current)) return null
  const alias = aliases.get(current.text)
  if (alias) return { root: alias.root, path: [...alias.path] }
  if (current.text === "primary") return { root: "primary", path: [] }
  if (current.text === "items") return { root: "item", path: [] }
  return null
}

function governedFieldBindingFromJsx(
  name: string,
  attributes: ts.JsxAttributes,
  aliases: ReadonlyMap<string, RendererHeadingFieldAccess>
): GovernedFieldBinding {
  if (name === "RichText" || name === "Text" || name === "KitImage") {
    if (!jsxAttribute(attributes, "fieldPath")) return { state: "unresolved" }
    const path = attributeString(attributes, "fieldPath")
    const access = path ? accessFromPath(path) : null
    return access ? { state: "resolved", access } : { state: "unresolved" }
  }
  if (name === "RichTextContent") {
    const value = jsxAttribute(attributes, "value")
    const initializer = value?.initializer
    if (initializer && ts.isJsxExpression(initializer)) {
      const access = accessFromExpression(initializer.expression, aliases)
      return access ? { state: "resolved", access } : { state: "unresolved" }
    }
    return { state: "unresolved" }
  }
  return { state: "not-governed" }
}

function jsxAttributes(node: ts.JsxOpeningLikeElement): ts.JsxAttributes {
  return node.attributes
}

type StrictOutputAliases = ReadonlyMap<string, RendererHeadingFieldAccess>

function strictLiteralAttribute(
  attributes: ts.JsxAttributes,
  name: string
): { value: string; encoded: boolean } | undefined {
  const initializer = jsxAttribute(attributes, name)?.initializer
  if (!initializer) return undefined
  if (ts.isStringLiteral(initializer)) {
    return {
      value: initializer.text,
      encoded: /&(?:#(?:x[\da-f]+|\d+)|[a-z]+);/i.test(initializer.text),
    }
  }
  if (ts.isJsxExpression(initializer)) {
    const expression = unwrapExpression(initializer.expression)
    if (
      expression &&
      (ts.isStringLiteral(expression) ||
        ts.isNoSubstitutionTemplateLiteral(expression))
    ) {
      return {
        value: expression.text,
        encoded: /&(?:#(?:x[\da-f]+|\d+)|[a-z]+);/i.test(expression.text),
      }
    }
  }
  return undefined
}

function decodeSimpleHtmlEntities(value: string): string {
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
      const parsed =
        code[0]?.toLowerCase() === "x"
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10)
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0x10ffff)
        return entity
      try {
        return String.fromCodePoint(parsed)
      } catch {
        return entity
      }
    })
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_entity, name: string) => {
      const decoded: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      }
      return decoded[name.toLowerCase()] ?? _entity
    })
}

function isTableProjection(access: RendererHeadingFieldAccess): boolean {
  return (
    access.root === "primary" &&
    access.path.length >= 2 &&
    (access.path[access.path.length - 1] === "headerRow" ||
      access.path[access.path.length - 1] === "rows" ||
      access.path[access.path.length - 1] === "length")
  )
}

function isNestedScalarProjection(
  access: RendererHeadingFieldAccess,
  resolveContract: ResolveRendererFieldContract
): boolean {
  if (access.root !== "primary" || access.path.length < 2) return false
  const property = access.path[access.path.length - 1]
  if (!new Set(["title", "url", "lat", "lng"]).has(property ?? "")) return false
  const parent: RendererHeadingFieldAccess = {
    root: access.root,
    path: access.path.slice(0, -1),
  }
  const resolution = resolveContract(parent)
  return resolution.state === "resolved" && resolution.contract !== "title"
}

function isRelationCardScalar(
  expression: ts.Expression,
  aliases: StrictOutputAliases,
  resolveContract: ResolveRendererFieldContract
): boolean {
  const projections: string[] = []
  const indices: ts.Expression[] = []
  let current: ts.Expression | undefined = unwrapExpression(expression)
  while (current) {
    if (ts.isPropertyAccessExpression(current)) {
      projections.unshift(current.name.text)
      current = unwrapExpression(current.expression)
      continue
    }
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      indices.unshift(current.argumentExpression)
      projections.unshift("[]")
      current = unwrapExpression(current.expression)
      continue
    }
    break
  }
  if (!current || !ts.isIdentifier(current) || current.text !== "ctx")
    return false
  if (projections[0] !== "relationCards" || !projections.includes("[]"))
    return false
  const terminal = projections[projections.length - 1]
  if (!new Set(["pageType", "title", "excerpt"]).has(terminal ?? ""))
    return false
  const relationIndex = indices[0]
  const access = accessFromExpression(relationIndex, aliases)
  if (!access || access.path.length < 2 || access.path.at(-1) !== "pageId")
    return false
  const relationField: RendererHeadingFieldAccess = {
    root: access.root,
    path: access.path.slice(0, -1),
  }
  const resolution = resolveContract(relationField)
  return resolution.state === "resolved" && resolution.contract !== "title"
}

function isScaffoldDateFormat(
  expression: ts.Expression,
  aliases: StrictOutputAliases,
  resolveContract: ResolveRendererFieldContract
): boolean {
  const call = unwrapExpression(expression)
  if (
    !call ||
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression)
  ) {
    return false
  }
  const formatter = unwrapExpression(call.expression.expression)
  if (!formatter || !ts.isNewExpression(formatter)) return false
  if (
    !ts.isPropertyAccessExpression(formatter.expression) ||
    formatter.expression.expression.getText() !== "Intl" ||
    formatter.expression.name.text !== "DateTimeFormat" ||
    formatter.arguments?.length !== 1
  ) {
    return false
  }
  const locale = unwrapExpression(formatter.arguments[0])
  if (
    !locale ||
    !ts.isPropertyAccessExpression(locale) ||
    locale.expression.getText() !== "ctx" ||
    locale.name.text !== "locale"
  ) {
    return false
  }
  if (call.expression.name.text !== "format" || call.arguments.length !== 1)
    return false
  const date = unwrapExpression(call.arguments[0])
  if (
    !date ||
    !ts.isNewExpression(date) ||
    date.expression.getText() !== "Date" ||
    date.arguments?.length !== 1
  ) {
    return false
  }
  const access = accessFromExpression(date.arguments[0], aliases)
  if (!access || access.path.length === 0) return false
  const resolution = resolveContract(access)
  return resolution.state === "resolved" && resolution.contract !== "title"
}

function isScaffoldContentEnvelope(
  file: ts.SourceFile
): ts.Expression | undefined {
  const isIdentifier = (expression: ts.Expression | undefined, name: string) =>
    !!expression &&
    ts.isIdentifier(unwrapExpression(expression)!) &&
    (unwrapExpression(expression) as ts.Identifier).text === name
  const isProperty = (
    expression: ts.Expression | undefined,
    base: string,
    name: string
  ) => {
    const current = expression && unwrapExpression(expression)
    return (
      !!current &&
      ts.isPropertyAccessExpression(current) &&
      current.expression.getText() === base &&
      current.name.text === name
    )
  }
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body) continue
    const statements = statement.body.statements
    if (statements.length !== 4) continue
    const fields = statements[0]
    const primary = statements[1]
    const content = statements[2]
    const returned = statements[3]
    if (
      !ts.isVariableStatement(fields) ||
      fields.declarationList.declarations.length !== 1 ||
      !ts.isVariableStatement(primary) ||
      primary.declarationList.declarations.length !== 1 ||
      !ts.isVariableStatement(content) ||
      content.declarationList.declarations.length !== 1 ||
      !ts.isReturnStatement(returned) ||
      !returned.expression
    )
      continue
    const fieldsDeclaration = fields.declarationList.declarations[0]
    const primaryDeclaration = primary.declarationList.declarations[0]
    const contentDeclaration = content.declarationList.declarations[0]
    if (
      !fieldsDeclaration ||
      !primaryDeclaration ||
      !contentDeclaration ||
      !ts.isIdentifier(fieldsDeclaration.name) ||
      fieldsDeclaration.name.text !== "fields" ||
      !fieldsDeclaration.initializer ||
      !ts.isCallExpression(fieldsDeclaration.initializer) ||
      !ts.isIdentifier(fieldsDeclaration.initializer.expression) ||
      fieldsDeclaration.initializer.expression.text !== "bindSliceFields" ||
      fieldsDeclaration.initializer.arguments.length !== 2 ||
      !ts.isIdentifier(fieldsDeclaration.initializer.arguments[0]) ||
      !fieldsDeclaration.initializer.arguments[0].text.endsWith("Def") ||
      !isIdentifier(fieldsDeclaration.initializer.arguments[1], "slice") ||
      !ts.isObjectBindingPattern(primaryDeclaration.name) ||
      primaryDeclaration.name.elements.length !== 1 ||
      primaryDeclaration.name.elements[0]?.name.getText() !== "primary" ||
      !isIdentifier(primaryDeclaration.initializer, "slice") ||
      !ts.isIdentifier(contentDeclaration.name) ||
      contentDeclaration.name.text !== "content" ||
      !contentDeclaration.initializer
    )
      continue
    const expression = unwrapExpression(returned.expression)
    if (!expression || !ts.isConditionalExpression(expression)) continue
    if (
      !isProperty(expression.condition, "ctx", "previewKitSlice") ||
      !ts.isCallExpression(expression.whenTrue) ||
      !isProperty(expression.whenTrue.expression, "ctx", "previewKitSlice") ||
      expression.whenTrue.arguments.length !== 1 ||
      !isIdentifier(expression.whenTrue.arguments[0], "content") ||
      !isIdentifier(expression.whenFalse, "content")
    )
      continue
    return contentDeclaration.initializer
  }
  return undefined
}

function validateStrictRendererOutput(
  file: ts.SourceFile,
  resolveContract: ResolveRendererFieldContract
): string[] {
  const failures: string[] = []
  const canonicalHelpers = new Set([
    "RichText",
    "Text",
    "Buttons",
    "KitImage",
    "RichTextContent",
    "SliceImage",
    "SliceButtons",
    "SliceIcon",
  ])
  const fieldHelpers = new Set([
    "RichText",
    "Text",
    "KitImage",
    "RichTextContent",
    "SliceImage",
    "SliceButtons",
    "Buttons",
  ])
  const report = (kind: "output" | "host", node: ts.Node, detail: string) => {
    const position = file.getLineAndCharacterOfPosition(node.getStart(file))
    failures.push(
      `unsupported renderer ${kind} (${detail}) at ${position.line + 1}:${position.character + 1}.`
    )
  }

  const isKnownDataAccess = (
    expression: ts.Expression,
    aliases: StrictOutputAliases
  ): boolean => {
    if (isRelationCardScalar(expression, aliases, resolveContract)) return true
    const access = accessFromExpression(expression, aliases)
    if (!access) return false
    const resolution = resolveContract(access)
    return (
      resolution.state === "resolved" ||
      isTableProjection(access) ||
      isNestedScalarProjection(access, resolveContract)
    )
  }

  const checkHost = (
    name: string,
    attributes: ts.JsxAttributes,
    node: ts.Node
  ): boolean => {
    let rejectedAsHost = false
    const rejectHost = (detail: string) => {
      report("host", node, detail)
      rejectedAsHost = true
    }
    if (name === "HeadingSlot")
      rejectHost("HeadingSlot is not a supported heading host")
    if (
      name === "AccordionTrigger" &&
      jsxAttribute(attributes, "headingLevel")
    ) {
      rejectHost("AccordionTrigger headingLevel is not permitted")
    }
    if (name === "RichText" && jsxAttribute(attributes, "headingLevel")) {
      rejectHost("RichText headingLevel is owned by the outline")
    }
    if (name === "RichText" || name === "Text") {
      if (jsxAttribute(attributes, "as")) {
        const host = strictLiteralAttribute(attributes, "as")
        if (
          !host ||
          host.encoded ||
          !new Set(["p", "span", "div"]).has(host.value)
        ) {
          rejectHost(`${name} as must be the literal p, span, or div host`)
        }
      }
    }
    if (jsxAttribute(attributes, "aria-level")) {
      rejectHost("aria-level manually controls heading semantics")
    }
    const role = jsxAttribute(attributes, "role")
    if (role) {
      const literalRole = strictLiteralAttribute(attributes, "role")
      if (!literalRole) {
        rejectHost("role has unresolved heading semantics")
      } else if (
        decodeSimpleHtmlEntities(literalRole.value).toLowerCase() === "heading"
      ) {
        rejectHost("role=heading manually controls heading semantics")
      }
    }
    if (fieldHelpers.has(name)) {
      const ctx = jsxAttribute(attributes, "ctx")
      if (ctx) {
        const initializer = ctx.initializer
        const expression =
          initializer && ts.isJsxExpression(initializer)
            ? unwrapExpression(initializer.expression)
            : undefined
        if (
          !expression ||
          !ts.isIdentifier(expression) ||
          expression.text !== "ctx"
        ) {
          rejectHost("field helper ctx must use the supplied ctx identifier")
        }
      }
    }
    return rejectedAsHost
  }

  const classifyOutput = (
    original: ts.Expression,
    aliases: StrictOutputAliases
  ): void => {
    const expression = unwrapExpression(original)
    if (!expression) {
      report("output", original, "empty output expression")
      return
    }
    if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) {
      const opening = ts.isJsxElement(expression)
        ? expression.openingElement
        : expression
      const name = jsxName(opening.tagName)
      const hostRejected = checkHost(name, opening.attributes, opening)
      const nativeTag =
        ts.isIdentifier(opening.tagName) && /^[a-z][A-Za-z0-9]*$/.test(name)
      if (
        !nativeTag &&
        !canonicalHelpers.has(name) &&
        !hostRejected &&
        !/^h[1-6]$/.test(name)
      ) {
        report("output", opening, `unsupported JSX component <${name}>`)
      }
      for (const property of opening.attributes.properties) {
        if (ts.isJsxSpreadAttribute(property)) {
          report("output", property, "opaque JSX attribute spread")
        } else if (
          property.name.getText() === "children" &&
          property.initializer
        ) {
          if (ts.isJsxExpression(property.initializer)) {
            if (property.initializer.expression) {
              classifyOutput(property.initializer.expression, aliases)
            }
          } else {
            classifyOutput(property.initializer, aliases)
          }
        }
      }
      if (ts.isJsxElement(expression)) {
        for (const child of expression.children) {
          if (ts.isJsxExpression(child)) {
            if (child.dotDotDotToken) {
              report("output", child, "opaque JSX child spread")
            } else if (child.expression) {
              classifyOutput(child.expression, aliases)
            }
          } else if (
            ts.isJsxElement(child) ||
            ts.isJsxSelfClosingElement(child)
          ) {
            classifyOutput(child, aliases)
          } else if (ts.isJsxFragment(child)) {
            classifyOutput(child, aliases)
          }
        }
      }
      return
    }
    if (ts.isJsxFragment(expression)) {
      for (const child of expression.children) {
        if (ts.isJsxExpression(child)) {
          if (child.dotDotDotToken) {
            report("output", child, "opaque JSX child spread")
          } else if (child.expression) {
            classifyOutput(child.expression, aliases)
          }
        } else if (
          ts.isJsxElement(child) ||
          ts.isJsxSelfClosingElement(child) ||
          ts.isJsxFragment(child)
        ) {
          classifyOutput(child, aliases)
        }
      }
      return
    }
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression) ||
      expression.kind === ts.SyntaxKind.NullKeyword ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword
    )
      return
    if (ts.isIdentifier(expression)) {
      if (["true", "false", "undefined"].includes(expression.text)) return
      if (isKnownDataAccess(expression, aliases)) return
      report(
        "output",
        expression,
        `unresolved output identifier ${expression.text}`
      )
      return
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        if (ts.isSpreadElement(element)) {
          report("output", element, "opaque array output spread")
        } else {
          classifyOutput(element, aliases)
        }
      }
      return
    }
    if (ts.isConditionalExpression(expression)) {
      classifyOutput(expression.whenTrue, aliases)
      classifyOutput(expression.whenFalse, aliases)
      return
    }
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        classifyOutput(expression.right, aliases)
        return
      }
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        classifyOutput(expression.left, aliases)
        classifyOutput(expression.right, aliases)
        return
      }
    }
    if (ts.isCallExpression(expression)) {
      if (isScaffoldDateFormat(expression, aliases, resolveContract)) return
      const callee = unwrapExpression(expression.expression)
      if (
        callee &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "map"
      ) {
        const listAccess = accessFromExpression(callee.expression, aliases)
        const listResolution = listAccess
          ? resolveContract(listAccess)
          : undefined
        if (
          !listAccess ||
          (listResolution?.state !== "resolved" &&
            !isTableProjection(listAccess))
        ) {
          report(
            "output",
            expression,
            "map receiver is not a resolved list projection"
          )
          return
        }
        const callback =
          expression.arguments[0] && unwrapExpression(expression.arguments[0])
        if (
          expression.arguments.length !== 1 ||
          !callback ||
          (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
        ) {
          report(
            "output",
            expression,
            "map output requires one inline callback"
          )
          return
        }
        const callbackAliases = new Map(aliases)
        for (const parameter of callback.parameters) {
          if (
            !ts.isIdentifier(parameter.name) ||
            parameter.initializer ||
            parameter.dotDotDotToken ||
            parameter.questionToken
          ) {
            report(
              "output",
              parameter,
              "map callback parameters must be simple identifiers"
            )
            return
          }
          // The map receiver has already been resolved as data; callback
          // parameters are scoped aliases to values from that sequence.
          callbackAliases.set(parameter.name.text, listAccess)
        }
        if (!callback.parameters[0]) {
          report(
            "output",
            callback,
            "map callback requires a simple first parameter"
          )
          return
        }
        if (ts.isBlock(callback.body)) {
          if (
            callback.body.statements.length !== 1 ||
            !ts.isReturnStatement(callback.body.statements[0]) ||
            !callback.body.statements[0].expression
          ) {
            report(
              "output",
              callback.body,
              "map callback must return supported output inline"
            )
            return
          }
          classifyOutput(
            callback.body.statements[0].expression,
            callbackAliases
          )
        } else {
          classifyOutput(callback.body, callbackAliases)
        }
        return
      }
      report("output", expression, "arbitrary output call")
      return
    }
    if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      if (isKnownDataAccess(expression, aliases)) return
      report("output", expression, "unresolved field/data access")
      return
    }
    report(
      "output",
      expression,
      `unsupported syntax ${ts.SyntaxKind[expression.kind]}`
    )
  }

  const parseDiagnostics = (
    file as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[]
    }
  ).parseDiagnostics
  if (parseDiagnostics.length > 0)
    return ["renderer JSX could not be parsed for heading policy"]
  const scaffoldContent = isScaffoldContentEnvelope(file)
  if (scaffoldContent) {
    classifyOutput(scaffoldContent, new Map())
    return [...new Set(failures)]
  }
  const expressions = file.statements.filter(ts.isExpressionStatement)
  if (expressions.length !== 1 || file.statements.length !== 1) {
    report(
      "output",
      file,
      "renderer body is not one supported output expression"
    )
  } else {
    classifyOutput(expressions[0]!.expression, new Map())
  }
  return [...new Set(failures)]
}

/** AST-based heading policy for generated and compatibility renderer bodies. */
export function validateContractRendererHeadings(
  source: string,
  resolveContract: ResolveRendererFieldContract,
  strictNewCreation = false
): string[] {
  const file = ts.createSourceFile(
    "renderer.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const failures: string[] = []
  const diagnostics = (
    file as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[]
    }
  ).parseDiagnostics
  if (diagnostics.length > 0) {
    return ["renderer JSX could not be parsed for heading policy"]
  }
  if (strictNewCreation) {
    failures.push(...validateStrictRendererOutput(file, resolveContract))
  }

  const labelFor = (access: RendererHeadingFieldAccess) =>
    `${access.root}.${access.path.join(".")}`

  type Host = { name: string; attributes: ts.JsxAttributes }
  const hasKitAccordion = file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/components/slice-kit" &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.name.text === "Accordion" &&
          (element.propertyName?.text ?? element.name.text) === "Accordion"
      )
  )
  const isAccordionTitleSlot = (
    node: ts.Node | undefined,
    access: RendererHeadingFieldAccess
  ) => {
    if (!node || !hasKitAccordion) return false
    let property: ts.PropertyAssignment | undefined
    let rows: ts.JsxAttribute | undefined
    for (
      let parent: ts.Node | undefined = node.parent;
      parent;
      parent = parent.parent
    ) {
      if (
        !property &&
        ts.isPropertyAssignment(parent) &&
        parent.name.getText(file) === "title"
      )
        property = parent
      if (ts.isJsxAttribute(parent)) {
        rows = parent
        break
      }
    }
    if (
      !property ||
      !rows ||
      rows.name.getText(file) !== "rows" ||
      !ts.isObjectLiteralExpression(property.parent)
    )
      return false
    const owner = rows.parent.parent
    if (
      (!ts.isJsxOpeningElement(owner) && !ts.isJsxSelfClosingElement(owner)) ||
      owner.tagName.getText(file) !== "Accordion"
    )
      return false
    const level = property.parent.properties.find(
      (p) =>
        ts.isPropertyAssignment(p) && p.name.getText(file) === "headingLevel"
    )
    if (
      !level ||
      !ts.isPropertyAssignment(level) ||
      !ts.isCallExpression(level.initializer) ||
      level.initializer.expression.getText(file) !== "fieldHeadingLevel" ||
      level.initializer.arguments[0]?.getText(file) !== "ctx.outline"
    )
      return false
    const path = level.initializer.arguments[1]
    const heading =
      path &&
      accessFromPath(
        ts.isStringLiteral(path) ? path.text : path.getText(file).slice(1, -1)
      )
    return (
      heading?.root === access.root &&
      heading.path.join(".") === access.path.join(".")
    )
  }
  const literal = (host: Host, name: string) => {
    const value = strictLiteralAttribute(host.attributes, name)
    return value && decodeSimpleHtmlEntities(value.value)
  }
  const headingAs = (host: Host) => {
    const value = literal(host, "as")
    return value && /^h[1-6]$/i.test(value) ? value : undefined
  }
  const isHelper = (host: Host) =>
    host.name === "HeadingSlot" || host.name === "AccordionTrigger"
  const outlineOwns = (
    host: Host,
    access: RendererHeadingFieldAccess,
    resolution: RendererFieldContractResolution
  ) => {
    const attribute = jsxAttribute(
      host.attributes,
      host.name === "HeadingSlot" ? "level" : "headingLevel"
    )
    const initializer = attribute?.initializer
    const expression =
      initializer && ts.isJsxExpression(initializer)
        ? unwrapExpression(initializer.expression)
        : undefined
    if (
      !expression ||
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== "fieldHeadingLevel" ||
      expression.arguments.length < 2 ||
      expression.arguments.length > 3 ||
      expression.arguments[0]?.getText() !== "ctx.outline"
    )
      return false
    const argument = unwrapExpression(expression.arguments[1])
    const path =
      argument &&
      (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument)
        ? argument.text
        : ts.isTemplateExpression(argument)
          ? argument.getText().slice(1, -1)
          : undefined)
    const heading = path ? accessFromPath(path) : null
    const declared = heading && resolveContract(heading)
    if (declared?.state !== "resolved" || !declared.outlineHeading) return false
    // Opaque list aliases remain PR-review territory. Keep their explicitly
    // declared outline host, while requiring a matching path for bindings the
    // descriptor can resolve. Manual hosts still fail even on unresolved data.
    return (
      resolution.state === "unresolved" ||
      (heading?.root === access.root &&
        heading.path.join(".") === access.path.join("."))
    )
  }

  const inspectAccess = (
    access: RendererHeadingFieldAccess,
    ancestors: Host[],
    componentName?: string,
    attributes?: ts.JsxAttributes,
    node?: ts.Node
  ) => {
    const resolution = resolveContract(access)
    const label = labelFor(access)
    const hosts =
      attributes && componentName
        ? [...ancestors, { name: componentName, attributes }]
        : ancestors
    const headingHosts = hosts.filter(
      (host) =>
        /^h[1-6]$/.test(host.name) ||
        headingAs(host) ||
        literal(host, "role") === "heading" ||
        isHelper(host)
    )
    // A legacy heading gets one literal/as host, not a second host inside its
    // canonical outline wrapper. Roles and manual helper depth have no legacy
    // exception. Every visible construct is inspected before contract returns.
    const legacy =
      !strictNewCreation &&
      resolution.state === "resolved" &&
      resolution.legacyHeading &&
      headingHosts.length === 1
    const report = (detail: string) =>
      failures.push(`${label} renderer heading policy: ${detail}`)
    for (const host of hosts) {
      if (/^h[1-6]$/.test(host.name) && !legacy) {
        report("field output cannot be wrapped by a literal heading element.")
      }
      const as = headingAs(host)
      if (as && !legacy) {
        report(
          `<${host.name}> must not set as="${as}"; heading semantics are owned by the outline.`
        )
      }
      if (literal(host, "role") === "heading") {
        report(`field output cannot use role="heading" on <${host.name}>.`)
      }
      if (
        ["RichText", "RichTextContent", "Text", "KitImage"].includes(
          host.name
        ) &&
        jsxAttribute(host.attributes, "headingLevel")
      ) {
        report(
          "fields must not set headingLevel; heading levels are owned by the outline."
        )
      }
      if (isHelper(host) && !outlineOwns(host, access, resolution)) {
        report(
          `<${host.name}> must use fieldHeadingLevel(ctx.outline, matching declared heading path).`
        )
      }
    }
    if (resolution.state === "unresolved") {
      if (strictNewCreation && componentName) {
        failures.push(
          `${label} unresolved governed field binding in <${componentName}>.`
        )
      }
      return
    }
    const isTitle = resolution.contract === "title"
    if (isTitle && componentName !== "RichText") {
      failures.push(`${label} title fields must render with kit <RichText>.`)
    }
    if (isTitle && attributes && jsxAttribute(attributes, "host")) {
      const host = strictLiteralAttribute(attributes, "host")
      const accordionSlot =
        host?.value === "inline" &&
        !host.encoded &&
        resolution.inlineTitleHost === "accordion-row" &&
        isAccordionTitleSlot(node, access)
      if (
        !accordionSlot &&
        (!host || host.encoded || host.value !== "native")
      ) {
        failures.push(
          `${label} title fields must use the literal native heading host.`
        )
      }
    }
    if (
      isTitle &&
      ancestors.some((ancestor) =>
        ["button", "a", "Link", "Button"].includes(ancestor.name)
      )
    ) {
      failures.push(
        `${label} title fields cannot be nested inside button or link elements.`
      )
    }
  }

  const visit = (
    node: ts.Node,
    ancestors: Host[],
    aliases: ReadonlyMap<string, RendererHeadingFieldAccess>,
    renderedOutput: boolean
  ) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node
      const name = jsxName(opening.tagName)
      const attributes = jsxAttributes(opening)
      const binding = governedFieldBindingFromJsx(name, attributes, aliases)
      const access = binding.state === "resolved" ? binding.access : null
      if (binding.state === "unresolved" && strictNewCreation) {
        failures.push(`unresolved governed field binding in <${name}>.`)
      } else if (access) {
        inspectAccess(access, ancestors, name, attributes, node)
      }
      if (strictNewCreation && /^h[1-6]$/.test(name)) {
        failures.push(
          `<${name}> literal heading element is not permitted for new Slice creation.`
        )
      }

      for (const property of attributes.properties) {
        if (ts.isJsxAttribute(property)) {
          const initializer = property.initializer
          if (initializer) {
            const isChildren = property.name.getText() === "children"
            if (ts.isJsxExpression(initializer)) {
              if (initializer.expression) {
                visit(
                  initializer.expression,
                  [...ancestors, { name, attributes }],
                  aliases,
                  isChildren
                )
              }
            } else {
              visit(
                initializer,
                [...ancestors, { name, attributes }],
                aliases,
                isChildren
              )
            }
          }
        } else {
          visit(
            property.expression,
            [...ancestors, { name, attributes }],
            aliases,
            false
          )
        }
      }

      if (ts.isJsxElement(node)) {
        for (const child of node.children) {
          visit(child, [...ancestors, { name, attributes }], aliases, true)
        }
      }
      return
    }

    if (ts.isJsxFragment(node)) {
      for (const child of node.children) visit(child, ancestors, aliases, true)
      return
    }

    if (ts.isJsxExpression(node)) {
      if (node.expression) visit(node.expression, ancestors, aliases, true)
      return
    }

    if (renderedOutput) {
      const access = accessFromExpression(
        ts.isExpression(node) ? node : undefined,
        aliases
      )
      if (access) {
        inspectAccess(access, ancestors)
        // A member access renders its value, not its receiver as a second
        // independent field output (primary.heading does not render primary).
        return
      }
    }

    if (ts.isConditionalExpression(node)) {
      visit(node.condition, ancestors, aliases, false)
      visit(node.whenTrue, ancestors, aliases, renderedOutput)
      visit(node.whenFalse, ancestors, aliases, renderedOutput)
      return
    }

    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const leftIsOutput = operator !== ts.SyntaxKind.AmpersandAmpersandToken
        visit(node.left, ancestors, aliases, leftIsOutput && renderedOutput)
        visit(node.right, ancestors, aliases, renderedOutput)
        return
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression)
      if (
        callee &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "map"
      ) {
        const listAccess = accessFromExpression(callee.expression, aliases)
        visit(callee.expression, ancestors, aliases, false)
        const callback = node.arguments[0]
        const callbackExpression = callback && unwrapExpression(callback)
        if (
          callbackExpression &&
          (ts.isArrowFunction(callbackExpression) ||
            ts.isFunctionExpression(callbackExpression))
        ) {
          for (const parameter of callbackExpression.parameters) {
            visit(parameter, ancestors, aliases, false)
          }
          const firstParameter = callbackExpression.parameters[0]?.name
          const nestedAliases = new Map(aliases)
          if (listAccess && firstParameter && ts.isIdentifier(firstParameter)) {
            nestedAliases.set(firstParameter.text, listAccess)
          }
          visit(
            callbackExpression.body,
            ancestors,
            nestedAliases,
            renderedOutput
          )
        } else if (callback) {
          visit(callback, ancestors, aliases, false)
        }
        for (const argument of node.arguments.slice(1)) {
          visit(argument, ancestors, aliases, false)
        }
        return
      }
      visit(node.expression, ancestors, aliases, false)
      for (const argument of node.arguments) {
        visit(argument, ancestors, aliases, false)
      }
      return
    }

    ts.forEachChild(node, (child) =>
      visit(child, ancestors, aliases, renderedOutput)
    )
  }

  visit(file, [], new Map(), false)
  return [...new Set(failures)]
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/[^\n]*/g, "")
}

function fieldAccess(component: string): RendererHeadingFieldAccess | null {
  const tag = component.match(/^<(RichText|RichTextContent)\b/)?.[1]
  let root: RendererHeadingFieldAccess["root"]
  let path: string
  if (tag === "RichTextContent") {
    const match = component.match(FIELD_VALUE_RE)
    if (!match) return null
    root =
      match[1] === "primary" || match[1] === "slice.primary"
        ? "primary"
        : "item"
    path = match[2].replaceAll("?.", ".")
  } else if (tag === "RichText") {
    const match = component.match(
      /\bfieldPath\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*`([^`]+)`\s*\})/
    )
    const rawPath =
      match?.[1] ?? match?.[2] ?? match?.[3]?.replace(/\$\{[^}]+\}/g, "0")
    if (!rawPath) return null
    const normalized = rawPath.replaceAll("?.", ".")
    if (normalized.startsWith("primary.")) {
      root = "primary"
      path = normalized.slice("primary.".length)
    } else if (normalized.startsWith("items[")) {
      root = "item"
      path = normalized.replace(/^items\[[^\]]+\]\.?/, "")
    } else if (normalized.startsWith("items.")) {
      root = "item"
      path = normalized.slice("items.".length)
    } else {
      return null
    }
  } else {
    return null
  }

  return {
    root,
    path: path.split(".").filter(Boolean),
  }
}

export function validateRendererHeadings(
  source: string,
  isInlineRichTextField?: IsInlineRichTextField
): string[] {
  const failures: string[] = []
  const code = withoutComments(source)

  for (const match of code.matchAll(HEADING_RE)) {
    const level = match[1]
    const body = match[2] ?? ""
    const components = [...body.matchAll(RICH_TEXT_COMPONENT_RE)]
      .map((componentMatch) => componentMatch[0])
      .filter(
        (component) =>
          /^<RichText\b/.test(component) || INLINE_PROFILE_RE.test(component)
      )

    if (components.length === 0) {
      failures.push(
        `<h${level}> must render an inline rich-text field with <RichTextContent profile="inline" />`
      )
      continue
    }

    const access = components.map(fieldAccess).find(Boolean)
    if (!access) {
      failures.push(
        `<h${level}> must bind <RichTextContent profile="inline" /> to a primary or item field`
      )
      continue
    }

    if (isInlineRichTextField && !isInlineRichTextField(access)) {
      failures.push(
        `<h${level}> field ${access.root}.${access.path.join(".")} must be richText(profile: "inline") in the slice descriptor`
      )
    }
  }

  for (const match of code.matchAll(KIT_HEADING_RE)) {
    const tag = match[1]
    const level = match[3]
    const component = match[0]
    if (tag === "Text") {
      failures.push(
        `<${level}> must render an inline rich-text field with <RichText fields={fields} />`
      )
      continue
    }
    const access = fieldAccess(component)
    if (!access) {
      failures.push(
        `<${level}> must bind <RichText as="${level}"> to a descriptor field`
      )
      continue
    }
    if (isInlineRichTextField && !isInlineRichTextField(access)) {
      failures.push(
        `<${level}> field ${access.root}.${access.path.join(".")} must be richText(profile: "inline") in the slice descriptor`
      )
    }
  }

  return failures
}
