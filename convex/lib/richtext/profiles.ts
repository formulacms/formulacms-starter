/**
 * Rich-text profiles — the pure, single source of truth for *what a profile
 * allows* (ADR-0009). No TipTap import lives here, so this module is safe to
 * pull into the Convex runtime (the write-path gate) as well as the app.
 *
 * A profile maps to two things that MUST agree:
 *   1. an allowlist of ProseMirror node/mark names (defined here, enforced by
 *      {@link validateDoc} on the write path), and
 *   2. a TipTap extension list (built app-side in `lib/rich-text/extensions.ts`,
 *      used by the editor and `generateHTML` render).
 * `lib/rich-text/extensions.test.ts` asserts the two stay in sync.
 *
 * rich-text values are stored as PM-JSON serialized to a string (Convex cannot
 * recursively type a PM tree without `v.any()`, ADR-0008/0009).
 */

export type RichTextProfile = "inline" | "basic" | "full"

export interface ProfileSpec {
  /** Allowed ProseMirror node type names (always includes `doc` + `text`). */
  readonly nodes: ReadonlySet<string>
  /** Allowed mark type names. */
  readonly marks: ReadonlySet<string>
  /** Allowed `heading` levels; empty when the profile has no heading node. */
  readonly headingLevels: ReadonlySet<number>
}

function spec(
  nodes: string[],
  marks: string[],
  headingLevels: number[] = []
): ProfileSpec {
  return {
    // `doc` + `text` are structural and present in every profile.
    nodes: new Set(["doc", "text", ...nodes]),
    marks: new Set(marks),
    headingLevels: new Set(headingLevels),
  }
}

/**
 * The three frozen v0.1 profiles. Do not widen further without an ADR.
 *  - inline → inline marks only; the paragraph container is structural (subtitles, captions)
 *  - basic  → + H2/H3, bullet/ordered lists (descriptions, CTA body)
 *  - full   → + H1–H6, blockquote, code block, image, hr, tables (post bodies)
 *
 * Semantic-mark set shared across every profile (ADR-0009 amendment 2026-06-05):
 *   bold, italic, strike, underline, highlight, subscript, superscript, link.
 * Rationale: these mark plain text without introducing block structure or
 * agent-controlled URLs/IDs, so they're safe on subtitles and captions yet
 * useful enough that authors expect them on body copy too. Inline `code` stays
 * full-only — it implies monospace formatting that's out of place in display
 * fields. The AI builder still emits bold/italic only (mechanism 2).
 */
const SEMANTIC_MARKS = [
  "bold",
  "italic",
  "strike",
  "underline",
  "highlight",
  "subscript",
  "superscript",
  "link",
]

export const PROFILE_SPECS: Record<RichTextProfile, ProfileSpec> = {
  inline: spec(["paragraph", "hardBreak"], SEMANTIC_MARKS),
  basic: spec(
    [
      "paragraph",
      "hardBreak",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
    ],
    SEMANTIC_MARKS,
    [2, 3]
  ),
  full: spec(
    [
      "paragraph",
      "hardBreak",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "codeBlock",
      "horizontalRule",
      "image",
      // Tables (ADR-0009 amendment 2026-05-30, parity with source repo).
      "table",
      "tableRow",
      "tableHeader",
      "tableCell",
    ],
    [...SEMANTIC_MARKS, "code"],
    [1, 2, 3, 4, 5, 6]
  ),
}

const LEGACY_HTML_TAGS: Record<RichTextProfile, ReadonlySet<string>> = {
  inline: new Set([
    "a",
    "b",
    "br",
    "em",
    "i",
    "mark",
    "p",
    "s",
    "span",
    "strong",
    "sub",
    "sup",
    "u",
  ]),
  basic: new Set([
    "a",
    "b",
    "br",
    "em",
    "h2",
    "h3",
    "i",
    "li",
    "mark",
    "ol",
    "p",
    "s",
    "span",
    "strong",
    "sub",
    "sup",
    "u",
    "ul",
  ]),
  full: new Set([
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ]),
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "")
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:")
  ) {
    return true
  }
  try {
    const url = new URL(trimmed)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function cleanLegacyAttrs(tag: string, attrs: string): string {
  const kept: string[] = []
  const attrPattern =
    /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of attrs.matchAll(attrPattern)) {
    const name = match[1]?.toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ""
    if (!name || name.startsWith("on") || name === "style") continue

    if (tag === "a") {
      if (name === "href") {
        if (!isSafeUrl(value)) continue
        kept.push(`href="${escapeAttribute(value.trim())}"`)
        continue
      }
      if (name === "target" && (value === "_blank" || value === "_self")) {
        kept.push(`target="${value}"`)
        continue
      }
      if (name === "rel" || name === "title" || name === "data-page-id") {
        kept.push(`${name}="${escapeAttribute(value)}"`)
      }
      continue
    }

    if (tag === "img") {
      if (name === "src") {
        if (!isSafeUrl(value)) continue
        kept.push(`src="${escapeAttribute(value.trim())}"`)
        continue
      }
      if (["alt", "height", "title", "width"].includes(name)) {
        kept.push(`${name}="${escapeAttribute(value)}"`)
      }
      continue
    }

    if (
      (tag === "td" || tag === "th") &&
      ["colspan", "rowspan"].includes(name)
    ) {
      kept.push(`${name}="${escapeAttribute(value)}"`)
    }
  }
  return kept.length > 0 ? ` ${kept.join(" ")}` : ""
}

