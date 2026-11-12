import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { type Primitive, type Slice } from "."
import { walkValue } from "./walk"
import { buildFieldDoc } from "../richtext/build"
import { resolveFieldContract } from "../richtext/contracts"
import type { RichTextProfile } from "../richtext/profiles"
import type { Id } from "../../_generated/dataModel"
import type { PageType } from "../pages/types"
import type { RelationCard } from "./resolve"

/**
 * Sample-data synthesizer — the sibling of `createDefaultSlice`
 * (`lib/slices/builder.ts`). Where `createDefaultSlice` produces the canonical
 * *empty* slice for a fresh editor form, this produces a *filled*, schema-valid
 * slice with believable copy — what the slice simulator renders so a design can
 * be previewed without authoring content by hand.
 *
 * Lives under `convex/lib/` so server actions (contentWriter) can fall back to
 * it when the model returns missing labeled blocks — guaranteeing newly created
 * slices are never visually empty (handoff Track 1). The Next.js side imports
 * it via `lib/slices/sample.ts` which re-exports from here.
 */

type SliceType = Slice["type"]

const TITLES = [
  "Everything you need to ship",
  "Fast by default",
  "Type-safe end to end",
  "Own your content",
  "Built for Next.js teams",
]

const BUTTON_LABELS = ["Get started", "Learn more", "See pricing", "Contact us"]

const INLINE_COPY = [
  "A concise line with **bold** and *italic* emphasis to set the tone.",
  "Short supporting copy that explains the value in a single sentence.",
  "Clear, friendly, and right to the point.",
]

const BUTTON_VARIANT_SEQUENCE = ["primary", "link", "secondary"] as const

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function sampleText(key: string, seed: number, placeholder?: string): string {
  const k = key.toLowerCase()
  if (k === "id") return crypto.randomUUID()
  if (placeholder) return placeholder
  if (k === "title") return TITLES[seed % TITLES.length]
  if (k === "label") return BUTTON_LABELS[seed % BUTTON_LABELS.length]
  return humanize(key)
}

function sampleProse(profile: RichTextProfile, seed: number): string {
  if (profile === "inline") return INLINE_COPY[seed % INLINE_COPY.length]
  return [
    "This is sample body copy used to preview the block. It shows how **bold** and *italic* emphasis read inside flowing paragraphs.",
    "A second paragraph adds enough text to judge spacing, measure, and rhythm at a realistic length.",
  ].join("\n\n")
}

function sampleSelectValue(def: Primitive, key: string, seed: number): unknown {
  const config = def.config as { options?: string[] }
  if (key === "variant" && Array.isArray(config.options)) {
    const variant =
      BUTTON_VARIANT_SEQUENCE[(seed - 1) % BUTTON_VARIANT_SEQUENCE.length]
    if (config.options.includes(variant)) return variant
  }
  return def.default
}

function sampleRelationId(
  pageType: PageType,
  key: string,
  seed: number
): Id<"pages"> {
  const slug = key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  return `sample-${pageType}-${slug || "relation"}-${seed}` as Id<"pages">
}

function sampleRelationCard(
  pageId: Id<"pages">,
  pageType: PageType,
  seed: number
): RelationCard {
  const label = humanize(pageType)
  return {
    pageId,
    pageType,
    title: `${label} example ${seed + 1}`,
    excerpt:
      "A related content card generated for the block simulator preview.",
  }
}

