import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

export const R1_LITERAL_CATEGORIES = [
  "jsx-text",
  "named-string-prop",
  "tooltip-content",
  "toast-argument",
  "validation-message",
  "conditional-label",
  "raw-error-message",
  "helper-return-label",
  "object-default",
  "implicit-locale-format",
] as const

export type R1LiteralCategory = (typeof R1_LITERAL_CATEGORIES)[number]

export type R1ShippedFile = {
  /** File whose bytes are scanned in this tree. */
  sourcePath: string
  /** Path those bytes occupy in the generated application. */
  shippedPath: string
}

export type R1LiteralFinding = {
  category: R1LiteralCategory
  path: string
  line: number
  column: number
  literal: string
}

export type R1LiteralAllowlistEntry = {
  literal: string
  reason: string
  categories?: R1LiteralCategory[]
  paths?: string[]
}

export type R1LiteralInventory = {
  files: R1ShippedFile[]
  findings: R1LiteralFinding[]
  allowed: Array<{
    finding: R1LiteralFinding
    entry: R1LiteralAllowlistEntry
  }>
}

type R1LiteralConfig = {
  shippedFiles: string[]
  entries: R1LiteralAllowlistEntry[]
}

const R1_SOURCE_PREFIXES = [
  "app/(core)/",
  "app/(live-preview)/admin/",
  "components/admin/",
  "components/auth/",
  "components/setup/",
  "components/edition/",
  "app/(public)/",
  "components/public/",
  "components/content-types/",
  "components/slices/",
] as const

const NAMED_STRING_PROPS = new Set([
  "label",
  "description",
  "title",
  "placeholder",
  "alt",
])

const VALIDATION_MESSAGE_PROPS = new Set([
  "message",
  "error",
  "required_error",
  "invalid_type_error",
])

const VALIDATION_METHODS = new Set([
  "email",
  "endsWith",
  "includes",
  "length",
  "max",
  "min",
  "nonempty",
  "regex",
  "refine",
  "startsWith",
  "superRefine",
  "url",
  "uuid",
])

const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
])

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/")
}

export function isR1LiteralSource(path: string): boolean {
  const normalized = normalizedPath(path)
  return (
    (R1_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
      [
        "components/ui/dialog.tsx",
        "components/ui/sheet.tsx",
        "components/development-instance-badge.tsx",
      ].includes(normalized)) &&
    /\.(?:ts|tsx)$/.test(normalized) &&
    !/\.d\.ts$/.test(normalized) &&
    !/\.(?:test|spec)\.(?:ts|tsx)$/.test(normalized) &&
    !/\.sourceInventory\.(?:ts|tsx)$/.test(normalized)
  )
}

/**
 * Resolve the reviewed runtime inventory. The source-only projection test
 * keeps this list equal to the canonical release selector. Overlay bytes are
 * read from their source twin in the engine and from the projected target in
 * a generated application, so this shipped test never reads a private path.
 */
export function discoverR1ShippedFiles(
  root: string,
  selectedTargets?: ReadonlySet<string>
): R1ShippedFile[] {
  const config = readJson<R1LiteralConfig>(
    join(root, "i18n/admin-literal-allowlist.json")
  )
  if (selectedTargets) {
    const frozen = new Set(config.shippedFiles)
    for (const target of selectedTargets) {
      if (!frozen.has(target))
        throw new Error(`R1 inventory omits selected shipped path: ${target}`)
    }
    for (const target of frozen) {
      if (!selectedTargets.has(target))
        throw new Error(`R1 inventory contains a non-shipped path: ${target}`)
    }
  }
  return config.shippedFiles.map((shippedPath) => {
    if (!isR1LiteralSource(shippedPath)) {
      throw new Error(
        `R1 inventory contains an out-of-scope path: ${shippedPath}`
      )
    }
    const overlayPath = normalizedPath(
      join("scripts/starter/overlay", shippedPath)
    )
    const sourcePath = existsSync(join(root, overlayPath))
      ? overlayPath
      : shippedPath
    if (!existsSync(join(root, sourcePath))) {
      throw new Error(`R1 shipped source is absent: ${shippedPath}`)
    }
    return { sourcePath, shippedPath }
  })
}

