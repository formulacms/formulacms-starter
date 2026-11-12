/* eslint-disable @typescript-eslint/no-require-imports -- Turbopack loaders execute CommonJS. */
const ts = require("typescript")

function normalizeFile(file) {
  return file.replaceAll("\\", "/")
}

function intrinsicTagName(tagName) {
  if (!ts.isIdentifier(tagName)) return null
  const tag = tagName.text
  return /^[a-z][a-z0-9-]*$/.test(tag) ? tag : null
}

// Bind only a direct rendered primary leaf, never guards, derived values or
// list positions. Resolve the canonical const alias in its lexical scope so a
// nested callback's `primary` parameter cannot impersonate slice content.
function directContentPath(node) {
  if (!ts.isJsxOpeningElement(node)) return undefined
  const children = node.parent.children.filter(
    (child) => !ts.isJsxText(child) || child.text.trim()
  )
  if (children.length !== 1 || !ts.isJsxExpression(children[0]))
    return undefined
  const expression = children[0].expression
  if (
    !expression ||
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "primary"
  )
    return undefined

  function declaresName(name, identifier) {
    if (ts.isIdentifier(name)) return name.text === identifier
    return ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)
      ? name.elements.some(
          (element) =>
            ts.isBindingElement(element) &&
            declaresName(element.name, identifier)
        )
      : false
  }

  function isSliceParameter(declaration) {
    for (let scope = declaration.parent; scope; scope = scope.parent) {
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        for (const statement of scope.statements) {
          if (
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some((local) =>
              declaresName(local.name, "slice")
            )
          )
            return false
        }
      }
      if (ts.isFunctionLike(scope)) {
        return scope.parameters.some((parameter) => {
          if (ts.isIdentifier(parameter.name))
            return parameter.name.text === "slice"
          return (
            ts.isObjectBindingPattern(parameter.name) &&
            parameter.name.elements.some(
              (element) =>
                ts.isIdentifier(element.name) &&
                element.name.text === "slice" &&
                !element.dotDotDotToken &&
                (!element.propertyName ||
                  element.propertyName.getText() === "slice")
            )
          )
        })
      }
    }
    return false
  }

  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name?.text === "primary"
        )
          return undefined
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!declaresName(declaration.name, "primary")) continue
          const binding = ts.isObjectBindingPattern(declaration.name)
            ? declaration.name.elements.find(
                (element) =>
                  ts.isIdentifier(element.name) &&
                  element.name.text === "primary" &&
                  !element.dotDotDotToken &&
                  !element.initializer &&
                  (!element.propertyName ||
                    element.propertyName.getText() === "primary")
              )
            : undefined
          return binding &&
            statement.declarationList.flags & ts.NodeFlags.Const &&
            declaration.initializer &&
            ts.isIdentifier(declaration.initializer) &&
            declaration.initializer.text === "slice" &&
            isSliceParameter(declaration)
            ? `primary.${expression.name.text}`
            : undefined
        }
      }
    }
    if (ts.isFunctionLike(scope)) {
      if (
        scope.parameters.some((parameter) =>
          declaresName(parameter.name, "primary")
        )
      )
        return undefined
    }
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      declaresName(scope.variableDeclaration.name, "primary")
    )
      return undefined
    if (
      (ts.isForStatement(scope) ||
        ts.isForOfStatement(scope) ||
        ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) =>
        declaresName(declaration.name, "primary")
      )
    )
      return undefined
  }
  return undefined
}

// One qualified renderer pattern: the sole legacy RichTextContent or kit
// RichText child explicitly carries the actual index of slice.items.map(...).
function repeatedContentPathExpression(node, sourceFile, ownHost = false) {
  if (!ownHost && !ts.isJsxOpeningElement(node)) return undefined
  const children = ownHost
    ? [node]
    : node.parent.children.filter(
        (child) => !ts.isJsxText(child) || child.text.trim()
      )
  if (children.length !== 1) return undefined
  const child = children[0]
  const opening = ts.isJsxSelfClosingElement(child)
    ? child
    : ts.isJsxElement(child)
      ? child.openingElement
      : undefined
  if (!opening || !ts.isIdentifier(opening.tagName)) return undefined
  const kitRichText = opening.tagName.text === "RichText"
  if (!kitRichText && opening.tagName.text !== "RichTextContent")
    return undefined
  const attribute = (name) =>
    opening.attributes.properties.find(
      (entry) =>
        ts.isJsxAttribute(entry) && entry.name.getText(sourceFile) === name
    )?.initializer
  const path = attribute("fieldPath")
  const value = attribute("value")
  if (
    !path ||
    !ts.isJsxExpression(path) ||
    !path.expression ||
    !ts.isTemplateExpression(path.expression) ||
    path.expression.head.text !== "items[" ||
    path.expression.templateSpans.length !== 1
  )
    return undefined
  const span = path.expression.templateSpans[0]
  const field = /^\]\.([A-Za-z_$][\w$]*)$/.exec(span.literal.text)?.[1]
  if (!ts.isIdentifier(span.expression) || !field) return undefined
  if (kitRichText) {
    const fields = attribute("fields")
    if (
      !fields ||
      !ts.isJsxExpression(fields) ||
      !ts.isIdentifier(fields.expression) ||
      fields.expression.text !== "fields"
    )
      return undefined
  } else if (
    !value ||
    !ts.isJsxExpression(value) ||
    !value.expression ||
    !ts.isPropertyAccessExpression(value.expression) ||
    !ts.isIdentifier(value.expression.expression) ||
    value.expression.name.text !== field
  ) {
    return undefined
  }
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) continue
    // Reject a nested/shadowing function; do not infer aliases or filtered lists.
    if (
      !ts.isArrowFunction(scope) ||
      scope.parameters.length !== 2 ||
      !ts.isIdentifier(scope.parameters[0].name) ||
      !ts.isIdentifier(scope.parameters[1].name) ||
      scope.parameters[1].name.text !== span.expression.text ||
      !ts.isCallExpression(scope.parent) ||
      scope.parent.arguments[0] !== scope
    )
      return undefined
    const call = scope.parent.expression
    if (
      !ts.isPropertyAccessExpression(call) ||
      call.name.text !== "map" ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "items" ||
      !ts.isIdentifier(call.expression.expression) ||
      call.expression.expression.text !== "slice"
    )
      return undefined
    if (
      !kitRichText &&
      scope.parameters[0].name.text !== value.expression.expression.text
    )
      return undefined
    return path.expression.getText(sourceFile)
  }
  return undefined
}

