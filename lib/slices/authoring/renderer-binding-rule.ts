import ts from "typescript"
import type { Primitive } from "@/convex/lib/slices/primitives"
import {
  COVERAGE_MIGRATION_PENDING,
  coveragePattern,
  fieldCoverageInventory,
  isButtonDefinition,
  type CoverageDescriptor,
} from "./field-coverage"
import { toCamel } from "./naming"

const KIT = new Map([
  ["Text", "text"],
  ["RichText", "richText"],
  ["KitImage", "image"],
  ["Buttons", "list"],
])
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression
  return node
}
function literalExpression(expression: ts.Expression): boolean {
  const node = unwrap(expression)
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    [
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword,
    ].includes(node.kind) ||
    (ts.isPrefixUnaryExpression(node) &&
      [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
        node.operator
      ) &&
      ts.isNumericLiteral(unwrap(node.operand)))
  )
}
function containsJsx(node: ts.Node): boolean {
  if (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node)
  )
    return true
  return ts.forEachChild(node, containsJsx) === true
}

/** Finite source recognition, not JavaScript dataflow analysis. Imports, simple
 * const aliases/destructuring, and direct array.map row/index aliases are the
 * supported authoring seam. Unknown binding origins refuse before writes. */
export function validateRendererBindings(
  source: string,
  type: string,
  descriptor: CoverageDescriptor,
  factory = false,
  sourceTarget?: string
): string[] {
  const file = ts.createSourceFile(
    "renderer.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const inventory = fieldCoverageInventory(type, descriptor)
  if (!factory && inventory.every((field) => field.status === "legacy"))
    return []
  const failures = new Set<string>()
  const fail = (text: string) => failures.add(`field coverage ${type}: ${text}`)
  type MapBinding = { list: string; callback: ts.Node }
  type Binding = {
    origin?: string
    kit?: string
    index?: MapBinding
    derived?: string[]
    // Syntax references only: never infer field provenance from these.
    initializer?: ts.Expression
    component?: string
  }
  type Environment = { parent?: Environment; bindings: Map<string, Binding> }
  const root: Environment = { bindings: new Map() }
  const environments = new WeakMap<ts.Node, Environment>()
  const maps = new Map<ts.Node, MapBinding>()
  const importedNames = new Set<string>()
  const declarations: { name: string; environment: Environment }[] = []
  const bound = new Set<string>()
  const descriptorName = `${toCamel(type)}Def`
  const visit = (node: ts.Node, cb: (node: ts.Node) => void) => {
    cb(node)
    ts.forEachChild(node, (child) => visit(child, cb))
  }
  const scope = (node: ts.Node): Environment => environments.get(node) ?? root
  const declare = (name: ts.BindingName, environment: Environment) => {
    if (ts.isIdentifier(name)) {
      environment.bindings.set(name.text, {})
      declarations.push({ name: name.text, environment })
    } else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) declare(element.name, environment)
  }
  const assignScopes = (node: ts.Node, inherited: Environment) => {
    const environment =
      ts.isFunctionLike(node) || ts.isBlock(node)
        ? { parent: inherited, bindings: new Map<string, Binding>() }
        : inherited
    environments.set(node, environment)
    if (ts.isVariableDeclaration(node) || ts.isParameter(node))
      declare(node.name, environment)
    ts.forEachChild(node, (child) => assignScopes(child, environment))
  }
  assignScopes(file, root)
  visit(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    )
      scope(node).bindings.get(node.name.text)!.initializer = node.initializer
  })
  const lookup = (name: string, node: ts.Node): Binding | undefined => {
    let environment: Environment | undefined = scope(node)
    while (environment) {
      // An unknown local masks inherited provenance, including index/derived data.
      if (environment.bindings.has(name)) return environment.bindings.get(name)
      environment = environment.parent
    }
    return undefined
  }
  const local = (name: string, node: ts.Node): Binding =>
    scope(node).bindings.get(name)!
  const isAncestor = (ancestor: ts.Node, node: ts.Node): boolean => {
    let current: ts.Node | undefined = node
    while (current && current !== ancestor) current = current.parent
    return current === ancestor
  }
  visit(file, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    ) {
      const parameter = node.parameters[0]?.name
      if (parameter && ts.isObjectBindingPattern(parameter))
        for (const element of parameter.elements) {
          const key =
            element.propertyName?.getText(file) ?? element.name.getText(file)
          if (
            ts.isIdentifier(element.name) &&
            (key === "slice" || key === "ctx")
          )
            local(element.name.text, node).origin =
              key === "slice" ? "" : "@context"
        }
    }
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      return
    const from = node.moduleSpecifier.text
    const bindings = node.importClause?.namedBindings
    const recognize = (name: string, component: string) => {
      root.bindings.set(name, { ...root.bindings.get(name), component })
      importedNames.add(name)
    }
    if (from === "next/link" && node.importClause?.name)
      recognize(node.importClause.name.text, "Link")
    if (bindings && ts.isNamedImports(bindings))
      for (const entry of bindings.elements) {
        const imported = entry.propertyName?.text ?? entry.name.text
        if (from === "@/components/slice-kit") {
          root.bindings.set(entry.name.text, { kit: imported })
          importedNames.add(entry.name.text)
        }
        if (
          [
            "./render-helpers",
            "../render-helpers",
            "@/components/slices/render-helpers",
          ].includes(from) &&
          [
            "RichTextContent",
            "SliceImage",
            "SliceButtons",
            "SliceIcon",
          ].includes(imported)
        )
          recognize(entry.name.text, imported)
        if (
          from === "lucide-react" &&
          ["ArrowRight", "Check"].includes(imported)
        )
          recognize(entry.name.text, "Decoration")
        if (
          type === "contact-form" &&
          from === "./contact-form-client" &&
          imported === "ContactFormClient"
        )
          recognize(entry.name.text, imported)
        if (
          type === "site-search" &&
          from === "./site-search-client" &&
          imported === "SiteSearchClient"
        )
          recognize(entry.name.text, imported)
        if (
          (from === "@/convex/lib/slices" ||
            from === `@/convex/lib/slices/${toCamel(type)}`) &&
          imported === descriptorName
        ) {
          root.bindings.set(entry.name.text, { origin: "@descriptor" })
          importedNames.add(entry.name.text)
        }
      }
    if (
      bindings &&
      ts.isNamespaceImport(bindings) &&
      from === "@/components/slice-kit"
    ) {
      root.bindings.set(bindings.name.text, { kit: "@kit" })
      importedNames.add(bindings.name.text)
    }
  })
  for (const { name } of declarations)
    if (importedNames.has(name)) fail(`shadowed kit/descriptor import ${name}`)
  const kitName = (node: ts.Node): string | undefined => {
    if (ts.isIdentifier(node)) return lookup(node.text, node)?.kit
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      lookup(node.expression.text, node)?.kit === "@kit"
    )
      return node.name.text
    return undefined
  }
  const origin = (
    expression: ts.Expression | undefined
  ): string | undefined => {
    if (!expression) return
    const node = unwrap(expression)
    if (ts.isIdentifier(node)) return lookup(node.text, node)?.origin
    if (ts.isPropertyAccessExpression(node)) {
      const base = origin(node.expression)
      if (base !== undefined && !base.startsWith("@"))
        return base ? `${base}.${node.name.text}` : node.name.text
    }
    if (ts.isElementAccessExpression(node)) {
      const base = origin(node.expression)
      const key = node.argumentExpression
      if (base !== undefined && key) {
        if (ts.isNumericLiteral(key)) return `${base}[${key.text}]`
        if (ts.isStringLiteral(key)) return `${base}.${key.text}`
        if (ts.isIdentifier(key)) {
          const index = lookup(key.text, key)?.index
          if (
            index &&
            coveragePattern(base) === index.list &&
            isAncestor(index.callback, node)
          )
            return `${base}[]`
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      kitName(node.expression) === "bindSliceFields"
    ) {
      return origin(node.arguments[0]) === "@descriptor" &&
        origin(node.arguments[1]) === ""
        ? "@fields"
        : "@wrong-fields"
    }
    return undefined
  }
  // Bounded inference uses the environment of each declaration/use. Sibling
  // callbacks never share mutable name records, even when scaffold names repeat.
  for (let pass = 0; pass < 4; pass++) {
    maps.clear()
    visit(file, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const base = origin(node.initializer)
        if (ts.isIdentifier(node.name))
          local(node.name.text, node).origin = base
        if (ts.isObjectBindingPattern(node.name) && base !== undefined)
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name) || element.dotDotDotToken)
              continue
            const key =
              element.propertyName?.getText(file).replace(/["']/g, "") ??
              element.name.text
            local(element.name.text, node).origin = base
              ? `${base}.${key}`
              : key
          }
      }
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== "map"
      )
        return
      // Resolve the receiver in its parent scope before introducing callback parameters.
      const list = origin(node.expression.expression)
      const callback = node.arguments[0]
      if (
        !list ||
        list.startsWith("@") ||
        !callback ||
        (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
      )
        return
      const record = { list: coveragePattern(list), callback }
      maps.set(callback, record)
      const row = callback.parameters[0]?.name
      const index = callback.parameters[1]?.name
      if (row && ts.isIdentifier(row))
        local(row.text, callback).origin = `${record.list}[]`
      if (index && ts.isIdentifier(index))
        local(index.text, callback).index = record
    })
  }
  const provenance = (node: ts.Expression): string[] => {
    const direct = origin(node)
    if (direct !== undefined && !direct.startsWith("@")) return [direct]
    if (ts.isIdentifier(node)) return lookup(node.text, node)?.derived ?? []
    const paths: string[] = []
    ts.forEachChild(node, (child) => {
      if (ts.isExpression(child)) paths.push(...provenance(child))
    })
    return paths
  }
  // Output positions follow the existing heading rule's precedence. A JSX
  // fallback does not make a sibling returned scalar into a bound host. Stop
  // at JSX so its props/guards remain under their own existing policies.
  const outputProvenance = (
    expression: ts.Expression,
    syntax = false,
    aliases = new Set<ts.Expression>()
  ): string[] => {
    const node = unwrap(expression)
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    )
      return []
    const output = (child: ts.Expression) =>
      outputProvenance(child, syntax, aliases)
    if (syntax && ts.isIdentifier(node)) {
      const initializer = lookup(node.text, node)?.initializer
      if (initializer && !aliases.has(initializer)) {
        const nested = new Set(aliases).add(initializer)
        outputProvenance(initializer, true, nested)
      } else if (initializer || (!origin(node) && node.text !== "undefined"))
        fail(`unsupported renderer output identifier ${node.text}`)
    }
    if (ts.isConditionalExpression(node))
      return [...output(node.whenTrue), ...output(node.whenFalse)]
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return output(node.right)
      if (
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      )
        return [...output(node.left), ...output(node.right)]
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(output)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    ) {
      const callback = node.arguments[0]
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        if (!ts.isBlock(callback.body)) return output(callback.body)
        const paths: string[] = []
        const returned = (child: ts.Node) => {
          // A nested helper owns its returns. Only this map callback's
          // returned expressions become children of the surrounding JSX.
          if (ts.isFunctionLike(child)) return
          if (ts.isReturnStatement(child)) {
            if (child.expression) paths.push(...output(child.expression))
            return
          }
          ts.forEachChild(child, returned)
        }
        returned(callback.body)
        return paths
      }
      if (syntax) fail("unsupported renderer output map callback")
      return []
    }
    if (
      syntax &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "previewKitSlice" &&
      origin(node.expression.expression) === "@context" &&
      node.arguments.length === 1
    )
      return output(node.arguments[0])
    if (syntax && ts.isSpreadElement(node))
      fail("unsupported renderer output array spread")
    if (syntax && ts.isCallExpression(node))
      fail(`unsupported renderer output call ${node.expression.getText(file)}`)
    const paths = provenance(node)
    if (
      syntax &&
      !ts.isIdentifier(node) &&
      !ts.isCallExpression(node) &&
      !literalExpression(node) &&
      !(
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        origin(node) !== undefined
      )
    )
      fail(`unsupported renderer output syntax ${ts.SyntaxKind[node.kind]}`)
    return paths
  }
  for (let pass = 0; pass < 3; pass++)
    visit(file, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        origin(node.initializer) === undefined
      ) {
        const paths = outputProvenance(node.initializer)
        local(node.name.text, node).derived = paths.length ? paths : undefined
      }
    })
  const attribute = (
    node: ts.JsxOpeningLikeElement,
    name: string
  ): ts.JsxAttribute | undefined =>
    node.attributes.properties.find(
      (attr): attr is ts.JsxAttribute =>
        ts.isJsxAttribute(attr) && attr.name.getText(file) === name
    )
  const attrExpression = (attr: ts.JsxAttribute | undefined) =>
    attr?.initializer && ts.isJsxExpression(attr.initializer)
      ? attr.initializer.expression
      : undefined
  const pathIndexes = new WeakMap<ts.Node, Set<ts.Node>>()
  const pathAt = (node: ts.JsxOpeningLikeElement): string | undefined => {
    const used = new Set<ts.Node>()
    pathIndexes.set(node, used)
    const attr = attribute(node, "fieldPath")
    const init = attr?.initializer
    if (!init) return
    if (ts.isStringLiteral(init)) return init.text
    const expr = attrExpression(attr)
    if (!expr) return
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
      return expr.text
    if (!ts.isTemplateExpression(expr)) return
    let path = expr.head.text
    for (const span of expr.templateSpans) {
      const key = span.expression
      const index = ts.isIdentifier(key)
        ? lookup(key.text, key)?.index
        : undefined
      if (
        !index ||
        !isAncestor(index.callback, node) ||
        coveragePattern(path.replace(/\[$/, "")) !== index.list
      )
        return
      used.add(index.callback)
      path += `0${span.literal.text}`
    }
    return path
  }
  const definitionAt = (path: string): Primitive | undefined => {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".")
    let field =
      parts.shift() === "primary" ? descriptor.primary : descriptor.items
    for (const part of parts) {
      if (field?.kind === "group")
        field = (field.config.fields as Record<string, Primitive>)[part]
      else if (field?.kind === "list" && /^\d+$/.test(part))
        field = field.config.item as Primitive
      else return
    }
    return field
  }
  const finiteCondition = (expression: ts.Expression): boolean => {
    const node = unwrap(expression)
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    )
      return finiteCondition(node.operand)
    const path = origin(node)
    if (
      path !== undefined &&
      inventory.some(
        (field) =>
          field.path === coveragePattern(path) && field.status === "bound"
      )
    )
      return true
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      if (
        node.expression.name.text === "isEmpty" &&
        origin(node.expression.expression) === "@fields" &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      )
        return (
          definitionAt(node.arguments[0].text)?.kind !== "group" &&
          Boolean(definitionAt(node.arguments[0].text))
        )
    }
    return false
  }
  const guardAt = (node: ts.Node) => {
    let condition: ts.Expression
    let outputs: ts.Node[]
    let navigation = false
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
      ].includes(node.operatorToken.kind) &&
      containsJsx(node.right)
    ) {
      condition = node.left
      outputs = [node.right]
      const check = unwrap(condition)
      const output = unwrap(node.right)
      if (
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        ts.isCallExpression(check) &&
        check.expression.getText(file) === "Array.isArray" &&
        check.arguments.length === 1 &&
        ts.isCallExpression(output) &&
        ts.isPropertyAccessExpression(output.expression) &&
        output.expression.name.text === "map"
      ) {
        const checked = origin(check.arguments[0])
        const mapped = origin(output.expression.expression)
        navigation =
          checked !== undefined &&
          checked === mapped &&
          definitionAt(checked.replace(/\[\]/g, "[0]"))?.kind === "list"
      }
    } else if (ts.isConditionalExpression(node) && containsJsx(node)) {
      condition = node.condition
      outputs = [node.whenTrue, node.whenFalse]
    } else return
    return {
      condition,
      outputs,
      navigation,
      supported: navigation || finiteCondition(condition),
    }
  }
  const checkOutput = (expression: ts.Expression) => {
    const paths = outputProvenance(expression, true)
    if (
      paths.some((path) => {
        const pattern = coveragePattern(path)
        const ancestorOf = (ancestor: string, descendant: string) =>
          descendant.startsWith(`${ancestor}.`) ||
          descendant.startsWith(`${ancestor}[`)
        return (
          path === "" ||
          inventory.some(
            (entry) =>
              entry.status === "bound" &&
              (entry.path === pattern ||
                ancestorOf(pattern, entry.path) ||
                ancestorOf(entry.path, pattern))
          )
        )
      })
    )
      fail(
        `raw visible interpolation ${expression.getText(file)}; use a descriptor-bound kit host`
      )
  }
  visit(file, (node) => {
    if (
      !ts.isFunctionDeclaration(node) ||
      !node.body ||
      !node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    )
      return
    const returned = (child: ts.Node) => {
      if (ts.isFunctionLike(child)) return
      if (ts.isReturnStatement(child)) {
        if (child.expression) checkOutput(child.expression)
        return
      }
      ts.forEachChild(child, returned)
    }
    returned(node.body)
  })
  // The manual profile shares the parser, lexical syntax references and output
  // precedence above with the binding guard. These two syntax refusals mirror
  // react/jsx-props-no-spreading (explicitSpread=enforce) and no-children-prop;
  // importing ESLint's whole execution pipeline into persistence is unnecessary.
  const structural =
    /^(?:key|id|className|role|tabIndex|hidden|dir|lang|href|download|target|rel|aria-[\w-]+|data-[\w-]+)$/
  const props: Record<string, readonly string[]> = {
    Text: ["fields", "fieldPath", "ctx", "as"],
    RichText: ["fields", "fieldPath", "ctx", "as", "host"],
    KitImage: [
      "fields",
      "fieldPath",
      "ctx",
      "altFallback",
      "decorative",
      "fill",
      "frame",
      "bleed",
      "priority",
      "sizes",
    ],
    Buttons: ["fields", "fieldPath", "ctx", "onBrand"],
    Accordion: ["rows", "label"],
    Link: [],
    Decoration: [],
    SliceIcon: ["name"],
    RichTextContent: ["value", "fieldPath", "ctx", "profile", "as"],
    SliceImage: [
      "image",
      "fieldPath",
      "ctx",
      "altFallback",
      "decorative",
      "fill",
      "frame",
      "bleed",
      "priority",
      "sizes",
    ],
    SliceButtons: ["items", "fieldPath", "ctx", "onBrand"],
    ContactFormClient: ["locale"],
    SiteSearchClient: ["locale", "languageVersion"],
  }
  const literal = literalExpression
  // Accordion is the one reviewed seam with nested ReactNode slots. Metadata
  // remains data; title/answer use the same output boundary as normal JSX.
  const checkRows = (
    expression: ts.Expression,
    seen = new Set<ts.Expression>()
  ): void => {
    const node = unwrap(expression)
    if (seen.has(node)) {
      fail("unsupported renderer output Accordion.rows alias")
      return
    }
    const next = new Set(seen).add(node)
    if (ts.isIdentifier(node)) {
      const initializer = lookup(node.text, node)?.initializer
      if (initializer) {
        checkRows(initializer, next)
        return
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const row of node.elements) checkRows(row, next)
      return
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    ) {
      const callback = node.arguments[0]
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        if (!ts.isBlock(callback.body)) checkRows(callback.body, next)
        else {
          const returned = (child: ts.Node) => {
            if (ts.isFunctionLike(child)) return
            if (ts.isReturnStatement(child)) {
              if (child.expression) checkRows(child.expression, next)
              return
            }
            ts.forEachChild(child, returned)
          }
          returned(callback.body)
        }
        return
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (
          !ts.isPropertyAssignment(prop) ||
          !["key", "headingLevel", "title", "answer"].includes(
            prop.name.getText(file)
          )
        ) {
          fail("unsupported renderer output Accordion row property")
          continue
        }
        if (["title", "answer"].includes(prop.name.getText(file)))
          checkOutput(prop.initializer)
      }
      return
    }
    fail("unsupported renderer output Accordion.rows")
  }
  visit(file, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file)
      const native = ts.isIdentifier(node.tagName) && /^[a-z]/.test(tag)
      const component =
        kitName(node.tagName) ??
        (ts.isIdentifier(node.tagName)
          ? lookup(tag, node)?.component
          : undefined)
      if (!native && (!component || !props[component]))
        fail(`unsupported renderer output component <${tag}>`)
      for (const attr of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) {
          fail(`unsupported renderer output JSX props spread on <${tag}>`)
          continue
        }
        const name = attr.name.getText(file)
        if (name === "children" || name === "dangerouslySetInnerHTML")
          fail(
            `unsupported renderer output ${tag}.${name}; use nested JSX and kit hosts`
          )
        const expression = attrExpression(attr)
        if (component === "Accordion" && name === "rows" && expression)
          checkRows(expression)
        const compatibilityOutput =
          (component === "RichTextContent" && name === "value") ||
          (component === "SliceImage" && name === "image") ||
          (component === "SliceButtons" && name === "items")
        if (compatibilityOutput && expression && !literal(expression)) {
          const path = origin(expression)
          const pattern = path === undefined ? undefined : coveragePattern(path)
          const fields =
            pattern === undefined
              ? []
              : inventory.filter(
                  (field) =>
                    field.path === pattern ||
                    field.path.startsWith(`${pattern}.`) ||
                    field.path.startsWith(`${pattern}[`)
                )
          const pending = COVERAGE_MIGRATION_PENDING.find(
            (entry) =>
              entry.type === type && entry.sourceTarget === sourceTarget
          )
          if (
            !fields.length ||
            fields.some(
              (field) =>
                field.status !== "structural" &&
                field.status !== "legacy" &&
                field.status !== "unsupported" &&
                !pending?.paths.some((path) => path === field.path)
            )
          )
            fail(
              `unsupported renderer output compatibility ${tag}.${name}; use a kit host or an exact inventoried legacy seam`
            )
        }
        if (
          ["as", "host"].includes(name) &&
          component &&
          expression &&
          !literal(expression)
        )
          fail(`unsupported renderer output dynamic host ${tag}.${name}`)
        const frameValue = expression ? unwrap(expression) : attr.initializer
        const invalidFrame =
          name === "frame" &&
          (component === "KitImage" || component === "SliceImage") &&
          (!frameValue ||
            !(ts.isStringLiteral(frameValue) ||
              ts.isNoSubstitutionTemplateLiteral(frameValue)) ||
            !["aspect", "cover"].includes(frameValue.text))
        if (
          native
            ? expression && !literal(expression) && !structural.test(name)
            : component &&
              !structural.test(name) &&
              (!props[component]?.includes(name) || invalidFrame)
        )
          fail(`unsupported renderer output prop ${tag}.${name}`)
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (provenance(node.left).length || origin(node.left)?.startsWith("@"))
    )
      fail(
        `mutated authored binding ${node.left.getText(file)} is outside the finite renderer seam`
      )
    const guard = factory ? guardAt(node) : undefined
    if (guard && !guard.supported)
      fail(
        `undeclared conditional branch ${guard.condition.getText(file)}; only descriptor-field emptiness guards and same-list Array.isArray map navigation are supported by the finite factory matrix`
      )
    if (guard?.supported && !guard.navigation) {
      let ancestor: ts.Node | undefined = node.parent
      while (ancestor) {
        const parent = guardAt(ancestor)
        if (
          parent?.supported &&
          !parent.navigation &&
          parent.outputs.some((output) => isAncestor(output, node))
        ) {
          fail(
            `nested content guards are outside the finite factory matrix: ${guard.condition.getText(file)}`
          )
          break
        }
        ancestor = ancestor.parent
      }
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      !ts.isJsxAttribute(node.parent)
    ) {
      if (node.dotDotDotToken)
        fail("unsupported renderer output JSX child spread")
      checkOutput(node.expression)
    }
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node))
      return
    const helper = kitName(node.tagName)
    if (!helper || !KIT.has(helper)) {
      if (factory)
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue
          const expr = attrExpression(attr)
          if (
            expr &&
            provenance(expr).length &&
            !/^(key|aria-|className)/.test(attr.name.getText(file))
          )
            fail(
              `authored value passed to unqualified ${node.tagName.getText(file)}.${attr.name.getText(file)}; use a kit host`
            )
        }
      return
    }
    const path = pathAt(node)
    if (!path) {
      fail(
        `${helper} has a missing or unresolved fieldPath (use the enclosing map index)`
      )
      return
    }
    const pattern = coveragePattern(path)
    const field = definitionAt(path)
    if (
      !field ||
      field.kind !== KIT.get(helper) ||
      (helper === "Buttons" && !isButtonDefinition(field))
    ) {
      fail(`${path}: ${helper} has the wrong descriptor path/kind`)
      return
    }
    if (origin(attrExpression(attribute(node, "fields"))) !== "@fields")
      fail(
        `${path}: wrong binding source; fields must originate in bindSliceFields(${descriptorName}, slice)`
      )
    if (origin(attrExpression(attribute(node, "ctx"))) !== "@context")
      fail(`${path}: ctx must carry the renderer context`)
    if (node.attributes.properties.some(ts.isJsxSpreadAttribute))
      fail(`${path}: spread kit props have an unresolved binding origin`)
    // A fixed row inside a map is a copied-index-zero defect even if another
    // fixture happens to carry the same value.
    for (const { list, callback } of maps.values()) {
      if (
        isAncestor(callback, node) &&
        coveragePattern(path).startsWith(`${list}[]`) &&
        !pathIndexes.get(node)?.has(callback)
      )
        fail(`${path}: repeated host must use the enclosing row index`)
    }
    if (helper === "Buttons") bound.add(`${pattern}[].label`)
    else bound.add(pattern)
  })
  for (const field of inventory) {
    if (field.status === "bound" && !bound.has(field.path))
      fail(`${field.path}: missing kit binding (${field.kind})`)
    if (
      factory &&
      (field.status === "unsupported" || field.status === "legacy")
    )
      fail(`${field.path}: unsupported visible ${field.kind}; ${field.reason}`)
  }
  return [...failures]
}
