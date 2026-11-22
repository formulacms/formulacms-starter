import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
// convex/lib/agents/pageContext.ts
// Compact page-context payload threaded into every content-writer call so that
// a new block (or a refined field) matches the voice/topic of the rest of the
// page and the site's configured brand voice.
//
// Pure: no Convex runtime imports beyond `convex/values`, no TipTap, no DOM.
// Safe to call from a client (to assemble the payload) AND from an action (to
// render the system-prompt suffix).
import { v, type Infer } from "convex/values"
import { type Block, type Primitive } from "../blocks"
import { readFieldText, transitionForField } from "../richtext/transitions"
import { resolveFieldContract } from "../richtext/contracts"
import { toFieldShape } from "../richtext/shape"

/** Hard cap per sibling's flattened text so the context block stays cheap on
 *  tokens. 240 chars ≈ a long sentence; enough to convey tone, short enough
 *  that a 6-block page is < ~1.5 KB. */
export const SIBLING_TEXT_CAP = 240

export const pageContextValidator = v.object({
  /** Current page title (in the editor's locale). Anchors the topic. */
  pageTitle: v.optional(v.string()),
  /** Other blocks on the same page, in document order. Each is flattened to a
   *  single short string so the model can read voice/topic without seeing
   *  PM-JSON or structural fields. */
  siblings: v.optional(
    v.array(
      v.object({
        type: v.string(),
        text: v.string(),
      })
    )
  ),
})
export type PageContext = Infer<typeof pageContextValidator>

/** Flatten a block's editorial text fields into one short string. Structural
 *  fields (image, alignment, button hrefs) are intentionally excluded — context
 *  is voice/topic anchoring, not configuration. Each block type knows which of
 *  its `primary` keys are editorial (matches the block-editor's `textKeysOf`). */
export function flattenBlockText(block: Block): string {
  const parts: string[] = []
  const def = readBlockDefinition(readBlock(block).type)
  if (!def) {
    pushGenericText(
      readBlock(block).primary,
      parts,
      readBlock(block).type,
      "primary"
    )
    if ("items" in block)
      pushGenericText(
        readBlock(block).items,
        parts,
        readBlock(block).type,
        "items"
      )
    const fallback = parts.join(" • ").replace(/\s+/g, " ").trim()
    if (fallback.length <= SIBLING_TEXT_CAP) return fallback
    const cut = fallback.slice(0, SIBLING_TEXT_CAP)
    const lastSpace = cut.lastIndexOf(" ")
    return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim() + "…"
  }
  pushDescriptorText(
    def.primary,
    readBlock(block).primary,
    parts,
    readBlock(block).type,
    "primary"
  )
  if (def.items !== undefined && "items" in block)
    pushDescriptorText(
      def.items,
      readBlock(block).items,
      parts,
      readBlock(block).type,
      "items"
    )

  const joined = parts.join(" • ").replace(/\s+/g, " ").trim()
  if (joined.length <= SIBLING_TEXT_CAP) return joined
  // Cut on a word boundary so the cap doesn't block mid-token.
  const cut = joined.slice(0, SIBLING_TEXT_CAP)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim() + "…"
}

/** Appends a field's plain text, uncut. Shared with the Write-page result view. */
export function pushDescriptorText(
  def: Primitive,
  value: unknown,
  parts: string[],
  blockType: string,
  path: string
) {
  if (def.kind === "text") {
    if (typeof value === "string") {
      const address = { blockType, fieldPath: path }
      if (transitionForField(address)) {
        const projected = readFieldText(address, value).trim()
        if (projected) parts.push(projected)
      } else {
        const trimmed = value.trim()
        if (trimmed) parts.push(trimmed)
      }
    }
    return
  }
  if (def.kind === "richText") {
    if (typeof value === "string") {
      const config = def.config as {
        profile?: "inline" | "basic" | "full"
        contract?: "title" | "inline" | "basic" | "full"
      }
      pushGenericText(
        toFieldShape(resolveFieldContract(config), value).value,
        parts
      )
    }
    return
  }
  if (def.kind === "group") {
    const fields = def.config.fields as Record<string, Primitive>
    const object =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    for (const [key, child] of Object.entries(fields))
      pushDescriptorText(child, object[key], parts, blockType, `${path}.${key}`)
    return
  }
  if (def.kind === "list") {
    const item = def.config.item as Primitive
    if (Array.isArray(value))
      value.forEach((row, index) =>
        pushDescriptorText(item, row, parts, blockType, `${path}[${index}]`)
      )
    return
  }
  pushGenericText(value, parts, blockType, path)
}

export function pushGenericText(
  value: unknown,
  parts: string[],
  blockType?: string,
  path = ""
) {
  if (typeof value === "string") {
    const address = blockType ? { blockType, fieldPath: path } : undefined
    if (address && transitionForField(address)) {
      const projected = readFieldText(address, value).trim()
      if (projected) parts.push(projected)
      return
    }
    const trimmed = value.trim()
    if (!trimmed) return
    try {
      const doc = JSON.parse(trimmed) as {
        content?: Array<{ content?: Array<{ text?: string }> }>
      }
      for (const node of doc.content ?? []) {
        for (const inline of node.content ?? []) {
          if (inline.text?.trim()) parts.push(inline.text.trim())
        }
      }
      return
    } catch {
      parts.push(trimmed)
      return
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      pushGenericText(item, parts, blockType, `${path}[${index}]`)
    )
    return
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      pushGenericText(item, parts, blockType, path ? `${path}.${key}` : key)
    }
  }
}

/**
 * Build a single short string of every other block on the page, ready to drop
 * into a `PageContext.siblings`. Pass `excludeBlockId` to omit the block the
 * editor is currently writing/refining (so the model isn't tempted to mirror
 * the block it's about to overwrite back at us).
 */
export function buildSiblings(
  blocks: readonly Block[],
  excludeBlockId?: string
): PageContext["siblings"] {
  const out: NonNullable<PageContext["siblings"]> = []
  for (const s of blocks) {
    if (excludeBlockId && readBlock(s).id === excludeBlockId) continue
    const text = flattenBlockText(s)
    if (text) out.push({ type: readBlock(s).type, text })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Render the system-prompt suffix appended after the operator-editable
 * template. Sections are omitted when empty so the prompt stays compact when
 * nothing is configured.
 */
export function buildContextSection(
  ctx: PageContext | undefined,
  brandVoice: string | undefined
): string {
  const sections: string[] = []

  const voice = brandVoice?.trim()
  if (voice) sections.push(`Brand voice: ${voice}`)

  const siblings = ctx?.siblings ?? []
  if (siblings.length > 0) {
    const lines = siblings.map((s) => `- ${s.type}: ${s.text}`).join("\n")
    sections.push(
      `Page context (already-authored sections, for tone/topic anchoring):\n${lines}`
    )
  }

  const title = ctx?.pageTitle?.trim()
  if (title) sections.push(`Page title: ${title}`)

  return sections.join("\n\n")
}
