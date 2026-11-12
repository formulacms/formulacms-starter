/**
 * Plain text → paragraph PM-JSON for AI-generated content (ADR-013).
 *
 * The content writer agent emits plain text (one model call per slice, labeled
 * fields). Rich-text fields receive their value through this helper so that
 * what reaches the editor / write-path is always a valid PM doc — never an
 * HTML string the model invented. With `emphasis: true` the builder also
 * parses Markdown-style `**bold**` and `*italic*` (or `_italic_`) into bold /
 * italic marks. It NEVER emits `link`, `image`, `code`, or any other mark or
 * node that could ride a URL or arbitrary attribute, so mechanism 2 (no
 * agent-controlled hrefs / srcs / ids) stays intact.
 *
 * The `profile` parameter is forward-compat / call-site documentation: the
 * node types we emit (`doc`, `paragraph`, `text`) and the marks we emit
 * (`bold`, `italic`) are present in every v0.1 profile.
 *
 * Pure: no TipTap, no DOM. Safe inside a Convex action.
 */
import { lexer, type Token, type Tokens } from "marked"
import {
  PROFILE_SPECS,
  type ProfileSpec,
  type RichTextProfile,
} from "./profiles"
import {
  resolveFieldContract,
  type FieldContract,
  type HeadingRole,
  type RichTextContractConfig,
} from "./contracts"
import { toFieldShape } from "./shape"
import { validateStrict } from "./strict"

export interface PMMark {
  type: "bold" | "italic"
}
export interface PMTextNode {
  type: "text"
  text: string
  marks?: PMMark[]
}
export interface PMHardBreakNode {
  type: "hardBreak"
}
export type PMInlineNode = PMTextNode | PMHardBreakNode
export interface PMParagraph {
  type: "paragraph"
  content?: PMTextNode[]
}
export interface PMDoc {
  type: "doc"
  content: PMParagraph[]
}

export interface BuildPMDocOptions {
  /** Parse Markdown `**bold**` and `*italic*` / `_italic_` into marks. Default
   *  false — keeps the historical mark-free behavior for callers that don't
   *  want emphasis. Even when true, only `bold` and `italic` marks are ever
   *  emitted; `link`, `image`, `code` and friends are never produced. */
  emphasis?: boolean
  /** Turn Markdown headings (`## x`), bullet lists and ordered lists into the
   *  matching document nodes, but only for a contract that allows them. A
   *  result the save validation would refuse falls back to the paragraph
   *  result, so text is never lost. Used by the content writer only. */
  markdown?: boolean
}

/**
 * Build a PM doc from text. Splits on blank lines into paragraphs and
 * collapses soft-wrapped single newlines into a single space within a paragraph
 * (simpler than emitting hardBreaks, and the validator accepts either). Trims
 * each paragraph; empty input yields one empty paragraph (legal in every
 * profile) rather than an empty doc.
 */
export function buildPMDoc(
  text: string,

  _profile: RichTextProfile,
  options: BuildPMDocOptions = {}
): PMDoc {
  const paragraphs = text
    .split(/\n[ \t]*\n+/) // blank-line separator (tolerates trailing whitespace)
    .map((para) => para.replace(/\s*\n\s*/g, " ").trim())
    .filter((para) => para.length > 0)

  if (paragraphs.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] }
  }

  return {
    type: "doc",
    content: paragraphs.map((para): PMParagraph => ({
      type: "paragraph",
      content: options.emphasis
        ? parseEmphasis(para)
        : [{ type: "text", text: para }],
    })),
  }
}

/** Contract-aware builder for internal/ready title callers. Existing profile
 * callers keep their historical paragraph-only return shape. */
export function buildPMDocForContract(
  text: string,
  config: RichTextContractConfig,
  options: BuildPMDocOptions = {}
):
  | PMDoc
  | {
      type: "doc"
      content: Array<{
        type: string
        attrs?: { level: number }
        content?: PMInlineNode[]
      }>
    } {
  return buildFieldDoc(text, config, undefined, options)
}

/** Build the canonical document shape for one configured rich-text field. */
/** One pass, linear: split on newline runs, trim only the whitespace that
 * touches a newline, drop empty pieces, join with one space. */
