import { readSlice } from "@/convex/lib/slices/identity"
import type { JSONContent } from "@tiptap/core"
import type { Slice } from "@/convex/lib/slices"
import { withUniqueSliceRenderIds } from "@/convex/lib/slices/identity"
import {
  hasVisibleInlineRichText,
  hasVisibleRichText,
} from "@/lib/rich-text/render"
import { readFieldText } from "@/convex/lib/richtext/transitions"
import type { FieldAddress } from "@/convex/lib/richtext/contracts"
import type { RichTextProfile } from "@/convex/lib/richtext/profiles"

export type PageHeadingMode = "lead-or-fallback" | "owned" | "section"
export type OutlineField = {
  parent?: string
  kind?: "text" | "body"
  profile?: RichTextProfile
}
export type SliceOutlineDescriptor = {
  canOpenPage: boolean
  sliceTitle?: string
  fields: Record<string, OutlineField>
}

/** Display metadata only: these do not adopt title contracts or change writes. */
export const SLICE_OUTLINE_DESCRIPTORS: Record<string, SliceOutlineDescriptor> =
  {
    "hero-with-testimonial-overlay": {
      canOpenPage: true,
      sliceTitle: "primary.title",
      fields: {
        "primary.title": {},
      },
    },
    "faq-accordion-two-column": {
      canOpenPage: false,
      sliceTitle: "primary.title",
      fields: {
        "primary.title": {},
        "primary.items.question": { parent: "primary.title", kind: "text" },
        "primary.items.answer": {
          parent: "primary.items.question",
          kind: "body",
          profile: "basic",
        },
      },
    },
    "pricing-tier-cards": {
      canOpenPage: false,
      sliceTitle: "primary.title",
      fields: {
        "primary.title": {},
        "items.name": { parent: "primary.title" },
      },
    },
    "starter-steps-numbered": {
      canOpenPage: false,
      sliceTitle: "primary.heading",
      fields: {
        "primary.heading": {},
        "items.title": { parent: "primary.heading" },
      },
    },
    "hero-agency": {
      canOpenPage: true,
      sliceTitle: "primary.title",
      fields: {
        "primary.title": {},
        "primary.description": {
          parent: "primary.title",
          kind: "body",
          profile: "basic",
        },
      },
    },
    "hero-with-image": {
      canOpenPage: true,
      sliceTitle: "primary.title",
      fields: {
        "primary.title": {},
        "primary.description": {
          parent: "primary.title",
          kind: "body",
          profile: "basic",
        },
      },
    },
    "contact-form": {
      canOpenPage: false,
      sliceTitle: "primary.heading",
      fields: {
        "primary.heading": {},
        "items.label": { parent: "primary.heading" },
      },
    },
    "cta-band": {
      canOpenPage: false,
      sliceTitle: "primary.heading",
      fields: { "primary.heading": {} },
    },
    "faq-simple": {
      canOpenPage: false,
      sliceTitle: "primary.heading",
      fields: {
        "primary.heading": {},
        "items.question": { parent: "primary.heading", kind: "text" },
        "items.answer": {
          parent: "items.question",
          kind: "body",
          profile: "basic",
        },
      },
    },
    "features-icon-grid": {
      canOpenPage: false,
      sliceTitle: "primary.heading",
      fields: {
        "primary.heading": {},
        "primary.body": {
          parent: "primary.heading",
          kind: "body",
          profile: "basic",
        },
        "items.title": { parent: "primary.heading" },
        "items.body": { parent: "items.title", kind: "body", profile: "basic" },
      },
    },
    "rich-text-body": {
      canOpenPage: false,
      fields: { "primary.body": { kind: "body", profile: "full" } },
    },
    "site-search": {
      canOpenPage: false,
      sliceTitle: "primary.heading",
      fields: { "primary.heading": {} },
    },
  }

export type SliceFieldOutline = {
  base: number
  fields: Record<string, OutlineField>
  slice: unknown
}
export type PageOutline = {
  mode: PageHeadingMode
  locale: string
  leadSliceId?: string
  hostRendersFallbackH1: boolean
  baseBySliceId: Record<string, number>
  fieldsBySliceId: Record<string, SliceFieldOutline>
}

export function pageHeadingModeFor(pageType: string): PageHeadingMode {
  return pageType === "author" ? "owned" : "lead-or-fallback"
}

/** Shared by the resolver and zone so hidden/duplicate occurrences cannot disagree. */
export function visibleOutlineSlices(slices: Slice[]): Slice[] {
  return withUniqueSliceRenderIds(slices).filter(
    (slice) => readSlice(slice).enabled !== false
  )
}

