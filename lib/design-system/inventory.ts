import { createHash } from "node:crypto"
import { posix } from "node:path"
import ts from "typescript"
import {
  referencedVariables,
  scanCss,
  walkCss,
  type CssAtBlock,
  type CssDeclaration,
  type CssNode,
  type CssScanIssue,
} from "./css-scan"
import {
  normalizeSourcePath,
  parseScript,
  staticClassTokens,
  walkScript,
  type DesignSystemSourceFile,
} from "./source-scan"

export type { DesignSystemSourceFile }

export interface InventoryStylesheet {
  path: string
  hash: string
  bytes: number
  issues: CssScanIssue[]
}

export interface InventoryAtRule {
  name: string
  params: string
}

export interface InventoryDeclaration {
  id: string
  sourcePath: string
  sourceHash: string
  layerPath: string[]
  selectorPath: string[]
  atRuleContext: InventoryAtRule[]
  registerId: string
  modeId: string
  name: string
  value: string
  start: number
  end: number
  valueStart: number
  valueEnd: number
  referencedVariables: string[]
  ambiguous: boolean
}

export interface InventoryMode {
  id: string
  selectors: string[]
  declarationIds: string[]
}

export type RegisterKind =
  /** Tokens declared inside Tailwind's own `@theme` block. */
  | "theme"
  /** The site default, declared on `:root`. */
  | "root"
  /** A selector-scoped token group — the shape a named register takes. */
  | "scoped"

export interface InventoryRegister {
  id: string
  kind: RegisterKind
  sourcePath: string
  layerPath: string[]
  selector: string
  modes: InventoryMode[]
  declarationIds: string[]
}

export interface InventoryAmbiguity {
  name: string
  declarationIds: string[]
}

export type FontAttachmentSurface = "public-layout" | "core-layout" | "layout"

export interface InventoryFont {
  sourcePath: string
  instanceName: string
  family: string
  loader: string
  variable: string | null
  attachments: FontAttachmentSurface[]
  /** A className attachment alone does not expose the loader's CSS variable. */
  variableAttachments?: FontAttachmentSurface[]
  /** Explicit literal loader options only; unknown options are not selectable. */
  capabilities?: { weights: string[]; styles: string[] } | null
}

export interface InventoryFontAttachment {
  sourcePath: string
  surface: FontAttachmentSurface
  element: string
  classExport: string
  fontInstances: string[]
}

export type BindingAnchorKind =
  | "site"
  /** A named part of every public page — the header, the footer, the middle. */
  | "surface"
  | "content-type"
  | "slice-type"

export interface InventoryBindingAnchor {
  id: string
  kind: BindingAnchorKind
  target: string
  sourcePath: string
  component: string
  rootElement: string | null
  /**
   * Byte offset just past the root element's tag name — where an attribute
   * would be inserted. Recorded here because discovery has already found the
   * element; re-finding it later is how two passes end up disagreeing about
   * which element they mean. Null whenever the root is not stable.
   */
  attributeInsertAt: number | null
  classTokens: string[]
  /**
   * Literal `data-*` attributes on the root. ADR-0046 makes a semantic data
   * attribute (or a Tailwind variant) the canonical way to attach a register,
   * so a binding proposal needs to see what is already there.
   */
  dataAttributes: Record<string, string>
  /**
   * Whether the root is structurally stable enough to address at all. This is
   * a *structural* fact, deliberately independent of whether the checkout may
   * be written: write eligibility comes only from `gateOperation` in
   * `classification.ts`. A legacy site still has perfectly stable anchors.
   */
  stable: boolean
  reason: string | null
}

export interface InventoryConsumer {
  sourcePath: string
  classTokens: string[]
  referencedVariables: string[]
}

export interface DesignSystemInventory {
  stylesheets: InventoryStylesheet[]
  registers: InventoryRegister[]
  declarations: InventoryDeclaration[]
  ambiguities: InventoryAmbiguity[]
  fonts: InventoryFont[]
  fontAttachments: InventoryFontAttachment[]
  publicLayoutPaths?: string[]
  bindingAnchors: InventoryBindingAnchor[]
  consumers: InventoryConsumer[]
}

interface MutableMode {
  id: string
  selectors: Set<string>
  declarationIds: string[]
}

interface MutableRegister {
  id: string
  kind: RegisterKind
  sourcePath: string
  layerPath: string[]
  selector: string
  modes: Map<string, MutableMode>
  declarationIds: string[]
}

/**
 * Build a deterministic, side-effect-free inventory from supplied source.
 * Filesystem discovery is deliberately kept outside this function so fixtures,
 * the current checkout, and opt-in compatibility checkouts use the same path.
 */