function sampleValue(def: Primitive, key: string, seed: number): unknown {
  switch (def.kind) {
    case "text": {
      const cfg = def.config as { placeholder?: string }
      return sampleText(key, seed, cfg.placeholder)
    }
    case "richText": {
      const resolved = resolveFieldContract(def.config)
      const profile = resolved.profile ?? "inline"
      const cfg = def.config as { placeholder?: string }
      return JSON.stringify(
        buildFieldDoc(
          cfg.placeholder ?? sampleProse(profile, seed),
          def.config,
          resolved.headingRole,
          { emphasis: true }
        )
      )
    }
    case "image":
      return structuredClone(def.default)
    case "link":
      return { type: "external", url: "https://example.com" }
    case "date":
      return "2026-01-15"
    case "datetime":
      return "2026-01-15T14:30:00.000Z"
    case "geopoint":
      return { lat: 45.5017, lng: -73.5673 }
    case "embed":
      return {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        provider: "YouTube",
        title: "Sample video",
      }
    case "table":
      return {
        headerRow: ["Feature", "Detail"],
        rows: [
          ["Typed content", "Every value stays schema-safe."],
          ["AI authoring", "Generated copy stays inside approved fields."],
        ],
      }
    case "relation": {
      const pageType = ((def.config as { pageTypes?: PageType[] })
        .pageTypes?.[0] ?? "page") as PageType
      return { pageId: sampleRelationId(pageType, key, seed) }
    }
    case "group": {
      const fields = def.config.fields as Record<string, Primitive>
      const obj: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(fields)) {
        const val = sampleValue(child, k, seed)
        if (val !== undefined) obj[k] = val
      }
      return obj
    }
    case "list": {
      const item = def.config.item as Primitive
      const min = (def.config.min as number | undefined) ?? 0
      const max = (def.config.max as number | undefined) ?? Infinity
      const count = Math.max(min, Math.min(3, max))
      return Array.from({ length: count }, (_, i) =>
        sampleValue(item, key, i + 1)
      )
    }
    default:
      return def.kind === "select"
        ? sampleSelectValue(def, key, seed)
        : def.default
  }
}

function collectSampleRelationCards(
  def: Primitive,
  value: unknown,
  cards: Record<string, RelationCard | null>,
  seed: { current: number }
): void {
  walkValue(def, value, (leaf) => {
    if (leaf.def.kind !== "relation") return
    const pageId =
      leaf.value && typeof leaf.value === "object"
        ? (leaf.value as { pageId?: unknown }).pageId
        : undefined
    if (typeof pageId !== "string" || cards[pageId] !== undefined) return
    const pageType = ((leaf.def.config as { pageTypes?: PageType[] })
      .pageTypes?.[0] ?? "page") as PageType
    cards[pageId] = sampleRelationCard(
      pageId as Id<"pages">,
      pageType,
      seed.current++
    )
  })
}

interface PreviewOverride {
  primary?: unknown
  items?: unknown
}

/**
 * Does this type carry settled, hand-written preview content — as opposed to
 * the generic sampler's placeholder fill?
 *
 * A descriptor with repeated blocks only counts when it curates those too: the
 * sampler has one placeholder per field, so it repeats the same entry as many
 * times as the list allows. A preview that covers the header but leaves the
 * repeated blocks generic still shows duplicate rows, which is exactly what
 * curation exists to prevent.
 *
 * `verifySlice` turns this into a hard failure for any design with an accepted
 * width on record (slice-fidelity plan §5 B5 rule 3) — a picture compared
 * against placeholder text measures the placeholder, not the design.
 */
export function hasCuratedPreview(type: SliceType): boolean {
  const def = readSliceDefinition(type) as {
    items?: unknown
    preview?: PreviewOverride
  }
  const preview = def.preview
  if (!preview || preview.primary === undefined) return false
  return !def.items || preview.items !== undefined
}

/**
 * Build a filled, schema-valid sample slice of the given type with a fresh id.
 * Output shape matches `createDefaultSlice` (`{ id, type, enabled, primary,
 * items? }`); the value passes `sliceValidator` and each rich-text field passes
 * its profile.
 */
export function createSampleSlice<T extends SliceType = SliceType>(
  type: T
): Extract<Slice, { type: T }> {
  const def = readSliceDefinition(type)
  if (!def) throw new Error(`Slice type is not registered: ${String(type)}`)
  const preview = (def as { preview?: PreviewOverride }).preview
  const slice: Record<string, unknown> = {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    primary:
      preview?.primary !== undefined
        ? structuredClone(preview.primary)
        : sampleValue(def.primary, "primary", 0),
  }
  if (def.items !== undefined) {
    slice.items =
      preview?.items !== undefined
        ? structuredClone(preview.items)
        : sampleValue(def.items, "items", 0)
  }
  return slice as Extract<Slice, { type: T }>
}

export function createSampleRelationCards(
  slices: readonly Slice[]
): Record<string, RelationCard | null> {
  const cards: Record<string, RelationCard | null> = {}
  const seed = { current: 0 }
  for (const slice of slices) {
    const def = readSliceDefinition(readSlice(slice).type)
    if (!def) continue
    collectSampleRelationCards(
      def.primary,
      readSlice(slice).primary,
      cards,
      seed
    )
    if (def.items !== undefined) {
      collectSampleRelationCards(
        def.items,
        (slice as { items?: unknown[] }).items,
        cards,
        seed
      )
    }
  }
  return cards
}