function joinTitleText(text: string): string {
  const pieces = text.split(/[\r\n]+/)
  if (pieces.length === 1) return text
  const last = pieces.length - 1
  return pieces
    .map((piece, at) =>
      at === 0 ? piece.trimEnd() : at === last ? piece.trimStart() : piece.trim()
    )
    .filter(Boolean)
    .join(" ")
}

export function buildFieldDoc(
  text: string,
  config: FieldContract | RichTextContractConfig,
  role?: HeadingRole,
  options: BuildPMDocOptions = {}
): ReturnType<typeof buildPMDocForContract> {
  const original = typeof config === "string" ? { contract: config } : config
  const resolved = resolveFieldContract(original)
  const effective =
    role && resolved.contract === "title"
      ? { ...original, heading: { ...original.heading, role } }
      : original
  const contract = resolveFieldContract(effective)
  if (contract.contract !== "title") {
    if (options.markdown) {
      const blocks = buildMarkdownDoc(text, contract.contract)
      if (blocks) return blocks as unknown as ReturnType<typeof buildPMDocForContract>
    }
    return buildPMDoc(text, contract.contract, options)
  }
  const inline: PMInlineNode[] = []
  // A title is one line: a newline run inside the text becomes one space and
  // one at either end is dropped. Typed spaces stay: a controlled input
  // round-trips this on every key, so "What is " must keep its last space.
  const line = joinTitleText(text)
  inline.push(
    ...(options.emphasis
      ? parseEmphasis(line)
      : line
        ? [{ type: "text" as const, text: line }]
        : [])
  )
  const paragraph: { type: "paragraph"; content?: PMInlineNode[] } = {
    type: "paragraph",
    ...(inline.length ? { content: inline } : {}),
  }
  const shaped = toFieldShape(
    contract,
    JSON.stringify({ type: "doc", content: [paragraph] })
  )
  return JSON.parse(shaped.value) as ReturnType<typeof buildPMDocForContract>
}

type MarkdownBlock = {
  type: string
  attrs?: Record<string, number>
  content?: Array<MarkdownBlock | PMTextNode>
}

/** Markdown worth lexing: a line that starts a heading, bullet, numbered item,
 * quote or code fence, or an inline link. Plain prose skips the lexer. */
const MARKDOWN_SYNTAX =
  /^ {0,3}(?:#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|`{3}|~{3})|\]\(/m

/**
 * Convert the Markdown blocks a model writes (ATX headings, bullet and ordered
 * lists, paragraphs, emphasis) into document nodes. Returns undefined when the
 * text has no such block, when the contract allows no headings or lists, or
 * when the result fails the same validation the editor applies on save; the
 * caller then keeps the paragraph result. Links, images, quotes, code and
 * tables are not built: their text is kept as readable paragraphs.
 */
function buildMarkdownDoc(
  text: string,
  profile: RichTextProfile
): { type: "doc"; content: MarkdownBlock[] } | undefined {
  const spec = PROFILE_SPECS[profile]
  if (!spec.nodes.has("heading") && !spec.nodes.has("bulletList")) return undefined
  if (!MARKDOWN_SYNTAX.test(text)) return undefined
  let tokens: Token[]
  try {
    tokens = lexer(text)
  } catch {
    return undefined
  }
  const content = markdownBlocks(tokens, spec)
  if (content.length === 0) return undefined
  const doc = { type: "doc" as const, content }
  return validateStrict(profile, JSON.stringify(doc)).ok ? doc : undefined
}

function markdownBlocks(tokens: Token[], spec: ProfileSpec): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  for (const token of tokens) {
    if (token.type === "space" || token.type === "hr" || token.type === "def") continue
    if (token.type === "heading") {
      const heading = token as Tokens.Heading
      const inline = markdownInline(heading.text)
      if (!inline.length) continue
      const level = nearestLevel(heading.depth, spec)
      out.push(
        level === undefined
          ? { type: "paragraph", content: inline }
          : { type: "heading", attrs: { level }, content: inline }
      )
    } else if (token.type === "list") {
      out.push(...markdownList(token as Tokens.List, spec))
    } else {
      const inline = markdownInline(plainBlockText(token))
      if (inline.length) out.push({ type: "paragraph", content: inline })
    }
  }
  return out
}