export function buildDesignSystemInventory(
  files: readonly DesignSystemSourceFile[]
): DesignSystemInventory {
  const stylesheets: InventoryStylesheet[] = []
  const declarations: InventoryDeclaration[] = []
  const registerMap = new Map<string, MutableRegister>()
  const { fonts, fontAttachments } = inventoryFonts(files)
  const bindingAnchors = inventoryBindingAnchors(files)
  const consumers = inventoryConsumers(files)

  for (const file of files) {
    if (!file.path.endsWith(".css")) continue
    const sourceHash = digest(file.content)
    const scan = scanCss(file.content)
    stylesheets.push({
      path: file.path,
      hash: sourceHash,
      bytes: Buffer.byteLength(file.content),
      issues: scan.issues,
    })

    walkCss(scan.nodes, (node, ancestors) => {
      if (node.kind !== "declaration" || !node.property.startsWith("--")) {
        return
      }
      addDeclaration({
        node,
        ancestors,
        sourcePath: file.path,
        sourceHash,
        declarations,
        registerMap,
      })
    })
  }

  const byName = new Map<string, InventoryDeclaration[]>()
  for (const declaration of declarations) {
    const group = byName.get(declaration.name) ?? []
    group.push(declaration)
    byName.set(declaration.name, group)
  }
  const ambiguities: InventoryAmbiguity[] = []
  for (const [name, group] of byName) {
    if (group.length < 2) continue
    for (const declaration of group) declaration.ambiguous = true
    ambiguities.push({
      name,
      declarationIds: group.map((declaration) => declaration.id),
    })
  }

  return {
    stylesheets,
    declarations,
    ambiguities,
    fonts,
    fontAttachments,
    publicLayoutPaths: files
      .filter(
        (file) =>
          file.path.endsWith("layout.tsx") &&
          surfaceForLayout(file.path) === "public-layout"
      )
      .map((file) => file.path),
    bindingAnchors,
    consumers,
    registers: [...registerMap.values()].map((register) => ({
      id: register.id,
      kind: register.kind,
      sourcePath: register.sourcePath,
      layerPath: register.layerPath,
      selector: register.selector,
      declarationIds: register.declarationIds,
      modes: [...register.modes.values()].map((mode) => ({
        id: mode.id,
        selectors: [...mode.selectors],
        declarationIds: mode.declarationIds,
      })),
    })),
  }
}

function inventoryBindingAnchors(
  files: readonly DesignSystemSourceFile[]
): InventoryBindingAnchor[] {
  const fileMap = new Map(
    files.map((file) => [normalizeSourcePath(file.path), file])
  )
  const anchors: InventoryBindingAnchor[] = []

  for (const file of files) {
    const path = normalizeSourcePath(file.path)
    if (path.includes("/(public)/") && path.endsWith("/layout.tsx")) {
      const source = parseScript(file)
      const body = findJsxElement(source, "body")
      if (body) {
        const classAttribute = body.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) &&
            property.name.getText(source) === "className"
        )
        anchors.push({
          id: `anchor:${digest(JSON.stringify(["site", path, "body"])).slice(0, 18)}`,
          kind: "site",
          target: "site-default",
          sourcePath: path,
          component: "PublicLayout",
          rootElement: "body",
          attributeInsertAt: body.tagName.end,
          classTokens: classAttribute
            ? staticClassTokens(classAttribute.initializer)
            : [],
          dataAttributes: staticDataAttributes(body, source),
          stable: true,
          reason: null,
        })
        anchors.push(...inventorySurfaceAnchors(source, path, fileMap))
      }
    }
    const kind = path.endsWith("components/content-types/index.ts")
      ? "content-type"
      : path.endsWith("components/slices/slice-zone-registry.tsx")
        ? "slice-type"
        : null
    if (!kind) continue

    const source = parseScript(file)
    const imports = importedSources(source, path, fileMap)
    const registryName =
      kind === "content-type" ? "contentTypeRenderers" : "SLICE_COMPONENTS"
    const registry = findObjectVariable(source, registryName)
    if (!registry) continue

    for (const property of registry.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const target = propertyName(property.name)
      if (!target) continue
      const component =
        kind === "content-type"
          ? componentFromContentTypeEntry(property.initializer)
          : componentFromSliceEntry(property.initializer)
      if (!component) continue
      const rendererPath = imports.get(component)
      const rendererFile = rendererPath ? fileMap.get(rendererPath) : undefined
      const root = rendererFile
        ? inspectRendererRoot(rendererFile, component)
        : {
            rootElement: null,
            attributeInsertAt: null,
            classTokens: [],
            dataAttributes: {},
            stable: false,
            reason: "renderer-source-not-found",
          }
      anchors.push({
        id: `anchor:${digest(
          JSON.stringify([kind, target, rendererPath ?? path, component])
        ).slice(0, 18)}`,
        kind,
        target,
        sourcePath: rendererPath ?? path,
        component,
        ...root,
      })
    }
  }

  return anchors
}