function parts(path: string) {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".")
}
function normalized(path: string) {
  return parts(path)
    .filter((part) => !/^\d+$/.test(part))
    .join(".")
}
function at(value: unknown, path: string): unknown {
  for (const part of parts(path)) {
    if (
      value === null ||
      typeof value !== "object" ||
      ["__proto__", "constructor", "prototype"].includes(part)
    )
      return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}
/** The single visibility decision used by outline parents, hosts and body regions. */
export function isOutlineFieldVisible(
  value: unknown,
  field: Pick<OutlineField, "kind" | "profile"> & {
    address?: FieldAddress
  } = {}
): boolean {
  if (typeof value !== "string") return false
  if (field.kind === "text")
    return readFieldText(field.address, value).trim() !== ""
  if (field.kind === "body")
    return hasVisibleRichText(value, field.profile ?? "basic")
  return hasVisibleInlineRichText(value)
}

function fieldAddress(slice: unknown, path: string): FieldAddress | undefined {
  const type =
    slice && typeof slice === "object" && "type" in slice
      ? slice.type
      : undefined
  return typeof type === "string"
    ? { sliceType: type, fieldPath: normalized(path) }
    : undefined
}

/** Reuse indices only along the ancestor path shared by this field and parent. */
function sameRowParentPath(parent: string, path: string): string {
  const actual = parts(path)
  const declared = parts(parent)
  const resolved: string[] = []
  let cursor = 0
  for (let index = 0; index < declared.length; index++) {
    const part = declared[index]
    if (actual[cursor] !== part)
      return [...resolved, ...declared.slice(index)].join(".")
    resolved.push(part)
    cursor++
    while (/^\d+$/.test(actual[cursor] ?? "")) resolved.push(actual[cursor++])
  }
  return resolved.join(".")
}

export function validateOutlineDescriptor(
  descriptor: SliceOutlineDescriptor
): string[] {
  const errors: string[] = []
  for (const [path, field] of Object.entries(descriptor.fields)) {
    const seen = new Set([path])
    let cursor = path
    let parent = field.parent
    while (parent) {
      if (
        !descriptor.fields[parent] ||
        descriptor.fields[parent].kind === "body"
      ) {
        errors.push(`${path}: invalid heading parent ${parent}`)
        break
      }
      const parentParts = parts(parent)
      const repeatedAt = parentParts.lastIndexOf("items")
      const scope = parentParts.slice(0, repeatedAt + 1).join(".")
      if (repeatedAt >= 0 && !cursor.startsWith(`${scope}.`)) {
        errors.push(`${path}: parent outside repeated item`)
        break
      }
      if (seen.has(parent)) {
        errors.push(`${path}: heading parent cycle`)
        break
      }
      seen.add(parent)
      if (seen.size > 5) {
        errors.push(`${path}: outline-overflow at section base 2`)
        break
      }
      cursor = parent
      parent = descriptor.fields[parent].parent
    }
  }
  return errors
}

export function resolvePageOutline({
  slices,
  locale,
  mode,
  descriptors = SLICE_OUTLINE_DESCRIPTORS,
}: {
  slices: Slice[]
  locale: string
  mode: PageHeadingMode
  descriptors?: Record<string, SliceOutlineDescriptor>
}): PageOutline {
  const visible = visibleOutlineSlices(slices)
  const leadSliceId =
    mode === "lead-or-fallback"
      ? readSlice(
          visible.find((slice) => {
            const opening = descriptors[readSlice(slice).type]
            return (
              opening?.canOpenPage &&
              opening.sliceTitle &&
              isOutlineFieldVisible(at(slice, opening.sliceTitle), {
                ...opening.fields[opening.sliceTitle],
                address: fieldAddress(slice, opening.sliceTitle),
              })
            )
          })
        )?.id
      : undefined
  const baseBySliceId: Record<string, number> = {}
  const fieldsBySliceId: Record<string, SliceFieldOutline> = {}
  for (const slice of visible) {
    const descriptor = descriptors[readSlice(slice).type]
    if (descriptor) {
      const errors = validateOutlineDescriptor(descriptor)
      if (errors.length) throw new Error(errors.join("; "))
    }
    const base = readSlice(slice).id === leadSliceId ? 1 : 2
    baseBySliceId[readSlice(slice).id] = base
    fieldsBySliceId[readSlice(slice).id] = {
      base,
      fields: descriptor?.fields ?? {},
      slice,
    }
  }
  return {
    mode,
    locale,
    leadSliceId,
    hostRendersFallbackH1: mode === "lead-or-fallback" && !leadSliceId,
    baseBySliceId,
    fieldsBySliceId,
  }
}

/** Count only rendered parents, resolving a repeated parent within this row. */
export function fieldHeadingLevel(
  outline: SliceFieldOutline | undefined,
  path: string,
  fallbackLevel = 2
): number {
  if (!outline) return fallbackLevel
  const field = outline.fields[normalized(path)]
  let parent = field?.parent
  let level = outline.base
  while (parent) {
    const resolvedParent = sameRowParentPath(parent, path)
    if (
      isOutlineFieldVisible(at(outline.slice, resolvedParent), {
        ...outline.fields[parent],
        address: fieldAddress(outline.slice, parent),
      })
    )
      level += 1
    parent = outline.fields[parent]?.parent
  }
  if (level > 6 && process.env.NODE_ENV === "development")
    console.warn("outline-overflow")
  return Math.min(6, level)
}

/** Map stored ranks to renderer-owned levels without changing the document. */
export function bodyHeadingLevels(
  document: JSONContent,
  floor: number
): ReadonlyMap<number, number> {
  const ranks = new Set<number>()
  function hasText(node: JSONContent): boolean {
    return node.type === "text"
      ? Boolean(node.text?.trim())
      : Boolean(node.content?.some(hasText))
  }
  function collect(node: JSONContent) {
    if (node.type === "heading" && hasText(node))
      ranks.add(Number(node.attrs?.level) || 2)
    node.content?.forEach(collect)
  }
  collect(document)
  return new Map(
    [...ranks]
      .sort((a, b) => a - b)
      .map((rank, index) => {
        const level = floor + index
        if (level > 6 && process.env.NODE_ENV === "development")
          console.warn("outline-overflow")
        return [rank, Math.min(6, level)]
      })
  )
}

/** Resolve headings in render order, preserving the renderer's occurrence clamp. */
export function createBodyHeadingResolver(
  levels?: ReadonlyMap<number, number>
) {
  let previousLevel = levels ? Math.min(...levels.values()) - 1 : 0
  return (validatedRank: number, textContent: string): number | null => {
    if (!levels) return validatedRank
    if (!textContent.trim()) return null
    const renderedLevel = Math.min(
      levels.get(validatedRank) ?? validatedRank,
      previousLevel + 1
    )
    previousLevel = renderedLevel
    return renderedLevel
  }
}