function markdownList(list: Tokens.List, spec: ProfileSpec): MarkdownBlock[] {
  const listType = list.ordered ? "orderedList" : "bulletList"
  const allowed = spec.nodes.has(listType) && spec.nodes.has("listItem")
  const items: MarkdownBlock[] = []
  const flat: MarkdownBlock[] = []
  for (const item of list.items) {
    const blocks: MarkdownBlock[] = []
    for (const child of item.tokens) {
      if (child.type === "list") blocks.push(...markdownList(child as Tokens.List, spec))
      else if (child.type === "space") continue
      else {
        const inline = markdownInline(plainBlockText(child))
        if (inline.length) blocks.push({ type: "paragraph", content: inline })
      }
    }
    if (blocks.length === 0) continue
    if (blocks[0]!.type !== "paragraph") blocks.unshift({ type: "paragraph" })
    flat.push(...blocks)
    items.push({ type: "listItem", content: blocks })
  }
  if (!allowed) return flat
  if (items.length === 0) return []
  const start = list.ordered && typeof list.start === "number" ? list.start : 1
  return [
    {
      type: listType,
      ...(list.ordered && start !== 1 ? { attrs: { start } } : {}),
      content: items,
    },
  ]
}

/** The text of a block we do not build, without its Markdown fences or marks. */
function plainBlockText(token: Token): string {
  const generic = token as { raw?: string; text?: string }
  if (token.type === "code") return generic.text ?? ""
  if (token.type === "blockquote")
    return (generic.raw ?? "").replace(/^ {0,3}> ?/gm, "")
  return token.type === "paragraph" || token.type === "text"
    ? (generic.text ?? generic.raw ?? "")
    : (generic.raw ?? generic.text ?? "")
}

/** The allowed heading level nearest to `depth`, or undefined when none is allowed. */
function nearestLevel(depth: number, spec: ProfileSpec): number | undefined {
  if (!spec.nodes.has("heading")) return undefined
  let best: number | undefined
  for (const level of spec.headingLevels)
    if (
      best === undefined ||
      Math.abs(level - depth) < Math.abs(best - depth)
    )
      best = level
  return best
}

function markdownInline(source: string): PMTextNode[] {
  const flat = source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim()
  return flat ? parseEmphasis(flat) : []
}

/**
 * Tiny Markdown emphasis parser. Recognises `**…**` / `__…__` as bold and
 * `*…*` / `_…_` as italic; nesting is supported (bold containing italic, or
 * vice versa). On unbalanced markers it falls back to the raw text so a stray
 * `*` in copy doesn't corrupt the output.
 *
 * Intentionally narrow: never emits `link`, `code`, `strike`, or any node
 * other than `text`. Mechanism 2 (no agent-controlled URLs / IDs) is preserved
 * because there is no node or mark in the output that can carry one.
 */
function parseEmphasis(text: string): PMTextNode[] {
  const out: PMTextNode[] = []
  let buf = ""
  let bold = false
  let italic = false
  const flush = () => {
    if (!buf) return
    const marks: PMMark[] = []
    if (bold) marks.push({ type: "bold" })
    if (italic) marks.push({ type: "italic" })
    out.push(
      marks.length
        ? { type: "text", text: buf, marks }
        : { type: "text", text: buf }
    )
    buf = ""
  }
  let i = 0
  while (i < text.length) {
    if (text.startsWith("**", i) || text.startsWith("__", i)) {
      flush()
      bold = !bold
      i += 2
      continue
    }
    const ch = text[i]
    if (ch === "*" || ch === "_") {
      flush()
      italic = !italic
      i += 1
      continue
    }
    buf += ch
    i += 1
  }
  flush()
  if (bold || italic) {
    // Unbalanced markers — treat the whole paragraph as literal text so a
    // stray `*` can't strip styling from the rest of the doc.
    return [{ type: "text", text }]
  }
  return out
}