/**
 * Semantic elements the public layout can name as a part of the site. A `div`
 * is deliberately not here: "the second div in the layout" is not something an
 * owner can recognise, and it is exactly the kind of target ADR-0046 sends to
 * structural developer work instead.
 */
const SURFACE_TAGS = new Set(["header", "main", "footer", "nav", "aside"])

/**
 * The named parts of every public page (Plan 033 Phase 4, ADR-0046).
 *
 * Two shapes qualify, and only these two:
 *
 *   a semantic element written in the public layout itself — `<main>`
 *   a component the layout renders whose own root is a plain element —
 *     `SiteHeader` returning `<header>`
 *
 * Apart from the trusted PublicSurface forwarding host, a component whose root
 * is another component (a provider, a context wrapper,
 * a third-party widget) is not a surface: there is no element here to attach
 * anything to, and listing every provider as "unusable" would bury the parts
 * an owner actually recognises. The refusal path is not lost by that choice —
 * content types and Slice Types report their unusable roots in full.
 *
 * A name that appears twice is reported as unusable rather than guessed at.
 */
function inventorySurfaceAnchors(
  source: ts.SourceFile,
  layoutPath: string,
  fileMap: ReadonlyMap<string, DesignSystemSourceFile>
): InventoryBindingAnchor[] {
  const imports = importedSources(source, layoutPath, fileMap)
  const seen = new Map<string, number>()
  const found: InventoryBindingAnchor[] = []

  walkScript(source, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return
    }
    const tagName = node.tagName.getText(source)

    if (SURFACE_TAGS.has(tagName)) {
      seen.set(tagName, (seen.get(tagName) ?? 0) + 1)
      const described = describeOpeningElement(node, source)
      found.push({
        id: surfaceAnchorId(layoutPath, tagName),
        kind: "surface",
        target: tagName,
        sourcePath: layoutPath,
        component: "PublicLayout",
        ...described,
        stable: true,
        reason: null,
      })
      return
    }

    if (!/^[A-Z]/.test(tagName)) return
    const rendererPath = imports.get(tagName)
    const rendererFile = rendererPath ? fileMap.get(rendererPath) : undefined
    if (!rendererFile || !rendererPath) return
    const root = inspectRendererRoot(rendererFile, tagName)
    // Only a plain element can carry the attribute. Anything else is a wrapper,
    // not a surface.
    if (!root.stable || !root.rootElement || /^[A-Z]/.test(root.rootElement)) {
      return
    }
    const target = kebabCase(tagName)
    seen.set(target, (seen.get(target) ?? 0) + 1)
    found.push({
      id: surfaceAnchorId(rendererPath, target),
      kind: "surface",
      target,
      sourcePath: rendererPath,
      component: tagName,
      ...root,
    })
  })

  return found.map((anchor) =>
    (seen.get(anchor.target) ?? 0) > 1
      ? {
          ...anchor,
          rootElement: null,
          attributeInsertAt: null,
          classTokens: [],
          dataAttributes: {},
          stable: false,
          reason: "surface-appears-more-than-once",
        }
      : anchor
  )
}

function surfaceAnchorId(sourcePath: string, target: string): string {
  return `anchor:${digest(
    JSON.stringify(["surface", sourcePath, target])
  ).slice(0, 18)}`
}

function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
}

function inventoryConsumers(
  files: readonly DesignSystemSourceFile[]
): InventoryConsumer[] {
  const consumers: InventoryConsumer[] = []
  for (const file of files) {
    if (!file.path.endsWith(".tsx")) continue
    const source = parseScript(file)
    const classTokens = new Set<string>()
    walkScript(source, (node) => {
      if (
        !ts.isJsxAttribute(node) ||
        node.name.getText(source) !== "className"
      ) {
        return
      }
      for (const token of staticClassTokens(node.initializer)) {
        classTokens.add(token)
      }
    })
    const variables = referencedVariables(file.content)
    if (classTokens.size === 0 && variables.length === 0) continue
    consumers.push({
      sourcePath: normalizeSourcePath(file.path),
      classTokens: [...classTokens],
      referencedVariables: variables,
    })
  }
  return consumers
}

function importedSources(
  source: ts.SourceFile,
  sourcePath: string,
  files: ReadonlyMap<string, DesignSystemSourceFile>
): Map<string, string> {
  const imports = new Map<string, string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue
    }
    const resolved = resolveSourcePath(
      sourcePath,
      statement.moduleSpecifier.text,
      files
    )
    if (!resolved) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, resolved)
      }
    }
    const defaultImport = statement.importClause?.name
    if (defaultImport) imports.set(defaultImport.text, resolved)
  }
  return imports
}

