import { Fragment, createElement, type Key, type ReactNode } from "react"
import type { JSONContent } from "@tiptap/core"

import {
  sanitizeLegacyHtml,
  PROFILE_SPECS,
  validateDoc,
  type RichTextProfile,
} from "@/convex/lib/richtext/profiles"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import { composeRel, type SliceRenderContext } from "@/lib/slices/links"
import { cn } from "@/lib/utils"
import { generateRichTextDocument } from "@/lib/rich-text/legacy-html"

type RichTextAttrs = Record<string, unknown>

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

/** Keep kit emptiness aligned with the exact URL policy used for rich-text media. */
export function isRenderableRichTextImageSource(value: unknown): boolean {
  return safeUrl(value) !== undefined
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Frozen b4d7c790 reader retained for the old-valid-subset oracle. */
function baselineRichTextToDocument(
  value: string,
  profile: RichTextProfile,
  ctx?: SliceRenderContext
): JSONContent {
  const empty: JSONContent = { type: "doc", content: [] }
  if (!value) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    parsed = undefined
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "doc"
  ) {
    const shaped = toFieldShape(resolveFieldContract(profile), value)
    if (!validateDoc(shaped.value, profile).ok) return empty
    let current: unknown
    try {
      current = JSON.parse(shaped.value)
    } catch {
      return empty
    }
    return resolveBaselineLinkMarks(current, ctx) as JSONContent
  }

  const legacyHtml = typeof parsed === "string" ? parsed : value
  const sanitized = sanitizeLegacyHtml(legacyHtml, profile)
  if (!sanitized) return empty

  try {
    return resolveBaselineLinkMarks(
      generateRichTextDocument(sanitized, profile),
      ctx
    ) as JSONContent
  } catch {
    return empty
  }
}

function resolveBaselineLinkMarks(
  node: unknown,
  ctx: SliceRenderContext | undefined
): unknown {
  if (typeof node !== "object" || node === null) return node
  const current = node as { marks?: unknown; content?: unknown }
  let output: Record<string, unknown> = node as Record<string, unknown>

  if (Array.isArray(current.marks)) {
    let changed = false
    const marks = current.marks.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return candidate
      const mark = candidate as {
        type?: unknown
        attrs?: Record<string, unknown>
      }
      if (mark.type !== "link") return candidate
      const attrs: Record<string, unknown> = mark.attrs ?? {}
      const pageId = typeof attrs.pageId === "string" ? attrs.pageId : undefined
      const target = attrs.target === "_blank"
      const noFollow = attrs.noFollow === true
      const sponsored = attrs.sponsored === true
      const ugc = attrs.ugc === true
      let href = typeof attrs.href === "string" ? attrs.href : ""
      if (ctx && pageId) {
        const path = ctx.pagePaths[pageId]
        if (path) href = path
      }
      const rel = composeRel({ openInNewTab: target, noFollow, sponsored, ugc })
      changed = true
      return { ...mark, attrs: { ...attrs, href, rel: rel ?? null } }
    })
    if (changed) output = { ...output, marks }
  }

  if (Array.isArray(current.content)) {
    const content = current.content
      .map((child) => resolveBaselineLinkMarks(child, ctx))
      .filter((child) => !isEmptyTextNode(child))
    output = { ...output, content }
  }
  return output
}

function isEmptyTextNode(node: unknown): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: unknown }).type === "text" &&
    (node as { text?: unknown }).text === ""
  )
}

function renderMarks(
  text: ReactNode,
  marks: JSONContent["marks"],
  profile: RichTextProfile,
  key: Key
): ReactNode {
  if (!Array.isArray(marks)) return text
  const marked = marks.reduce<ReactNode>((content, mark) => {
    const type = mark.type
    if (!type || !PROFILE_SPECS[profile].marks.has(type)) return content
    switch (type) {
      case "bold":
        return <strong>{content}</strong>
      case "italic":
        return <em>{content}</em>
      case "strike":
        return <s>{content}</s>
      case "underline":
        return <u>{content}</u>
      case "highlight":
        return <mark>{content}</mark>
      case "subscript":
        return <sub>{content}</sub>
      case "superscript":
        return <sup>{content}</sup>
      case "code":
        return <code>{content}</code>
      case "link": {
        const attrs = (mark.attrs ?? {}) as RichTextAttrs
        const href = safeUrl(attrs.href)
        if (!href) return content
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
            {...(stringAttr(attrs.title)
              ? { title: stringAttr(attrs.title) }
              : {})}
            {...(stringAttr(attrs.pageId)
              ? { "data-page-id": stringAttr(attrs.pageId) }
              : {})}
          >
            {content}
          </a>
        )
      }
      default:
        return content
    }
  }, text)
  return <Fragment key={key}>{marked}</Fragment>
}

function renderChildren(
  node: JSONContent,
  profile: RichTextProfile,
  key: Key
): ReactNode[] {
  if (!Array.isArray(node.content)) return []
  return node.content.map((child, index) =>
    renderNode(child, profile, `${String(key)}-${index}`)
  )
}

