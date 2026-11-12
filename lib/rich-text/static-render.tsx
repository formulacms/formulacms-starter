import { Fragment, createElement, type ReactNode } from "react"
import {
  getAttributesFromExtensions,
  getSchema,
  resolveExtensions,
  splitExtensions,
  type Extensions,
} from "@tiptap/core"
import { Node, type Mark } from "@tiptap/pm/model"
import {
  domOutputSpecToReactElement,
  mapMarkExtensionToReactNode,
  mapNodeExtensionToReactNode,
  renderToReactElement,
} from "@tiptap/static-renderer/pm/react"

import {
  contractSpec,
  type FieldContract,
} from "@/convex/lib/richtext/contracts"
import { composeRel } from "@/lib/slices/links"
import { extensionsForContract } from "./extensions"
import { renderLinkedChildren } from "./link-grouping"
import { normalizeRenderDocument } from "./tolerant-reader"
import {
  bodyHeadingLevels,
  createBodyHeadingResolver,
} from "@/lib/slices/page-outline"

type RichTextAttrs = Record<string, unknown>
type RendererOptions = NonNullable<
  Parameters<typeof renderToReactElement>[0]["options"]
>
type NodeRenderer = NonNullable<RendererOptions["nodeMapping"]>[string]
type MarkRenderer = NonNullable<RendererOptions["markMapping"]>[string]
type NodeProps = Parameters<NodeRenderer>[0]

type ContractRenderer = {
  extensions: Extensions
  schema: ReturnType<typeof getSchema>
  nodeMapping: Record<string, NodeRenderer>
  markMapping: Record<string, MarkRenderer>
}

const rendererCache = new Map<FieldContract, ContractRenderer>()

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  const compact = trimmed.replace(/[\u0000-\u001f\u007f\s]+/g, "")
  if (
    compact.startsWith("/") ||
    compact.startsWith("#") ||
    compact.startsWith("mailto:") ||
    compact.startsWith("tel:")
  ) {
    return trimmed
  }
  try {
    const url = new URL(compact)
    return url.protocol === "http:" || url.protocol === "https:"
      ? trimmed
      : undefined
  } catch {
    return undefined
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function attrsOf(value: unknown): RichTextAttrs {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RichTextAttrs)
    : {}
}

function warnOncePerField(): () => void {
  let warned = false
  return () => {
    if (warned || process.env.NODE_ENV === "production") return
    warned = true
    console.warn(
      "Rich text rendering failed; the affected field or node was omitted."
    )
  }
}

function inlineChildren(
  children: ReactNode | ReactNode[] | undefined
): ReactNode[] {
  const blocks = Array.isArray(children)
    ? children
    : children === undefined
      ? []
      : [children]
  return blocks.flatMap((child, index) =>
    index === 0
      ? [child]
      : [
          <br key={`inline-gap-${index}-a`} />,
          <br key={`inline-gap-${index}-b`} />,
          child,
        ]
  )
}

function contractRenderer(contract: FieldContract): ContractRenderer {
  const cached = rendererCache.get(contract)
  if (cached) return cached

  const extensions = extensionsForContract(contract)
  const resolvedExtensions = resolveExtensions(extensions)
  const schema = getSchema(extensions)
  const attributes = getAttributesFromExtensions(resolvedExtensions)
  const { nodeExtensions, markExtensions } = splitExtensions(resolvedExtensions)
  const nodeMapping: Record<string, NodeRenderer> = Object.create(null)
  const markMapping: Record<string, MarkRenderer> = Object.create(null)

  for (const extension of nodeExtensions) {
    const [name, handler] = mapNodeExtensionToReactNode(
      domOutputSpecToReactElement,
      extension,
      attributes
    )
    nodeMapping[name] = handler
  }
  for (const extension of markExtensions) {
    const [name, handler] = mapMarkExtensionToReactNode(
      domOutputSpecToReactElement,
      extension,
      attributes
    )
    markMapping[name] = handler
  }

  const result = { extensions, schema, nodeMapping, markMapping }
  rendererCache.set(contract, result)
  return result
}

function linkElement(mark: Mark, children: ReactNode): ReactNode {
  const attrs = attrsOf(mark.attrs)
  const href = safeUrl(attrs.href)
  if (!href) return children
  const target =
    attrs.target === "_blank" || attrs.target === "_self"
      ? attrs.target
      : undefined
  const rel = composeRel({
    openInNewTab: target === "_blank",
    noFollow: attrs.noFollow === true,
    sponsored: attrs.sponsored === true,
    ugc: attrs.ugc === true,
  })
  return (
    <a
      href={href}
      {...(target ? { target } : {})}
      {...(rel ? { rel } : {})}
      {...(stringAttr(attrs.title) ? { title: stringAttr(attrs.title) } : {})}
      {...(stringAttr(attrs.pageId)
        ? { "data-page-id": stringAttr(attrs.pageId) }
        : {})}
    >
      {children}
    </a>
  )
}

function safeNode(handler: NodeRenderer, warn: () => void): NodeRenderer {
  return (props) => {
    try {
      const children = renderLinkedChildren(
        props.node,
        (node, parent) => props.renderElement({ content: node, parent }),
        (mark, groupedChildren) => linkElement(mark, groupedChildren)
      )
      if (children === undefined) return handler(props)
      const groupedProps: NodeProps = {
        node: props.node,
        parent: props.parent,
        children,
        renderElement: props.renderElement,
      }
      return handler(groupedProps)
    } catch {
      warn()
      return null
    }
  }
}