function resolveSourcePath(
  importer: string,
  specifier: string,
  files: ReadonlyMap<string, DesignSystemSourceFile>
): string | null {
  const unresolved = specifier.startsWith("@/")
    ? specifier.slice(2)
    : specifier.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(importer), specifier))
      : null
  if (!unresolved) return null
  const candidates = [
    unresolved,
    `${unresolved}.tsx`,
    `${unresolved}.ts`,
    posix.join(unresolved, "index.tsx"),
    posix.join(unresolved, "index.ts"),
  ]
  return candidates.find((candidate) => files.has(candidate)) ?? null
}

function findObjectVariable(
  source: ts.SourceFile,
  name: string
): ts.ObjectLiteralExpression | null {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      ) {
        const expression = unwrapExpression(declaration.initializer)
        return ts.isObjectLiteralExpression(expression) ? expression : null
      }
    }
  }
  return null
}

function componentFromContentTypeEntry(
  expression: ts.Expression
): string | null {
  const value = unwrapExpression(expression)
  if (!ts.isObjectLiteralExpression(value)) return null
  for (const property of value.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === "Component" &&
      ts.isIdentifier(property.initializer)
    ) {
      return property.initializer.text
    }
  }
  return null
}

function componentFromSliceEntry(expression: ts.Expression): string | null {
  const value = unwrapExpression(expression)
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return null
  let component: string | null = null
  walkScript(value.body, (node) => {
    if (component) return
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const text = node.tagName.getText()
      if (/^[A-Z]/.test(text)) component = text
    }
  })
  return component
}

export type RendererRootInspection = Pick<
  InventoryBindingAnchor,
  | "rootElement"
  | "attributeInsertAt"
  | "classTokens"
  | "dataAttributes"
  | "stable"
  | "reason"
>

export function inspectRendererRoot(
  file: DesignSystemSourceFile,
  component: string
): RendererRootInspection {
  const source = parseScript(file)
  let body: ts.ConciseBody | null = null
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === component &&
      statement.body
    ) {
      body = statement.body
      break
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === component &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        body = declaration.initializer.body
      }
    }
  }
  if (!body) {
    return {
      rootElement: null,
      attributeInsertAt: null,
      classTokens: [],
      dataAttributes: {},
      stable: false,
      reason: "renderer-component-not-found",
    }
  }

  const roots: ts.Expression[] = []
  if (!ts.isBlock(body)) {
    roots.push(unwrapExpression(body))
  } else {
    collectReturnExpressions(body, body, roots)
  }
  for (let index = 0; index < roots.length; index += 1) {
    roots[index] = unwrapPreviewKitRoot(roots[index], body)
  }
  const jsxRoots = roots.filter(
    (root) =>
      ts.isJsxElement(root) ||
      ts.isJsxSelfClosingElement(root) ||
      ts.isJsxFragment(root)
  )
  if (jsxRoots.length === 0) {
    return {
      rootElement: null,
      attributeInsertAt: null,
      classTokens: [],
      dataAttributes: {},
      stable: false,
      reason: "renderer-root-not-found",
    }
  }
  if (jsxRoots.some((root) => ts.isJsxFragment(root))) {
    return {
      rootElement: null,
      attributeInsertAt: null,
      classTokens: [],
      dataAttributes: {},
      stable: false,
      reason: "renderer-root-is-a-fragment",
    }
  }

  const elementRoots = jsxRoots.filter(
    (root): root is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(root) || ts.isJsxSelfClosingElement(root)
  )
  // A binding patch has one source span to attach to. Even identical tags in
  // separate return branches would leave one branch unbound, so conditional
  // return roots are not a stable anchor.
  if (elementRoots.length !== 1) {
    return {
      rootElement: null,
      attributeInsertAt: null,
      classTokens: [],
      dataAttributes: {},
      stable: false,
      reason: "renderer-has-multiple-roots",
    }
  }

  const described = elementRoots.map((root) => describeJsxRoot(root, source))
  const first = described[0]
  const publicSurface = isPublicSurfaceHost(first.rootElement, source)
  if (/^[A-Z]/.test(first.rootElement) && !publicSurface) {
    return {
      rootElement: null,
      attributeInsertAt: null,
      classTokens: [],
      dataAttributes: {},
      stable: false,
      reason: "renderer-root-is-a-component",
    }
  }

  return {
    ...first,
    // This engine-owned host forwards these attributes to its existing div.
    // Keep the insertion span on the JSX invocation, not on the shared host.
    rootElement: publicSurface ? "div" : first.rootElement,
    stable: true,
    reason: null,
  }
}