function renderNode(
  node: JSONContent,
  profile: RichTextProfile,
  key: Key
): ReactNode {
  const type = node.type
  if (!type || !PROFILE_SPECS[profile].nodes.has(type)) return null

  if (type === "text") {
    if (typeof node.text !== "string") return null
    return renderMarks(node.text, node.marks, profile, key)
  }

  const attrs = (node.attrs ?? {}) as RichTextAttrs
  const children = renderChildren(node, profile, key)
  switch (type) {
    case "doc":
      return <Fragment key={key}>{children}</Fragment>
    case "paragraph":
      return profile === "inline" ? (
        <Fragment key={key}>{children}</Fragment>
      ) : (
        <p key={key}>{children}</p>
      )
    case "hardBreak":
      return <br key={key} />
    case "heading": {
      const level = positiveInteger(attrs.level)
      if (!level || !PROFILE_SPECS[profile].headingLevels.has(level))
        return null
      return createElement(`h${level}`, { key }, children)
    }
    case "bulletList":
      return <ul key={key}>{children}</ul>
    case "orderedList":
      return (
        <ol
          key={key}
          {...(positiveInteger(attrs.start)
            ? { start: positiveInteger(attrs.start) }
            : {})}
        >
          {children}
        </ol>
      )
    case "listItem":
      return <li key={key}>{children}</li>
    case "blockquote":
      return <blockquote key={key}>{children}</blockquote>
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{children}</code>
        </pre>
      )
    case "horizontalRule":
      return <hr key={key} />
    case "image": {
      const src = safeUrl(attrs.src)
      if (!src) return null
      // A native image is deliberate for CMS-authored runtime URLs: unlike
      // next/image, it does not require every possible remote host in the
      // deployment's static remotePatterns configuration.
      return createElement("img", {
        key,
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
    case "table":
      return (
        <table key={key}>
          <tbody>{children}</tbody>
        </table>
      )
    case "tableRow":
      return <tr key={key}>{children}</tr>
    case "tableHeader":
      return (
        <th
          key={key}
          {...(positiveInteger(attrs.colspan)
            ? { colSpan: positiveInteger(attrs.colspan) }
            : {})}
          {...(positiveInteger(attrs.rowspan)
            ? { rowSpan: positiveInteger(attrs.rowspan) }
            : {})}
        >
          {children}
        </th>
      )
    case "tableCell":
      return (
        <td
          key={key}
          {...(positiveInteger(attrs.colspan)
            ? { colSpan: positiveInteger(attrs.colspan) }
            : {})}
          {...(positiveInteger(attrs.rowspan)
            ? { rowSpan: positiveInteger(attrs.rowspan) }
            : {})}
        >
          {children}
        </td>
      )
    default:
      return null
  }
}

function inlineDocumentChildren(document: JSONContent): ReactNode[] {
  const blocks = document.content ?? []
  return blocks.flatMap((node, index) => {
    const rendered = renderNode(node, "inline", `inline-${index}`)
    return index === 0
      ? [rendered]
      : [
          <br key={`inline-gap-${index}-a`} />,
          <br key={`inline-gap-${index}-b`} />,
          rendered,
        ]
  })
}

/** Render profile-constrained rich text as React elements, never raw HTML. */
/** Frozen F1 source-test oracle. Do not import from production modules. */
export function LegacyRichTextWalkerOracle({
  value,
  profile,
  ctx,
  className,
  fieldPath,
}: {
  value: string
  profile: RichTextProfile
  ctx?: SliceRenderContext
  className?: string
  fieldPath?: string
}) {
  const document = baselineRichTextToDocument(value, profile, ctx)
  return renderFrozenDocument(document, profile, className, { value, ctx, fieldPath })
}

/** Frozen R1 parsed document for independent R2b schema canonicalization. */
export function frozenDocumentFor(
  value: string,
  profile: RichTextProfile,
  ctx?: SliceRenderContext
): JSONContent {
  return baselineRichTextToDocument(value, profile, ctx)
}

/** Direct-document entry for independently canonicalized R2b oracle fixtures. */
export function renderFrozenDocument(
  document: JSONContent,
  profile: RichTextProfile,
  className?: string,
  preview?: { value: string; ctx?: SliceRenderContext; fieldPath?: string }
) {
  const linkClasses =
    "[&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4 [&_a]:transition-colors [&_a]:hover:text-brand [&_a]:focus-visible:outline [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2"

  const classes =
    profile === "inline"
      ? cn(linkClasses, className)
      : cn(
          "prose max-w-none prose-neutral dark:prose-invert",
          linkClasses,
          className,
          // ED10b 2026-11-09: basic-field paragraph gap from approved prototype 47221a3f.
          profile === "basic" && "[&>p]:m-0 [&>p+p]:mt-[0.75em]"
        )
  const rendered =
    profile === "inline" ? (
      <span className={classes}>{inlineDocumentChildren(document)}</span>
    ) : (
      <div className={classes}>{renderNode(document, profile, "doc")}</div>
    )
  return preview?.fieldPath && preview.ctx?.previewRichText
    ? preview.ctx.previewRichText({
        fieldPath: preview.fieldPath,
        value: preview.value,
        profile,
        className: classes,
        rendered,
      })
    : rendered
}