function safeMark(handler: MarkRenderer, warn: () => void): MarkRenderer {
  return (props) => {
    if (!props.node.isText) return props.children
    try {
      return handler(props)
    } catch {
      warn()
      return null
    }
  }
}

function renderMappings(
  contract: FieldContract,
  cached: ContractRenderer,
  warn: () => void,
  headingLevels?: ReadonlyMap<number, number>
): {
  nodeMapping: Record<string, NodeRenderer>
  markMapping: Record<string, MarkRenderer>
} {
  const nodeMapping: Record<string, NodeRenderer> = Object.create(null)
  const markMapping: Record<string, MarkRenderer> = Object.create(null)

  for (const [name, handler] of Object.entries(cached.nodeMapping)) {
    nodeMapping[name] = safeNode(handler, warn)
  }
  for (const [name, handler] of Object.entries(cached.markMapping)) {
    markMapping[name] = safeMark(handler, warn)
  }

  const spec = contractSpec(contract)
  const ownedNodes: Record<string, NodeRenderer> = Object.create(null)
  ownedNodes.doc = ({ children }) =>
    contract === "inline" ? (
      inlineChildren(children)
    ) : (
      <Fragment>{children}</Fragment>
    )
  ownedNodes.text = ({ node }) => node.text ?? ""

  if (contract === "inline") {
    ownedNodes.paragraph = ({ children }) => <Fragment>{children}</Fragment>
  }
  if (spec.nodes.has("heading")) {
    const resolveHeading = createBodyHeadingResolver(headingLevels)
    ownedNodes.heading = ({ node, children }) => {
      const level = positiveInteger(attrsOf(node.attrs).level)
      if (!level || !spec.headingLevels.has(level)) return null
      const renderedLevel = resolveHeading(level, node.textContent)
      if (renderedLevel === null) return null
      return createElement(`h${renderedLevel}`, null, children)
    }
  }
  if (spec.nodes.has("image")) {
    ownedNodes.image = ({ node }) => {
      const attrs = attrsOf(node.attrs)
      const src = safeUrl(attrs.src)
      if (!src) return null
      return createElement("img", {
        src,
        alt: stringAttr(attrs.alt) ?? "",
        ...(stringAttr(attrs.title) ? { title: stringAttr(attrs.title) } : {}),
        ...(positiveInteger(attrs.width)
          ? { width: positiveInteger(attrs.width) }
          : {}),
        ...(positiveInteger(attrs.height)
          ? { height: positiveInteger(attrs.height) }
          : {}),
      })
    }
  }
  if (spec.nodes.has("table")) {
    ownedNodes.table = ({ children }) => (
      <table>
        <tbody>{children}</tbody>
      </table>
    )
    ownedNodes.tableRow = ({ children }) => <tr>{children}</tr>
    ownedNodes.tableHeader = ({ node, children }) => {
      const attrs = attrsOf(node.attrs)
      const colspan = positiveInteger(attrs.colspan)
      const rowspan = positiveInteger(attrs.rowspan)
      return (
        <th
          {...(colspan && colspan > 1 ? { colSpan: colspan } : {})}
          {...(rowspan && rowspan > 1 ? { rowSpan: rowspan } : {})}
        >
          {children}
        </th>
      )
    }
    ownedNodes.tableCell = ({ node, children }) => {
      const attrs = attrsOf(node.attrs)
      const colspan = positiveInteger(attrs.colspan)
      const rowspan = positiveInteger(attrs.rowspan)
      return (
        <td
          {...(colspan && colspan > 1 ? { colSpan: colspan } : {})}
          {...(rowspan && rowspan > 1 ? { rowSpan: rowspan } : {})}
        >
          {children}
        </td>
      )
    }
  }
  if (spec.nodes.has("orderedList")) {
    ownedNodes.orderedList = ({ node, children }) => {
      const start = positiveInteger(attrsOf(node.attrs).start)
      return <ol {...(start && start !== 1 ? { start } : {})}>{children}</ol>
    }
  }
  if (spec.nodes.has("codeBlock")) {
    ownedNodes.codeBlock = ({ children }) => (
      <pre>
        <code>{children}</code>
      </pre>
    )
  }

  for (const [name, handler] of Object.entries(ownedNodes)) {
    nodeMapping[name] = safeNode(handler, warn)
  }

  if (spec.marks.has("link")) {
    markMapping.link = safeMark(
      ({ mark, children }) => linkElement(mark, children),
      warn
    )
  }

  return { nodeMapping, markMapping }
}

/** Render a normalized field with the cached ProseMirror schema and PM renderer. */
export function renderStaticRichTextDocument(
  document: unknown,
  contract: FieldContract,
  options: { headingFloor?: number } = {}
): ReactNode {
  const warn = warnOncePerField()
  try {
    const rootContent =
      typeof document === "object" &&
      document !== null &&
      !Array.isArray(document)
        ? (document as { content?: unknown }).content
        : undefined
    if (
      contract === "inline" &&
      rootContent !== undefined &&
      rootContent !== null &&
      !Array.isArray(rootContent)
    ) {
      warn()
      return null
    }

    const cached = contractRenderer(contract)
    const normalized = normalizeRenderDocument(document, contract)
    const content = Node.fromJSON(cached.schema, normalized)
    const mappings = renderMappings(
      contract,
      cached,
      warn,
      options.headingFloor === undefined
        ? undefined
        : bodyHeadingLevels(normalized, options.headingFloor)
    )
    return renderToReactElement({
      content,
      extensions: cached.extensions,
      options: mappings,
    })
  } catch {
    warn()
    return null
  }
}