function normalizeLiteral(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function decodeJsxEntities(value: string): string {
  const punctuation: Record<string, string> = {
    copy: "©",
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  }
  return value.replace(
    /&(?:(#[xX][\da-fA-F]+|#\d+)|(copy|nbsp|amp|lt|gt|quot|apos));/g,
    (match, numeric: string | undefined, named: string | undefined) => {
      if (named) return punctuation[named]
      const code =
        numeric?.[1]?.toLowerCase() === "x"
          ? Number.parseInt(numeric.slice(2), 16)
          : Number.parseInt(numeric?.slice(1) ?? "", 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
  )
}

function containsLetter(value: string): boolean {
  return /\p{L}/u.test(value)
}

function templateText(node: ts.TemplateExpression): string {
  let text = node.head.text
  for (const span of node.templateSpans) {
    text += "${…}"
    text += span.literal.text
  }
  return text
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return templateText(node)
  return null
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
  return null
}

function jsxTagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText()
}

function insideTooltipContent(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current)) {
      const name = jsxTagName(current.openingElement)
      if (name.endsWith("TooltipContent")) return true
    }
    if (ts.isSourceFile(current)) return false
  }
  return false
}

function isConditionalExpression(node: ts.Node): boolean {
  if (ts.isConditionalExpression(node)) return true
  return (
    ts.isBinaryExpression(node) &&
    LOGICAL_OPERATORS.has(node.operatorToken.kind)
  )
}

function expressionLiterals(node: ts.Node): ts.Node[] {
  if (literalText(node) !== null) return [node]
  if (ts.isParenthesizedExpression(node)) {
    return expressionLiterals(node.expression)
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return expressionLiterals(node.expression)
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...expressionLiterals(node.whenTrue),
      ...expressionLiterals(node.whenFalse),
    ]
  }
  if (
    ts.isBinaryExpression(node) &&
    LOGICAL_OPERATORS.has(node.operatorToken.kind)
  ) {
    return [...expressionLiterals(node.left), ...expressionLiterals(node.right)]
  }
  return []
}

function argumentLiterals(node: ts.Node): ts.Node[] {
  if (literalText(node) !== null) return [node]
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return argumentLiterals(node.expression)
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...argumentLiterals(node.whenTrue),
      ...argumentLiterals(node.whenFalse),
    ]
  }
  if (ts.isBinaryExpression(node)) {
    return [...argumentLiterals(node.left), ...argumentLiterals(node.right)]
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(argumentLiterals)
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)
      ) {
        return ts.isPropertyAssignment(property)
          ? argumentLiterals(property.initializer)
          : []
      }
      return []
    })
  }
  return []
}

function isToastCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) return node.expression.text === "toast"
  if (ts.isPropertyAccessExpression(node.expression)) {
    return (
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "toast"
    )
  }
  if (ts.isElementAccessExpression(node.expression)) {
    return (
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "toast"
    )
  }
  return false
}

function isZodChain(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "z"
  if (ts.isPropertyAccessExpression(node)) return isZodChain(node.expression)
  if (ts.isCallExpression(node)) return isZodChain(node.expression)
  return false
}