/** Read the clipboard bold cue before arbitrary presentation styles are removed. */
function legacyFontWeight(attrs: string): string {
  const attrPattern =
    /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of attrs.matchAll(attrPattern)) {
    if (match[1]?.toLowerCase() !== "style") continue
    const style = match[2] ?? match[3] ?? match[4] ?? ""
    let weight = ""
    for (const declaration of style.split(";")) {
      const [property, value] = declaration.split(":")
      if (property?.trim().toLowerCase() === "font-weight") {
        weight = (value ?? "")
          .replace(/\s*!important\s*$/i, "")
          .trim()
          .toLowerCase()
      }
    }
    return weight
  }
  return ""
}

export function sanitizeLegacyHtml(
  html: string,
  profile: RichTextProfile
): string {
  const allowedTags = LEGACY_HTML_TAGS[profile]
  const inlineTags = { b: [] as string[], span: [] as string[] }
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<\s*(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
      ""
    )
    .replace(
      /<\s*\/?\s*(script|style|iframe|object|embed|svg|math)\b[^>]*>/gi,
      ""
    )
    .replace(/<\/?([a-zA-Z][\w:-]*)([^<>]*)>/g, (raw, tagName, attrs) => {
      const tag = String(tagName).toLowerCase()
      if (!allowedTags.has(tag)) return ""
      if (tag === "b" || tag === "span") {
        const tags = inlineTags[tag]
        if (raw.startsWith("</")) return `</${tags.pop() ?? tag}>`
        const weight = legacyFontWeight(String(attrs ?? ""))
        // Match installed TipTap Bold's b guard and font-weight parse rule.
        // Google Docs wraps mixed formatting in b[style="font-weight:normal"].
        const semanticTag =
          tag === "b" && weight === "normal"
            ? "span"
            : tag === "span" && /^(bold(er)?|[5-9]\d{2,})$/.test(weight)
              ? "strong"
              : tag
        tags.push(semanticTag)
        return `<${semanticTag}>`
      }
      if (raw.startsWith("</")) return `</${tag}>`
      if (tag === "br" || tag === "hr") return `<${tag}>`
      return `<${tag}${cleanLegacyAttrs(tag, String(attrs ?? ""))}>`
    })
}

/** Minimal shape of a ProseMirror node as it appears in serialized PM-JSON. */
interface PMNode {
  type?: unknown
  attrs?: Record<string, unknown>
  content?: unknown
  marks?: unknown
}

function isPMNode(value: unknown): value is PMNode {
  return typeof value === "object" && value !== null
}

/**
 * Validate a serialized rich-text value against a profile.
 *
 * Lenient by contract (matches the editor/render legacy-tolerance): only a value
 * that parses to a real PM doc (`{ type: "doc", ... }`) is inspected. A parse
 * failure, an empty string, or any non-doc shape is treated as legacy HTML / not
 * yet migrated and passes — it gets validated the next time the editor rewrites
 * it as JSON. The check only fires on genuine drift or hand-crafted input, since
 * the editor's extension list == the profile's allowlist (it can't author a
 * disallowed node).
 *
 * Pure: no TipTap, no DOM. Safe to call inside a Convex mutation.
 */
export function validateDoc(
  json: string,
  profile: RichTextProfile
): { ok: true } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: true } // legacy HTML or non-JSON — skip
  }
  if (!isPMNode(parsed) || parsed.type !== "doc") {
    return { ok: true } // not a PM document — skip
  }

  const { nodes, marks, headingLevels } = PROFILE_SPECS[profile]

  function walk(node: PMNode): string | null {
    const type = node.type
    if (typeof type !== "string") return "node missing a string `type`"
    if (!nodes.has(type))
      return `node "${type}" is not allowed in profile "${profile}"`

    if (type === "heading") {
      const level = node.attrs?.level
      if (typeof level === "number" && !headingLevels.has(level)) {
        return `heading level ${level} is not allowed in profile "${profile}"`
      }
    }

    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        const markType = isPMNode(mark) ? mark.type : undefined
        if (typeof markType !== "string") return "mark missing a string `type`"
        if (!marks.has(markType)) {
          return `mark "${markType}" is not allowed in profile "${profile}"`
        }
      }
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (!isPMNode(child)) return "content child is not a node"
        const err = walk(child)
        if (err) return err
      }
    }
    return null
  }

  const error = walk(parsed)
  return error ? { ok: false, error } : { ok: true }
}