/** Only the explicitly imported first-party forwarding host is transparent. */
function isPublicSurfaceHost(name: string, source: ts.SourceFile): boolean {
  const imports = source.statements.filter((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.isTypeOnly
    )
      return false
    const specifier = statement.moduleSpecifier.text
    const path = specifier.startsWith("@/")
      ? specifier.slice(2)
      : specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(source.fileName), specifier))
        : null
    if (path?.replace(/\.tsx?$/, "") !== "components/ui/public-surface")
      return false
    const bindings = statement.importClause?.namedBindings
    return (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.name.text === name &&
          (element.propertyName?.text ?? element.name.text) === "PublicSurface"
      )
    )
  })
  if (imports.length !== 1) return false
  // As with font attachments, refuse lexical uncertainty conservatively.
  let shadowed = false
  walkScript(source, (node) => {
    if (
      (ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    )
      shadowed = true
  })
  return !shadowed
}

/** Resolve only the trusted kit wrapper over one same-function const JSX root. */
function unwrapPreviewKitRoot(
  expression: ts.Expression,
  body: ts.ConciseBody
): ts.Expression {
  let root = unwrapExpression(expression)
  if (ts.isConditionalExpression(root)) {
    const condition = unwrapExpression(root.condition)
    const enabled = unwrapExpression(root.whenTrue)
    const disabled = unwrapExpression(root.whenFalse)
    if (
      ts.isPropertyAccessExpression(condition) &&
      condition.name.text === "previewKitSlice" &&
      ts.isCallExpression(enabled) &&
      enabled.expression.getText() === condition.getText() &&
      enabled.arguments.length === 1 &&
      ts.isIdentifier(enabled.arguments[0]) &&
      ts.isIdentifier(disabled) &&
      enabled.arguments[0].text === disabled.text
    ) {
      root = enabled
    }
  }
  if (
    !ts.isBlock(body) ||
    !ts.isCallExpression(root) ||
    root.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(root.expression) ||
    root.expression.name.text !== "previewKitSlice" ||
    !ts.isIdentifier(root.arguments[0])
  ) {
    return root
  }

  const name = root.arguments[0].text
  const declarations = body.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ? statement.declarationList.declarations.filter(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
        )
      : []
  )
  if (declarations.length !== 1 || !declarations[0].initializer) return root
  return unwrapExpression(declarations[0].initializer)
}

function collectReturnExpressions(
  node: ts.Node,
  root: ts.Node,
  expressions: ts.Expression[]
): void {
  if (node !== root && ts.isFunctionLike(node)) return
  if (ts.isReturnStatement(node) && node.expression) {
    expressions.push(unwrapExpression(node.expression))
    return
  }
  node.forEachChild((child) =>
    collectReturnExpressions(child, root, expressions)
  )
}

function describeJsxRoot(
  expression: ts.JsxElement | ts.JsxSelfClosingElement,
  source: ts.SourceFile
) {
  return describeOpeningElement(
    ts.isJsxElement(expression) ? expression.openingElement : expression,
    source
  )
}

function describeOpeningElement(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  source: ts.SourceFile
): {
  rootElement: string
  attributeInsertAt: number
  classTokens: string[]
  dataAttributes: Record<string, string>
} {
  const classAttribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      property.name.getText(source) === "className"
  )
  return {
    rootElement: opening.tagName.getText(source),
    attributeInsertAt: opening.tagName.end,
    classTokens: classAttribute
      ? staticClassTokens(classAttribute.initializer)
      : [],
    dataAttributes: staticDataAttributes(opening, source),
  }
}

