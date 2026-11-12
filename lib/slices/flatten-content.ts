import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { type Primitive, type Slice, type SliceType } from "@/convex/lib/slices"
import { walkValue } from "@/convex/lib/slices/walk"
import {
  readFieldText,
  transitionForField,
} from "@/convex/lib/richtext/transitions"
import { humanize } from "@/lib/humanize"
export { humanize } from "@/lib/humanize"

/**
 * A targetable, human-recognizable piece of a rendered slice (slice-sim only).
 *
 * The slice-sim "point at the preview" feature needs to map a visible DOM node
 * back to the content field it came from. Rather than instrument the *server*
 * render path (which would drag dev-only targeting concerns into the public
 * renderers + helpers — see the locked boundary), we flatten the slice's
 * content to its typed leaves here. The dev-only source stamp binds supported
 * fields; unambiguous visible text is a fallback. Empty leaves stay reachable
 * in the outline even when a renderer omits their DOM. The public render path
 * stays a pure Server Component and needs no renderer cooperation.
 *
 * `text` is the normalized visible string used both to match the DOM node and
 * to show the human the actual content ("'See pricing' button"), not the
 * schema field name — the whole point of the feature.
 */
export interface TargetEntry {
  /** Dotted content path with real list indices, e.g. `primary.buttons[1].label`. */
  path: string
  /** Human-facing field role, e.g. "Title" / "Subtitle" / "Button" / "Image". */
  fieldLabel: string
  /** Normalized visible text (for `text`/`richText`) or image url (for `image`). */
  text: string
  kind: "text" | "richText" | "image"
}

/** Collapse whitespace + trim, so DOM `textContent` and stored values compare. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Map a content key to the role a human perceives, not the schema field name. */
function fieldLabelFor(key: string): string {
  const k = key.toLowerCase()
  if (k === "title") return "Title"
  if (k === "label") return "Button"
  if (
    k.includes("subtitle") ||
    k.includes("description") ||
    k.includes("dek") ||
    k === "body"
  )
    return "Subtitle"
  if (k.includes("eyebrow") || k.includes("kicker") || k.includes("suptitle"))
    return "Eyebrow"
  if (k.includes("image")) return "Image"
  return humanize(key)
}

/** Extract plain text from a stored rich-text value (PM-JSON, or legacy HTML). */
function richTextToPlain(value: unknown): string {
  if (typeof value !== "string" || !value) return ""
  try {
    const doc = JSON.parse(value) as unknown
    const parts: string[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return
      const n = node as { text?: unknown; content?: unknown }
      if (typeof n.text === "string") parts.push(n.text)
      if (Array.isArray(n.content)) n.content.forEach(walk)
    }
    walk(doc)
    return parts.join("")
  } catch {
    return value.replace(/<[^>]*>/g, " ")
  }
}

/**
 * Flatten a sample/real slice to its visible, targetable leaves. Walks the
 * descriptor alongside the value so list rows carry real indices. Skips
 * structural/invisible leaves (link, select, boolean, number, …) — they have
 * no distinct rendered text to point at.
 */
export function flattenSliceContent(slice: Slice): TargetEntry[] {
  const def = readSliceDefinition(readSlice(slice).type as SliceType) as
    { primary: Primitive; items?: Primitive } | undefined
  if (!def) return []

  const entries: TargetEntry[] = []
  const visit = (leaf: {
    def: Primitive
    value: unknown
    path: string
    key: string
  }) => {
    const { def: d, value, path, key } = leaf
    if (d.kind === "text") {
      const text = normalizeText(typeof value === "string" ? value : "")
      entries.push({ path, fieldLabel: fieldLabelFor(key), text, kind: "text" })
    } else if (d.kind === "richText") {
      const address = { sliceType: readSlice(slice).type, fieldPath: path }
      const text = normalizeText(
        typeof value === "string" && transitionForField(address)
          ? readFieldText(address, value)
          : richTextToPlain(value)
      )
      entries.push({
        path,
        fieldLabel: fieldLabelFor(key),
        text,
        kind: "richText",
      })
    } else if (d.kind === "image") {
      const url =
        value && typeof value === "object"
          ? (value as { url?: unknown }).url
          : undefined
      entries.push({
        path,
        fieldLabel: fieldLabelFor(key),
        text: typeof url === "string" ? url : "",
        kind: "image",
      })
    }
  }

  walkValue(def.primary, readSlice(slice).primary, visit, "primary")
  if (def.items) {
    walkValue(def.items, (slice as { items?: unknown }).items, visit, "items")
  }
  return entries
}
