import type { ReactNode } from "react"
import type { RichTextProfile } from "@/convex/lib/richtext/profiles"
import type { Slice, CMSLinkField } from "@/convex/lib/slices"
import type { Id } from "@/convex/_generated/dataModel"
import type { RelationCard } from "@/convex/lib/slices/resolve"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import type { SliceFieldOutline } from "./page-outline"
import type { FieldContract } from "@/convex/lib/richtext/contracts"

/** Context needed to resolve links and render slices on the public site. */
export type SliceRenderContext = {
  /** Per-occurrence display outline, supplied by SliceZone. */
  outline?: SliceFieldOutline
  /** Per-occurrence accessible-name override, supplied by SliceZone only on collision. */
  regionLabel?: string
  /** Content locale used by link and relation resolution. */
  locale: string
  /** Requested public locale for fixed copy; legacy callers use `locale`. */
  presentationLocale?: string
  defaultLocale: string
  /** Present for public renders; previews/simulator use the legacy v0 envelope. */
  languageVersion?: number
  /** Installed source catalog; required when an occurrence records a choice. */
  presentationCatalog?: SlicePresentationCatalog
  /**
   * Map of page id -> full, locale-prefixed public path, pre-built for internal
   * links (e.g. "/fr/mes-produits/produit-1"). Already canonical, so hrefs need
   * no further prefixing and don't trigger a 308 redirect.
   */
  pagePaths: Record<string, string>
  /**
   * Map of related page id -> depth-1 card projection. `null` means the stored
   * relation is dangling or points at content hidden for this render mode.
   */
  relationCards?: Record<string, RelationCard | null>
  /** Admin-only occurrence interception; public SliceZone wrappers stay canonical. */
  previewSlice?: (
    slice: Slice,
    render: (context: SliceRenderContext) => ReactNode
  ) => ReactNode
  /** Admin-only renderer interception; absent on public renders. */
  previewRichText?: (field: {
    fieldPath: string
    value: string
    profile: RichTextProfile
    contract?: FieldContract
    headingFloor?: number
    className: string
    rendered: ReactNode
  }) => ReactNode
  /** Admin-only interception for exact, descriptor-bound non-rich-text fields. */
  previewField?: (field: {
    fieldPath: string
    kind: string
    rendered: ReactNode
  }) => ReactNode
  /** Marks an occurrence whose renderer is bound to descriptor field paths. */
  previewKitSlice?: (rendered: ReactNode) => ReactNode
}

const URL_SCHEME = /^([a-z][a-z\d+.-]*):/i
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const URL_ENCODED_CONTROLS = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i
// Reserved origin used only to classify app-relative media references.
const MEDIA_RELATIVE_BASE = new URL("https://formulacms.invalid/")

function hasUnsafeUrlCharacters(value: string): boolean {
  return (
    URL_CONTROL_CHARACTERS.test(value) ||
    value !== value.trim() ||
    value.includes("\\")
  )
}

