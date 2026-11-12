import type { JSONContent } from "@tiptap/core"
import {
  sanitizeLegacyHtml,
  type RichTextProfile,
} from "@/convex/lib/richtext/profiles"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import { composeRel, type SliceRenderContext } from "@/lib/slices/links"
import { normalizeRenderDocument } from "./tolerant-reader"
import {
  generateRichTextDocument,
  generateRichTextHtml,
  sanitizeAndRenderLegacyHtml,
} from "./legacy-html"

/**
 * Convert a stored rich-text value to trusted HTML for rendering (ADR-0009).
 *
 * Tolerant of legacy data (Phase D migrates it formally): a value that parses to
 * a PM doc is rendered with exactly the profile's extension list — so output can
 * never contain a node the profile disallows. A non-JSON / non-doc value is
 * legacy TipTap HTML and is sanitized to the profile's legacy allowlist. Empty
 * values yield "".
 *
 * When `ctx` is supplied, the PM tree is walked once to (a) resolve any link
 * mark with `pageId` to the page's current localized href (slug-rename
 * survival — the whole reason we store the page id) and (b) compose the `rel`
 * attribute from `openInNewTab` / `noFollow` / `sponsored` / `ugc`. Without
 * `ctx`, rel still gets composed (cheap and locale-independent), but internal
 * links fall back to whatever href was cached at authoring time.
 *
 * Legacy parsing and HTML generation are isolated in `legacy-html.ts`, the
 * only rich-text module that imports the server-DOM-backed `@tiptap/html`.
 */
export function richTextToHtml(
  value: string,
  profile: RichTextProfile,
  ctx?: SliceRenderContext
): string {
  if (!value) return ""
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return sanitizeAndRenderLegacyHtml(value, profile)
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "doc"
  ) {
    const resolved = resolveLinkMarks(parsed, ctx) as JSONContent
    return generateRichTextHtml(resolved, profile)
  }
  const legacyHtml = typeof parsed === "string" ? parsed : value
  return sanitizeAndRenderLegacyHtml(legacyHtml, profile)
}

/**
 * Convert stored rich text to a profile-valid ProseMirror document for React
 * rendering without an HTML injection sink. Legacy HTML is sanitized first,
 * then parsed through the same profile extensions used by the editor.
 */
export function richTextToDocument(
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
    let current: unknown
    try {
      current = JSON.parse(shaped.value)
    } catch {
      return empty
    }
    return resolveLinkMarks(
      normalizeRenderDocument(current, profile),
      ctx
    ) as JSONContent
  }

  const legacyHtml = typeof parsed === "string" ? parsed : value
  const sanitized = sanitizeLegacyHtml(legacyHtml, profile)
  if (!sanitized) return empty

  try {
    return resolveLinkMarks(
      normalizeRenderDocument(
        generateRichTextDocument(sanitized, profile),
        profile
      ),
      ctx
    ) as JSONContent
  } catch {
    return empty
  }
}

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

/** Visibility after applying the exact profile used by the body renderer. */
export function hasVisibleRichText(
  value: unknown,
  profile: RichTextProfile
): boolean {
  if (typeof value !== "string") return false
  const visible = (node: JSONContent): boolean => {
    if (node.type === "text")
      return typeof node.text === "string" && node.text.trim().length > 0
    if (node.type === "image")
      return isRenderableRichTextImageSource(node.attrs?.src)
    if (node.type === "horizontalRule" || node.type === "table") return true
    return Array.isArray(node.content) && node.content.some(visible)
  }
  return visible(richTextToDocument(value, profile))
}

/** Visibility of inline content, normalized exactly as the kit renders it. */
export function hasVisibleInlineRichText(value: unknown): boolean {
  return hasVisibleRichText(value, "inline")
}

/**
 * Walk the PM doc and patch every `link` mark's attrs. Pure — returns a new
 * tree when a mark changes, leaving the input untouched. Cheap enough to run on
 * every render (one pass per rich-text value, no allocations for un-marked
 * branches).
 */
function resolveLinkMarks(
  node: unknown,
  ctx: SliceRenderContext | undefined
): unknown {
  if (typeof node !== "object" || node === null) return node
  const n = node as {
    marks?: unknown
    content?: unknown
  }
  let out: Record<string, unknown> = node as Record<string, unknown>

  if (Array.isArray(n.marks)) {
    let changed = false
    const next = n.marks.map((m) => {
      if (typeof m !== "object" || m === null) return m
      const mark = m as { type?: unknown; attrs?: Record<string, unknown> }
      if (mark.type !== "link") return m
      const a: Record<string, unknown> = mark.attrs ?? {}
      const pageId = typeof a.pageId === "string" ? a.pageId : undefined
      const target = a.target === "_blank"
      const noFollow = a.noFollow === true
      const sponsored = a.sponsored === true
      const ugc = a.ugc === true
      let href = typeof a.href === "string" ? a.href : ""
      if (ctx && pageId) {
        const path = ctx.pagePaths[pageId]
        if (path) href = path
      }
      const rel = composeRel({ openInNewTab: target, noFollow, sponsored, ugc })
      changed = true
      return {
        ...mark,
        attrs: { ...a, href, rel: rel ?? null },
      }
    })
    if (changed) out = { ...out, marks: next }
  }

  if (Array.isArray(n.content)) {
    // Drop empty text nodes ({type:"text", text:""}). ProseMirror's schema
    // rejects them and `generateHTML` throws "Empty text nodes are not allowed",
    // which would 500 the whole public page over one bad node. Stale data from a
    // pre-fix AI translation can still carry these, so the renderer stays tolerant.
    const nextContent = (n.content as unknown[])
      .map((child) => resolveLinkMarks(child, ctx))
      .filter((child) => !isEmptyTextNode(child))
    out = { ...out, content: nextContent }
  }

  return out
}

/** A PM text node whose text is the empty string — invalid per the PM schema. */
function isEmptyTextNode(node: unknown): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: unknown }).type === "text" &&
    (node as { text?: unknown }).text === ""
  )
}