export function scanR1Source(
  sourceText: string,
  shippedPath: string
): R1LiteralFinding[] {
  const source = ts.createSourceFile(
    shippedPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    shippedPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const findings: R1LiteralFinding[] = []
  const seen = new Set<string>()

  function add(
    node: ts.Node,
    rawLiteral: string,
    category: R1LiteralCategory
  ): void {
    const literal = normalizeLiteral(rawLiteral)
    if (!literal || !containsLetter(literal)) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    const finding = {
      category,
      path: shippedPath,
      line: position.line + 1,
      column: position.character + 1,
      literal,
    }
    const identity = [
      finding.category,
      finding.path,
      finding.line,
      finding.column,
      finding.literal,
    ].join("\0")
    if (seen.has(identity)) return
    seen.add(identity)
    findings.push(finding)
  }

  function addExpression(
    node: ts.Expression,
    directCategory: R1LiteralCategory
  ): void {
    const category = isConditionalExpression(node)
      ? "conditional-label"
      : directCategory
    for (const literal of expressionLiterals(node)) {
      const text = literalText(literal)
      if (text !== null) add(literal, text, category)
    }
  }

  // Resolve same-file lexical bindings only. This adds UI-flow checks without
  // interpreting diagnostics, protocol strings, or untranslated imported data
  // as UI copy merely because they happen to contain English.
  const scopes = new Map<ts.Node, Map<string, ts.Node>>()
  const translationFactories = new Set<string>()
  const stateSetters = new Map<ts.Node, Map<string, string>>()

  function enclosingScope(node: ts.Node): ts.Node {
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isBlock(current) ||
        ts.isSourceFile(current) ||
        ts.isFunctionLike(current)
      )
        return current
    }
    return source
  }

  function bind(node: ts.Node, name: string, value: ts.Node): void {
    const scope = enclosingScope(node)
    const names = scopes.get(scope) ?? new Map<string, ts.Node>()
    names.set(name, value)
    scopes.set(scope, names)
  }

  function lookup(node: ts.Node, name: string): ts.Node | undefined {
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    ) {
      const value = scopes.get(current)?.get(name)
      if (value) return value
    }
    return undefined
  }

  function indexBindings(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const binding of node.importClause.namedBindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text
        if (
          (node.moduleSpecifier.text === "next-intl" &&
            imported === "useTranslations") ||
          (node.moduleSpecifier.text === "@/lib/i18n/use-caught-error" &&
            imported === "useCaughtError")
        )
          translationFactories.add(binding.name.text)
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name))
        bind(node, node.name.text, node.initializer)
      if (
        ts.isArrayBindingPattern(node.name) &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(source) === "useState"
      ) {
        const [value, setter] = node.name.elements
        if (
          value &&
          ts.isBindingElement(value) &&
          ts.isIdentifier(value.name) &&
          setter &&
          ts.isBindingElement(setter) &&
          ts.isIdentifier(setter.name)
        ) {
          const scope = enclosingScope(node)
          const names = stateSetters.get(scope) ?? new Map<string, string>()
          names.set(setter.name.text, value.name.text)
          stateSetters.set(scope, names)
          if (node.initializer.arguments[0])
            bind(node, value.name.text, node.initializer.arguments[0])
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name)
      bind(node, node.name.text, node)
    if (ts.isParameter(node) && ts.isIdentifier(node.name))
      bind(node, node.name.text, node)
    ts.forEachChild(node, indexBindings)
  }
  indexBindings(source)

  function messageProperty(
    node: ts.Node
  ): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
    return (
      (ts.isPropertyAccessExpression(node) && node.name.text === "message") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "message")
    )
  }

  function returns(fn: ts.Node): ts.Expression[] {
    if (
      !ts.isFunctionDeclaration(fn) &&
      !ts.isFunctionExpression(fn) &&
      !ts.isArrowFunction(fn)
    )
      return []
    if (fn.body && !ts.isBlock(fn.body)) return [fn.body]
    const result: ts.Expression[] = []
    function walk(node: ts.Node): void {
      if (node !== fn && ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node) && node.expression)
        result.push(node.expression)
      ts.forEachChild(node, walk)
    }
    if (fn.body) walk(fn.body)
    return result
  }

  function objectProperty(
    node: ts.Node,
    name: string
  ): ts.Expression | undefined {
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return objectProperty(node.expression, name)
    if (!ts.isObjectLiteralExpression(node)) return undefined
    const property = node.properties.find(
      (item) =>
        ts.isPropertyAssignment(item) && propertyName(item.name) === name
    )
    return property && ts.isPropertyAssignment(property)
      ? property.initializer
      : undefined
  }

  function rawMessageIn(node: ts.Node, trail = new Set<ts.Node>()): boolean {
    if (trail.has(node)) return false
    const next = new Set(trail).add(node)
    if (messageProperty(node)) {
      return !(
        ts.isCallExpression(node.parent) && node.parent.expression === node
      )
    }
    if (ts.isIdentifier(node)) {
      const value = lookup(node, node.text)
      return Boolean(
        value && !ts.isParameter(value) && rawMessageIn(value, next)
      )
    }
    if (ts.isConditionalExpression(node))
      return (
        rawMessageIn(node.whenTrue, next) || rawMessageIn(node.whenFalse, next)
      )
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return rawMessageIn(node.right, next)
      if (
        LOGICAL_OPERATORS.has(node.operatorToken.kind) ||
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
        return rawMessageIn(node.left, next) || rawMessageIn(node.right, next)
      return false
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    )
      return returns(node).some((output) => rawMessageIn(output, next))
    let found = false
    ts.forEachChild(node, (child) => {
      if (rawMessageIn(child, next)) found = true
    })
    return found
  }

  function translatedFormMessage(node: ts.Node): boolean {
    if (
      !messageProperty(node) ||
      !/\.formState\.errors\./.test(node.getText(source))
    )
      return false
    const root = node.expression.getText(source).split(".")[0]
    let writes = 0
    let unsafe = false
    function walk(current: ts.Node): void {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === "setError" &&
        current.expression.expression.getText(source) === root
      ) {
        writes++
        if (current.arguments.some((argument) => rawMessageIn(argument)))
          unsafe = true
      }
      ts.forEachChild(current, walk)
    }
    walk(source)
    // Validation messages from a translated Zod schema are also form-owned.
    const form = lookup(node, root)
    const schemaForm =
      form &&
      ts.isCallExpression(form) &&
      form.expression.getText(source) === "useForm" &&
      form.arguments.some((argument) =>
        argument.getText(source).includes("zodResolver(")
      )
    return !unsafe && (writes > 0 || Boolean(schemaForm))
  }

  function provenTranslated(
    node: ts.Node,
    trail = new Set<ts.Node>()
  ): boolean {
    if (trail.has(node)) return false
    const next = new Set(trail).add(node)
    if (ts.isIdentifier(node)) {
      const binding = lookup(node, node.text)
      return Boolean(binding && provenTranslated(binding, next))
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = lookup(node, node.expression.text)
      if (
        binding &&
        ts.isCallExpression(binding) &&
        ts.isIdentifier(binding.expression) &&
        translationFactories.has(binding.expression.text)
      ) {
        return !node.arguments.some((argument) => rawMessageIn(argument))
      }
    }
    if (ts.isConditionalExpression(node))
      return (
        provenTranslated(node.whenTrue, next) &&
        provenTranslated(node.whenFalse, next)
      )
    return false
  }

  function translatedComponentMessage(node: ts.Node): boolean {
    if (
      !messageProperty(node) ||
      node.expression.getText(source) !== "this.props"
    )
      return false
    let owner: ts.ClassDeclaration | undefined
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isClassDeclaration(current)) {
        owner = current
        break
      }
    }
    const name = owner?.name?.text
    if (!name) return false
    let callers = 0
    let unsafe = false
    function walk(current: ts.Node): void {
      if (
        ts.isJsxOpeningLikeElement(current) &&
        current.tagName.getText(source) === name
      ) {
        const prop = current.attributes.properties.find(
          (item) =>
            ts.isJsxAttribute(item) && item.name.getText(source) === "message"
        )
        callers++
        if (
          !prop ||
          !ts.isJsxAttribute(prop) ||
          !prop.initializer ||
          !ts.isJsxExpression(prop.initializer) ||
          !prop.initializer.expression ||
          !provenTranslated(prop.initializer.expression)
        )
          unsafe = true
      }
      ts.forEachChild(current, walk)
    }
    walk(source)
    return callers > 0 && !unsafe
  }

  function traceVisible(
    node: ts.Node,
    errorSink = false,
    trail = new Set<ts.Node>(),
    fromBinding = false,
    parameters = new Map<ts.Node, ts.Node>()
  ): void {
    if (trail.has(node)) return
    const next = new Set(trail).add(node)
    if (ts.isTemplateExpression(node)) {
      if (fromBinding) add(node, templateText(node), "helper-return-label")
      for (const span of node.templateSpans)
        traceVisible(span.expression, errorSink, next, fromBinding, parameters)
      return
    }
    if (literalText(node) !== null) {
      if (fromBinding) add(node, literalText(node)!, "helper-return-label")
      return
    }
    if (ts.isIdentifier(node)) {
      const binding = lookup(node, node.text)
      if (binding) {
        const value = ts.isParameter(binding)
          ? parameters.get(binding)
          : binding
        if (value) traceVisible(value, errorSink, next, true, parameters)
      }
      return
    }
    if (messageProperty(node)) {
      if (!translatedFormMessage(node) && !translatedComponentMessage(node))
        add(node, node.getText(source), "raw-error-message")
      return
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      traceVisible(node.expression, errorSink, next, fromBinding, parameters)
      return
    }
    if (ts.isConditionalExpression(node)) {
      traceVisible(node.whenTrue, errorSink, next, fromBinding, parameters)
      traceVisible(node.whenFalse, errorSink, next, fromBinding, parameters)
      return
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        traceVisible(node.right, errorSink, next, fromBinding, parameters)
      else if (
        LOGICAL_OPERATORS.has(node.operatorToken.kind) ||
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        traceVisible(node.left, errorSink, next, fromBinding, parameters)
        traceVisible(node.right, errorSink, next, fromBinding, parameters)
      }
      return
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null
      const binding = ts.isIdentifier(node.expression)
        ? lookup(node, node.expression.text)
        : undefined
      const value = binding && name ? objectProperty(binding, name) : undefined
      if (value) traceVisible(value, errorSink, next, true, parameters)
      return
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ["toFixed", "toPrecision"].includes(node.expression.name.text)
      )
        add(node, node.expression.getText(source), "implicit-locale-format")
      const binding = ts.isIdentifier(node.expression)
        ? lookup(node, node.expression.text)
        : undefined
      const outputs = binding ? returns(binding) : []
      if (
        outputs.length &&
        binding &&
        (ts.isFunctionDeclaration(binding) ||
          ts.isFunctionExpression(binding) ||
          ts.isArrowFunction(binding))
      ) {
        const values = new Map(parameters)
        for (let index = 0; index < binding.parameters.length; index++) {
          const parameter = binding.parameters[index]
          const value = node.arguments[index] ?? parameter.initializer
          if (value) values.set(parameter, value)
        }
        for (const output of outputs)
          traceVisible(output, errorSink, next, true, values)
      } else {
        // Imported translators/sanitizers own their outputs. Inspect only raw
        // message arguments for passthrough, not their keys or format options.
        for (const argument of node.arguments)
          if (rawMessageIn(argument))
            traceVisible(argument, errorSink, next, false, parameters)
      }
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property))
          traceVisible(
            property.initializer,
            errorSink,
            next,
            fromBinding,
            parameters
          )
        if (ts.isShorthandPropertyAssignment(property))
          traceVisible(property.name, errorSink, next, true, parameters)
      }
      return
    }
  }

  function isErrorStateCall(node: ts.CallExpression): boolean {
    if (ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (/^set.*Error(?:State)?$/.test(name) || name === "setError")
        return true
      for (
        let current: ts.Node | undefined = node;
        current;
        current = current.parent
      )
        if (stateSetters.get(current)?.has(name)) return true
    }
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setError"
    )
  }

  function isImplicitLocaleFormat(
    node: ts.CallExpression | ts.NewExpression
  ): boolean {
    const expression = node.expression
    const dateOrNumber =
      ts.isPropertyAccessExpression(expression) &&
      ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].includes(
        expression.name.text
      )
    const intl =
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "Intl" &&
      ["NumberFormat", "DateTimeFormat"].includes(expression.name.text)
    if (!dateOrNumber && !intl) return false
    // An inline console diagnostic isn't a presentation formatter.
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) &&
        current.expression.expression.text === "console"
      )
        return false
      if (ts.isStatement(current)) break
    }
    // Asking the host for its timezone formats no visible date or number.
    if (
      intl &&
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name.text === "resolvedOptions"
    )
      return false
    const locale = node.arguments?.[0]
    return (
      !locale ||
      (ts.isIdentifier(locale) && locale.text === "undefined") ||
      locale.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(locale) ||
      (ts.isArrayLiteralExpression(locale) && locale.elements.length === 0)
    )
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      add(
        node,
        decodeJsxEntities(node.getText(source)),
        insideTooltipContent(node) ? "tooltip-content" : "jsx-text"
      )
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      const tooltip =
        name === "tooltip" ||
        (name === "content" &&
          ts.isJsxOpeningLikeElement(node.parent) &&
          jsxTagName(node.parent).includes("Tooltip"))
      const named =
        tooltip || NAMED_STRING_PROPS.has(name) || name.startsWith("aria-")
      // aria-live values select announcement behavior; they are not UI copy.
      const liveRegionProtocol =
        name === "aria-live" &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        ["off", "polite", "assertive"].includes(node.initializer.text)
      if (named && node.initializer && !liveRegionProtocol) {
        const category = tooltip ? "tooltip-content" : "named-string-prop"
        if (ts.isStringLiteral(node.initializer)) {
          add(node.initializer, node.initializer.text, category)
        } else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression
        ) {
          addExpression(node.initializer.expression, category)
          if (
            ![
              "aria-labelledby",
              "aria-describedby",
              "aria-controls",
              "aria-owns",
              "aria-activedescendant",
            ].includes(name)
          )
            traceVisible(node.initializer.expression)
        }
      }
    }

    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      !ts.isJsxAttribute(node.parent)
    ) {
      addExpression(
        node.expression,
        insideTooltipContent(node) ? "tooltip-content" : "conditional-label"
      )
      traceVisible(node.expression)
    }

    if (
      ts.isCallExpression(node) &&
      (isToastCall(node) || isErrorStateCall(node))
    ) {
      for (const argument of node.arguments) traceVisible(argument, true)
    }

    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      isImplicitLocaleFormat(node)
    ) {
      add(node, node.expression.getText(source), "implicit-locale-format")
    }

    if (ts.isCallExpression(node) && isToastCall(node)) {
      for (const argument of node.arguments) {
        for (const literal of argumentLiterals(argument)) {
          const text = literalText(literal)
          if (text !== null) add(literal, text, "toast-argument")
        }
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name && NAMED_STRING_PROPS.has(name)) {
        for (const literal of expressionLiterals(node.initializer)) {
          const text = literalText(literal)
          if (text !== null) add(literal, text, "object-default")
        }
      }
      if (name && VALIDATION_MESSAGE_PROPS.has(name)) {
        for (const literal of argumentLiterals(node.initializer)) {
          const text = literalText(literal)
          if (text !== null) add(literal, text, "validation-message")
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      VALIDATION_METHODS.has(node.expression.name.text) &&
      (isZodChain(node.expression.expression) ||
        node.expression.name.text === "refine" ||
        node.expression.name.text === "superRefine")
    ) {
      for (const argument of node.arguments) {
        const text = literalText(argument)
        if (text !== null) add(argument, text, "validation-message")
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings.sort(compareFindings)
}

function compareFindings(a: R1LiteralFinding, b: R1LiteralFinding): number {
  return (
    R1_LITERAL_CATEGORIES.indexOf(a.category) -
      R1_LITERAL_CATEGORIES.indexOf(b.category) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.column - b.column ||
    a.literal.localeCompare(b.literal)
  )
}

function allowlisted(
  finding: R1LiteralFinding,
  entry: R1LiteralAllowlistEntry
): boolean {
  return (
    finding.literal === entry.literal &&
    (!entry.categories || entry.categories.includes(finding.category)) &&
    (!entry.paths || entry.paths.includes(finding.path))
  )
}

export function readR1LiteralAllowlist(
  root: string
): R1LiteralAllowlistEntry[] {
  const payload = readJson<R1LiteralConfig>(
    join(root, "i18n/admin-literal-allowlist.json")
  )
  for (const entry of payload.entries) {
    if (!entry.literal.trim() || !entry.reason.trim()) {
      throw new Error(
        "Every R1 literal allowlist entry needs a literal and reason"
      )
    }
  }
  return payload.entries
}

export function scanR1LiteralInventory(
  root: string,
  allowlist = readR1LiteralAllowlist(root)
): R1LiteralInventory {
  const files = discoverR1ShippedFiles(root)
  const allFindings = files.flatMap((file) =>
    scanR1Source(
      readFileSync(join(root, file.sourcePath), "utf8"),
      file.shippedPath
    )
  )
  const findings: R1LiteralFinding[] = []
  const allowed: R1LiteralInventory["allowed"] = []

  for (const finding of allFindings) {
    const entry = allowlist.find((candidate) => allowlisted(finding, candidate))
    if (entry) allowed.push({ finding, entry })
    else findings.push(finding)
  }

  return {
    files,
    findings: findings.sort(compareFindings),
    allowed,
  }
}

export function formatR1LiteralInventory(
  inventory: R1LiteralInventory
): string {
  const categoryTotals = R1_LITERAL_CATEGORIES.map((category) => {
    const count = inventory.findings.filter(
      (finding) => finding.category === category
    ).length
    return `${category}=${count}`
  }).join(", ")
  const lines = [
    `R1 literal ratchet RED: ${inventory.findings.length} unallowlisted literal(s) in ${inventory.files.length} shipped runtime file(s).`,
    `Allowlisted brand/code occurrence(s): ${inventory.allowed.length}.`,
    `Covered categories: ${R1_LITERAL_CATEGORIES.join(", ")}.`,
    `Category totals: ${categoryTotals}.`,
  ]

  for (const category of R1_LITERAL_CATEGORIES) {
    const findings = inventory.findings.filter(
      (finding) => finding.category === category
    )
    lines.push("", `${category} (${findings.length})`)
    for (const finding of findings) {
      lines.push(
        `- ${finding.path}:${finding.line}:${finding.column} ${JSON.stringify(finding.literal)}`
      )
    }
  }

  return lines.join("\n")
}