function safeHttpHref(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function safeMailtoHref(value: string): string | undefined {
  const recipientList = value.slice("mailto:".length).split("?", 1)[0]
  const hasQuery = value.includes("?")
  if (
    (!recipientList && !hasQuery) ||
    recipientList.startsWith("//") ||
    recipientList.includes(":") ||
    /[\s<>]/.test(recipientList) ||
    URL_ENCODED_CONTROLS.test(value)
  ) {
    return undefined
  }
  return value
}

function safeTelHref(value: string): string | undefined {
  const numberAndParams = value.slice("tel:".length)
  const [number, ...params] = numberAndParams.split(";")
  if (
    !number ||
    !/[0-9]/.test(number) ||
    !/^[+0-9().*#,\-\s]+$/.test(number) ||
    params.some(
      (param) => !/^(?:ext|isub|phone-context)=[+a-z0-9.-]+$/i.test(param)
    ) ||
    URL_ENCODED_CONTROLS.test(value)
  ) {
    return undefined
  }
  return value
}

function safeExternalHref(value: string): string | undefined {
  if (hasUnsafeUrlCharacters(value)) return undefined
  const scheme = URL_SCHEME.exec(value)?.[1]?.toLowerCase()
  switch (scheme) {
    case "http":
    case "https":
      return safeHttpHref(value)
    case "mailto":
      return safeMailtoHref(value)
    case "tel":
      return safeTelHref(value)
    default:
      return undefined
  }
}

function safeMediaHref(value: string): string | undefined {
  // A protocol-relative URL names another host, so it is not app-relative.
  if (hasUnsafeUrlCharacters(value) || value.startsWith("//")) return undefined
  const scheme = URL_SCHEME.exec(value)?.[1]?.toLowerCase()
  if (scheme) {
    return scheme === "http" || scheme === "https"
      ? safeHttpHref(value)
      : undefined
  }
  try {
    const parsed = new URL(value, MEDIA_RELATIVE_BASE)
    return parsed.origin === MEDIA_RELATIVE_BASE.origin ? value : undefined
  } catch {
    return undefined
  }
}

function safeInternalHref(value: string | undefined): string | undefined {
  if (
    !value ||
    hasUnsafeUrlCharacters(value) ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return undefined
  }
  return value
}

/** Resolve a CMS link field to an href, or undefined when it points nowhere. */
export function linkToHref(
  link: CMSLinkField | undefined,
  ctx: SliceRenderContext
): string | undefined {
  if (!link) return undefined
  switch (link.type) {
    case "external":
      return link.url ? safeExternalHref(link.url) : undefined
    case "anchor": {
      if (!link.anchor || hasUnsafeUrlCharacters(link.anchor)) return undefined
      const anchor = link.anchor.replace(/^#/, "")
      return anchor ? `#${anchor}` : undefined
    }
    case "media":
      return link.url ? safeMediaHref(link.url) : undefined
    case "internal": {
      if (!link.pageId) return undefined
      return safeInternalHref(ctx.pagePaths[link.pageId])
    }
    case "none":
    default:
      return undefined
  }
}

/**
 * Compose the `rel` attribute from link flags. `openInNewTab` implies
 * `noopener noreferrer` (security); the SEO/trust flags are additive.
 * Returns undefined when no rel is needed so callers can spread conditionally.
 */
export function composeRel(opts: {
  openInNewTab?: boolean
  noFollow?: boolean
  sponsored?: boolean
  ugc?: boolean
}): string | undefined {
  const parts: string[] = []
  if (opts.openInNewTab) parts.push("noopener", "noreferrer")
  if (opts.noFollow) parts.push("nofollow")
  if (opts.sponsored) parts.push("sponsored")
  if (opts.ugc) parts.push("ugc")
  return parts.length ? parts.join(" ") : undefined
}

/**
 * Gather every internal-link target id across a set of slices, de-duplicated.
 * Walks both structured link fields (button items) and rich-text values
 * (link marks with a `pageId` attr embedded in PM-JSON), so the public renderer
 * can batch-fetch every page slug it needs in one query.
 */
export function collectPageIds(slices: Slice[]): Id<"pages">[] {
  const ids = new Set<string>()
  for (const slice of slices) collectFromValue(slice, ids)
  return [...ids] as Id<"pages">[]
}

function collectFromValue(value: unknown, out: Set<string>): void {
  if (value == null) return
  if (typeof value === "string") {
    // Rich-text fields are stored as PM-JSON strings; walk for link marks.
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      return
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "doc"
    ) {
      collectFromPMNode(parsed, out)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectFromValue(v, out)
    return
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    // Structured link field on a button or similar item.
    if (
      obj.type === "internal" &&
      typeof obj.pageId === "string" &&
      obj.pageId.length > 0
    ) {
      out.add(obj.pageId)
    }
    for (const v of Object.values(obj)) collectFromValue(v, out)
  }
}

function collectFromPMNode(node: unknown, out: Set<string>): void {
  if (typeof node !== "object" || node === null) return
  const n = node as { marks?: unknown; content?: unknown }
  if (Array.isArray(n.marks)) {
    for (const m of n.marks) {
      if (typeof m !== "object" || m === null) continue
      const mark = m as { type?: unknown; attrs?: Record<string, unknown> }
      if (mark.type === "link") {
        const pageId = mark.attrs?.pageId
        if (typeof pageId === "string" && pageId.length > 0) out.add(pageId)
      }
    }
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) collectFromPMNode(child, out)
  }
}