/** Literal `data-*` attributes on one JSX element; dynamic values are omitted. */
function staticDataAttributes(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  source: ts.SourceFile
): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const property of opening.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue
    const name = property.name.getText(source)
    if (!name.startsWith("data-")) continue
    const initializer = property.initializer
    if (initializer && ts.isStringLiteral(initializer)) {
      attributes[name] = initializer.text
      continue
    }
    if (
      initializer &&
      ts.isJsxExpression(initializer) &&
      initializer.expression &&
      ts.isStringLiteralLike(initializer.expression)
    ) {
      attributes[name] = initializer.expression.text
    }
  }
  return attributes
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function inventoryFonts(files: readonly DesignSystemSourceFile[]): {
  fonts: InventoryFont[]
  fontAttachments: InventoryFontAttachment[]
} {
  const fonts: InventoryFont[] = []
  const classExports = new Map<string, string[]>()
  const variableExports = new Map<string, string[]>()
  const exportedNames = new Set<string>()

  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue
    const source = parseScript(file)
    const loaderImports = new Map<string, string>()

    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith("next/font/")
      ) {
        continue
      }
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        loaderImports.set(
          element.name.text,
          element.propertyName?.text ?? element.name.text
        )
      }
    }

    const instanceNames = new Set<string>()
    const declarations = new Map<string, ts.Expression>()
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue
        }
        declarations.set(declaration.name.text, declaration.initializer)
        if (
          statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
          )
        ) {
          exportedNames.add(`${file.path}:${declaration.name.text}`)
        }
        if (
          !ts.isCallExpression(declaration.initializer) ||
          !ts.isIdentifier(declaration.initializer.expression)
        ) {
          continue
        }
        const loader = declaration.initializer.expression.text
        const importedFamily = loaderImports.get(loader)
        if (!importedFamily) continue
        const variable = stringObjectProperty(
          declaration.initializer.arguments[0],
          "variable"
        )
        const weights = stringListObjectProperty(
          declaration.initializer.arguments[0],
          "weight"
        )
        const styles = stringListObjectProperty(
          declaration.initializer.arguments[0],
          "style"
        )
        const capabilities =
          weights?.length &&
          styles?.length &&
          weights.every((weight) => /^(variable|[1-9]00)$/.test(weight)) &&
          styles.every((style) => style === "normal" || style === "italic")
            ? { weights, styles }
            : null
        fonts.push({
          sourcePath: file.path,
          instanceName: declaration.name.text,
          family: importedFamily.replaceAll("_", " "),
          loader: importedFamily,
          variable,
          attachments: [],
          variableAttachments: [],
          capabilities,
        })
        instanceNames.add(declaration.name.text)
      }
    }

    const resolving = new Set<string>()
    const staticVariableInstances = (
      expression: ts.Expression,
      seen = new Set<string>()
    ): string[] | null => {
      if (ts.isStringLiteralLike(expression)) return []
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        instanceNames.has(expression.expression.text)
      ) {
        return expression.name.text === "variable"
          ? [expression.expression.text]
          : expression.name.text === "className"
            ? []
            : null
      }
      if (ts.isIdentifier(expression)) {
        if (seen.has(expression.text)) return null
        const value = declarations.get(expression.text)
        if (!value) return null
        return staticVariableInstances(
          value,
          new Set([...seen, expression.text])
        )
      }
      const parts = ts.isTemplateExpression(expression)
        ? expression.templateSpans.map((span) => span.expression)
        : ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.PlusToken
          ? [expression.left, expression.right]
          : null
      if (!parts) return null
      const values = parts.map((part) => staticVariableInstances(part, seen))
      return values.some((value) => value === null)
        ? null
        : [...new Set(values.flat() as string[])]
    }
    const resolveClassExport = (
      name: string,
      variableOnly = false
    ): string[] => {
      const key = `${file.path}:${name}`
      const target = variableOnly ? variableExports : classExports
      const cached = target.get(key)
      if (cached) return cached
      if (resolving.has(key)) return []
      const initializer = declarations.get(name)
      if (!initializer) return []
      if (variableOnly) {
        const variables =
          staticVariableInstances(initializer, new Set([name])) ?? []
        target.set(key, variables)
        return variables
      }
      resolving.add(key)
      const found = new Set<string>()
      walkScript(initializer, (node) => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          instanceNames.has(node.expression.text) &&
          (node.name.text === "variable" ||
            (!variableOnly && node.name.text === "className"))
        ) {
          found.add(node.expression.text)
        }
        if (ts.isIdentifier(node) && declarations.has(node.text)) {
          for (const instance of resolveClassExport(node.text, variableOnly)) {
            found.add(instance)
          }
        }
      })
      resolving.delete(key)
      const result = [...found]
      target.set(key, result)
      return result
    }
    for (const name of declarations.keys()) {
      resolveClassExport(name)
      resolveClassExport(name, true)
    }
  }

  const fontAttachments: InventoryFontAttachment[] = []
  for (const file of files) {
    if (!file.path.endsWith("layout.tsx")) continue
    const source = parseScript(file)
    const localImports = new Map<string, { name: string; path: string }>()
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !/(^|\/)fonts$/.test(statement.moduleSpecifier.text)
      ) {
        continue
      }
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        const specifier = statement.moduleSpecifier.text
        const path = specifier.startsWith("@/")
          ? specifier.slice(2)
          : specifier.startsWith(".")
            ? posix.normalize(posix.join(posix.dirname(file.path), specifier))
            : null
        if (!path) continue
        localImports.set(element.name.text, {
          name: element.propertyName?.text ?? element.name.text,
          path: `${path}.ts`,
        })
      }
    }

    // First supported envelope is deliberately conservative about lexical
    // shadowing: an imported name redeclared anywhere in this layout is not a
    // proven font attachment, even when the scopes may actually be disjoint.
    const shadowedImports = new Set<string>()
    walkScript(source, (node) => {
      if (
        (ts.isParameter(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isBindingElement(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        localImports.has(node.name.text)
      ) {
        shadowedImports.add(node.name.text)
      }
    })

    walkScript(source, (node) => {
      if (!ts.isJsxAttribute(node) || node.name.getText(source) !== "className")
        return
      const parent = node.parent.parent
      if (
        (!ts.isJsxOpeningElement(parent) &&
          !ts.isJsxSelfClosingElement(parent)) ||
        parent.tagName.getText(source) !== "html"
      ) {
        return
      }
      const expression = node.initializer
      if (
        !expression ||
        !ts.isJsxExpression(expression) ||
        !expression.expression
      ) {
        return
      }
      const importedExports = new Map<string, { name: string; path: string }>()
      walkScript(expression.expression, (child) => {
        if (ts.isIdentifier(child)) {
          const imported = localImports.get(child.text)
          if (imported)
            importedExports.set(`${imported.path}:${imported.name}`, imported)
        }
      })
      for (const [key, imported] of importedExports) {
        if (!exportedNames.has(key)) continue
        const classExport = imported.name
        const fontInstances = classExports.get(key) ?? []
        const directImport =
          ts.isIdentifier(expression.expression) &&
          !shadowedImports.has(expression.expression.text)
            ? localImports.get(expression.expression.text)
            : undefined
        const variableInstances =
          directImport?.name === imported.name &&
          directImport.path === imported.path
            ? (variableExports.get(key) ?? [])
            : []
        if (fontInstances.length === 0) continue
        const surface = surfaceForLayout(file.path)
        fontAttachments.push({
          sourcePath: file.path,
          surface,
          element: "html",
          classExport,
          fontInstances,
        })
        for (const font of fonts) {
          if (
            fontInstances.includes(font.instanceName) &&
            font.sourcePath === imported.path &&
            !font.attachments.includes(surface)
          ) {
            font.attachments.push(surface)
          }
          if (
            font.sourcePath === imported.path &&
            variableInstances.includes(font.instanceName) &&
            !font.variableAttachments!.includes(surface)
          ) {
            font.variableAttachments!.push(surface)
          }
        }
      }
    })
  }

  return { fonts, fontAttachments }
}

function stringListObjectProperty(
  expression: ts.Expression | undefined,
  name: string
): string[] | null {
  if (
    !expression ||
    !ts.isObjectLiteralExpression(expression) ||
    expression.properties.some(ts.isSpreadAssignment)
  )
    return null
  const matches = expression.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText().replace(/["']/g, "") === name
  )
  if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0])) return null
  const value = matches[0].initializer
  if (ts.isStringLiteralLike(value)) return [value.text]
  if (
    ts.isArrayLiteralExpression(value) &&
    value.elements.every(ts.isStringLiteralLike)
  )
    return value.elements.map((entry) => (entry as ts.StringLiteral).text)
  return null
}