function classNameShape(node, sourceFile, source) {
  const attribute = node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) &&
      property.name.getText(sourceFile) === "className"
  )
  if (!attribute) return { kind: "none" }
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) {
    return {
      kind: "unsupported",
      attributeStart: attribute.getStart(sourceFile),
      attributeEnd: attribute.getEnd(),
    }
  }

  const initializer = attribute.initializer
  if (ts.isStringLiteral(initializer)) {
    return classLiteralShape(attribute, initializer, sourceFile, source)
  }
  if (!ts.isJsxExpression(initializer) || !initializer.expression) {
    return {
      kind: "unsupported",
      attributeStart: attribute.getStart(sourceFile),
      attributeEnd: attribute.getEnd(),
    }
  }
  const expression = initializer.expression
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return classLiteralShape(attribute, expression, sourceFile, source)
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "cn"
  ) {
    const literals = expression.arguments
      .filter(
        (argument) =>
          ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument)
      )
      .map((literal) => literalTokenShape(literal, sourceFile, source))
    return {
      kind: "cn",
      attributeStart: attribute.getStart(sourceFile),
      attributeEnd: attribute.getEnd(),
      callClose: expression.getEnd() - 1,
      literals,
    }
  }
  return {
    kind: "unsupported",
    attributeStart: attribute.getStart(sourceFile),
    attributeEnd: attribute.getEnd(),
  }
}

function classLiteralShape(attribute, literal, sourceFile, source) {
  return {
    kind: "literal",
    attributeStart: attribute.getStart(sourceFile),
    attributeEnd: attribute.getEnd(),
    literal: literalTokenShape(literal, sourceFile, source),
  }
}

function literalTokenShape(literal, sourceFile, source) {
  const start = literal.getStart(sourceFile)
  const end = literal.getEnd()
  return {
    start: start + 1,
    end: end - 1,
    value: source.slice(start + 1, end - 1),
    quote: source[start],
  }
}

function enumerateTweakLocations(source, file) {
  const normalizedFile = normalizeFile(file)
  const sourceFile = ts.createSourceFile(
    normalizedFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const entries = []
  const kitHosts = new Set()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const importSource = statement.moduleSpecifier.text
    if (
      ![
        "@/components/slice-kit",
        "@/components/slice-kit/heading-slot",
      ].includes(importSource)
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const binding of bindings.elements) {
      if (
        ["RichText", "Text", "HeadingSlot"].includes(
          binding.propertyName?.text ?? binding.name.text
        )
      )
        kitHosts.add(binding.name.text)
    }
  }

  function visit(node, mapDepth) {
    const inMap =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    const nextMapDepth = mapDepth + (inMap ? 1 : 0)

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag =
        intrinsicTagName(node.tagName) ??
        (ts.isIdentifier(node.tagName) && kitHosts.has(node.tagName.text)
          ? node.tagName.text
          : null)
      if (tag) {
        const boundPath = kitHosts.has(tag)
          ? node.attributes.properties.find(
              (entry) =>
                ts.isJsxAttribute(entry) &&
                entry.name.getText(sourceFile) === "fieldPath"
            )?.initializer
          : undefined
        const start = node.getStart(sourceFile)
        const position = sourceFile.getLineAndCharacterOfPosition(start)
        entries.push({
          loc: `${normalizedFile}:${position.line + 1}:${position.character + 1}`,
          file: normalizedFile,
          line: position.line + 1,
          column: position.character + 1,
          tag,
          start,
          end: node.getEnd(),
          insertAttributeAt: node.tagName.getEnd(),
          templateWide: nextMapDepth > 0,
          contentPath:
            boundPath && ts.isStringLiteral(boundPath)
              ? boundPath.text.replace(/\[(\d+)\]/g, ".$1")
              : directContentPath(node),
          contentPathExpression: repeatedContentPathExpression(
            node,
            sourceFile,
            kitHosts.has(tag) && tag !== "HeadingSlot"
          ),
          className: classNameShape(node, sourceFile, source),
        })
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextMapDepth))
  }

  visit(sourceFile, 0)
  return entries
}

module.exports = { enumerateTweakLocations }