/** Only uniquely registered variables present on every discovered public shell. */
export function publicFontChoices(
  inventory: Pick<DesignSystemInventory, "fonts" | "publicLayoutPaths">
): InventoryFont[] {
  const publicShellCount = new Set(inventory.publicLayoutPaths ?? []).size
  // The bounded first contract supports one public shell, rather than claiming
  // the same variable reaches multiple independently authored layout scopes.
  if (publicShellCount !== 1) return []
  return inventory.fonts.filter(
    (font) =>
      font.variable &&
      /^--[A-Za-z0-9_-]+$/.test(font.variable) &&
      font.capabilities &&
      font.capabilities.styles.includes("normal") &&
      font.variableAttachments?.includes("public-layout") &&
      inventory.fonts.filter((entry) => entry.variable === font.variable)
        .length === 1
  )
}

function findJsxElement(
  source: ts.SourceFile,
  tagName: string
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  let found: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null
  walkScript(source, (node) => {
    if (
      !found &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === tagName
    ) {
      found = node
    }
  })
  return found
}

function stringObjectProperty(
  expression: ts.Expression | undefined,
  propertyName: string
): string | null {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return null
  for (const property of expression.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      property.name.getText().replace(/["']/g, "") !== propertyName ||
      !ts.isStringLiteralLike(property.initializer)
    ) {
      continue
    }
    return property.initializer.text
  }
  return null
}

function surfaceForLayout(path: string): FontAttachmentSurface {
  if (path.includes("/(public)/")) return "public-layout"
  if (path.includes("/(core)/")) return "core-layout"
  return "layout"
}

function addDeclaration(options: {
  node: CssDeclaration
  ancestors: CssNode[]
  sourcePath: string
  sourceHash: string
  declarations: InventoryDeclaration[]
  registerMap: Map<string, MutableRegister>
}): void {
  const { node, ancestors, sourcePath, sourceHash, declarations, registerMap } =
    options
  const atBlocks = ancestors.filter(
    (ancestor): ancestor is CssAtBlock => ancestor.kind === "at-block"
  )
  const atRuleContext = atBlocks.map(({ name, params }) => ({ name, params }))
  const layerPath = atBlocks
    .filter((block) => block.name.toLowerCase() === "layer")
    .map((block) => block.params)
  const selectorPath = ancestors
    .filter((ancestor) => ancestor.kind === "rule")
    .map((rule) => rule.selector)
  const sourceSelector =
    selectorPath.at(-1) ??
    atBlocks
      .at(-1)
      ?.name.concat(
        atBlocks.at(-1)?.params ? ` ${atBlocks.at(-1)?.params}` : ""
      ) ??
    ":root"
  const scope = classifySelector(sourceSelector)
  const kind: RegisterKind = atBlocks.some(
    (block) => block.name.toLowerCase() === "theme"
  )
    ? "theme"
    : scope.register === ":root"
      ? "root"
      : "scoped"
  const registerKey = JSON.stringify([
    sourcePath,
    layerPath,
    scope.register,
    // Do not merge a scoped set with an unrelated global set of the same name.
    ...(scope.publicScoped ? ["public-ui"] : []),
  ])
  const registerId = `register:${digest(registerKey).slice(0, 16)}`
  const declarationId = `declaration:${digest(
    JSON.stringify([
      sourcePath,
      sourceHash,
      layerPath,
      selectorPath,
      node.property,
      node.valueStart,
      node.valueEnd,
    ])
  ).slice(0, 20)}`

  const declaration: InventoryDeclaration = {
    id: declarationId,
    sourcePath,
    sourceHash,
    layerPath,
    selectorPath,
    atRuleContext,
    registerId,
    modeId: scope.mode,
    name: node.property,
    value: node.value,
    start: node.start,
    end: node.end,
    valueStart: node.valueStart,
    valueEnd: node.valueEnd,
    referencedVariables: referencedVariables(node.value),
    ambiguous: false,
  }
  declarations.push(declaration)

  let register = registerMap.get(registerKey)
  if (!register) {
    register = {
      id: registerId,
      kind,
      sourcePath,
      layerPath,
      selector: scope.register,
      modes: new Map(),
      declarationIds: [],
    }
    registerMap.set(registerKey, register)
  }
  register.declarationIds.push(declarationId)

  let mode = register.modes.get(scope.mode)
  if (!mode) {
    mode = {
      id: scope.mode,
      selectors: new Set(),
      declarationIds: [],
    }
    register.modes.set(scope.mode, mode)
  }
  mode.selectors.add(sourceSelector)
  mode.declarationIds.push(declarationId)
}

/** The public boundary may surround a single named set, with an optional dark
 * qualifier. This is a deliberately closed grammar, not general CSS rewriting.
 * Preserve the original arms for edits; only the logical identity is unwrapped.
 */
export function publicScopedSelector(selector: string): {
  register: string
  mode: string
  arms: string[]
} | null {
  const arms = selector.split(",")
  const shapes = arms.map((arm) => {
    const compact = arm.replace(/\s+/g, "")
    const atoms =
      arm.match(
        /\[data-public-ui\]|\[data-register\s*=\s*(?:"[a-z][a-z0-9-]*"|'[a-z][a-z0-9-]*'|[a-z][a-z0-9-]*)\s*\]|\.[A-Za-z_-][\w-]*/g
      ) ?? []
    if (atoms.join("").replace(/\s+/g, "") !== compact || !compact) return null
    if (atoms.filter((atom) => atom === "[data-public-ui]").length !== 1)
      return null
    const dark = atoms.filter((atom) => atom === ".dark").length
    const names = atoms.filter(
      (atom) => atom !== "[data-public-ui]" && atom !== ".dark"
    )
    if (dark > 1 || names.length > 1) return null
    const name = names[0]
    return {
      register: !name
        ? ":root"
        : name.startsWith(".")
          ? name
          : `[data-register="${/=\s*["']?([a-z][a-z0-9-]*)/.exec(name)![1]}"]`,
      mode: dark ? "dark" : "default",
    }
  })
  const first = shapes[0]
  if (
    !first ||
    shapes.some(
      (shape) =>
        !shape || shape.register !== first.register || shape.mode !== first.mode
    )
  )
    return null
  return { ...first, arms }
}

function classifySelector(selector: string): {
  register: string
  mode: string
  publicScoped?: true
} {
  const scoped = publicScopedSelector(selector)
  if (scoped)
    return { register: scoped.register, mode: scoped.mode, publicScoped: true }
  let register = selector.trim()
  const modes: string[] = []

  register = register.replace(/(^|\s)\.dark(?=\s|$)/g, (match, prefix) => {
    modes.push("dark")
    return prefix
  })
  register = register.replace(
    /\[data-(?:theme|mode)\s*=\s*["']?([^\]"']+)["']?\]/gi,
    (_match, value: string) => {
      modes.push(value.trim())
      return ""
    }
  )
  register = register.replace(/\s+/g, " ").trim()
  if (!register || register === ":root") register = ":root"

  return {
    register,
    mode: modes.length > 0 ? [...new Set(modes)].join("+") : "default",
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
