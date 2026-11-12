import { readSlice, type SliceStructure } from "@/convex/lib/slices/identity"
import type { Slice } from "@/convex/lib/slices"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"
import { readFieldText } from "@/convex/lib/richtext/transitions"
import { richTextToDocument } from "@/lib/rich-text/render"
import {
  isOutlineFieldVisible,
  visibleOutlineSlices,
  type PageOutline,
} from "@/lib/slices/page-outline"
import type { SliceRenderContext } from "@/lib/slices/links"
import { RichTextContent } from "./render-helpers"
import { SLICE_COMPONENTS } from "./slice-zone-registry"
import { resolveRenderedSlicePresentation } from "@/components/slices/presentations/resolution"
import { SITE_PRESENTATION_DEFAULTS } from "@/components/slices/presentations/site-defaults"
import { renderSlicePresentation } from "@/components/slices/presentations/registry"

export type SliceRendererRegistry = Partial<{
  [T in Slice["type"]]: (
    slice: Extract<Slice, { type: T }>,
    ctx: SliceRenderContext
  ) => React.ReactNode
}>

/**
 * Fallback for a slice type with no registered component yet (e.g. freshly
 * generated and not styled). Renders recognizable fields so the page is never
 * broken, with a dev hint.
 */
function FallbackSlice({ slice }: { slice: Slice }) {
  const primary = "primary" in slice ? readSlice(slice).primary : undefined
  const title =
    primary && "title" in primary ? (primary.title as string) : undefined
  const content =
    primary && "content" in primary ? (primary.content as string) : undefined

  return (
    <section className="border-y border-dashed px-6 py-10">
      <div className="mx-auto max-w-2xl space-y-2">
        <p className="font-mono text-xs text-muted-foreground">
          Unstyled slice: {readSlice(slice).type}
        </p>
        {title && <p className="text-2xl font-semibold">{title}</p>}
        {content && <RichTextContent value={content} profile="basic" />}
      </div>
    </section>
  )
}

const REGION_HEADING_FIELDS: Record<string, "title" | "heading"> = {
  "hero-with-image": "title",
  "hero-agency": "title",
  "hero-with-testimonial-overlay": "title",
  "faq-simple": "heading",
  "faq-accordion-two-column": "title",
  "features-icon-grid": "heading",
  "cta-band": "heading",
  "contact-form": "heading",
  "site-search": "heading",
  "starter-steps-numbered": "heading",
}

function regionNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase()
}

/** Match the shipped renderers, including retained starter-only slice types. */
function renderedRegionNames(slice: SliceStructure) {
  const names: string[] = []
  const field = REGION_HEADING_FIELDS[slice.type]
  const heading = field ? slice.primary[field] : undefined
  if (typeof heading === "string" && isOutlineFieldVisible(heading)) {
    // Kit titles and legacy HeadingSlot content both use this tolerant reader.
    // Project its document, never the stored HTML (inline joins and entities).
    names.push(
      richTextToPlainText(JSON.stringify(richTextToDocument(heading, "inline")))
    )
  }
  if (
    slice.type === "faq-simple" ||
    slice.type === "faq-accordion-two-column"
  ) {
    const items =
      slice.type === "faq-simple" ? slice.items : slice.primary.items
    const fieldPath =
      slice.type === "faq-simple" ? "items.question" : "primary.items.question"
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item?.question !== "string") continue
        // FAQ Simple transitions recognized title documents; plain questions
        // and the two-column renderer's questions remain literal text.
        const name = readFieldText(
          { sliceType: slice.type, fieldPath },
          item.question
        )
        if (name.trim()) names.push(name)
      }
    }
  }
  const hero = slice.type === "hero-with-image" || slice.type === "hero-agency"
  return names.map((name) => ({
    id: slice.id,
    name,
    key: regionNameKey(name),
    hero,
  }))
}

/** One inventory owns collision counts and reservations; only Heroes rename. */
function collisionRegionLabels(slices: Slice[]): Map<string, string> {
  const regions = slices.flatMap(renderedRegionNames)
  const counts = new Map<string, number>()
  for (const { key } of regions) counts.set(key, (counts.get(key) ?? 0) + 1)
  const reserved = new Set(
    regions
      .filter(({ key, hero }) => !hero || counts.get(key) === 1)
      .map(({ key }) => key)
  )
  const labels = new Map<string, string>()
  const ordinals = new Map<string, number>()
  for (const { id, name, key, hero } of regions) {
    if (!hero || counts.get(key) === 1) continue
    let ordinal = ordinals.get(key) ?? 1
    while (reserved.has(regionNameKey(`${name} ${ordinal}`))) ordinal++
    const label = `${name} ${ordinal}`
    labels.set(id, label)
    reserved.add(regionNameKey(label))
    ordinals.set(key, ordinal + 1)
  }
  return labels
}

export function SliceZone({
  slices,
  ctx,
  outline,
  registry = SLICE_COMPONENTS,
}: {
  slices: Slice[]
  ctx: SliceRenderContext
  outline: PageOutline
  registry?: SliceRendererRegistry
}) {
  const registryReads: Readonly<
    Partial<
      Record<string, (slice: never, ctx: SliceRenderContext) => React.ReactNode>
    >
  > = registry
  const visible = visibleOutlineSlices(slices)
  const regionLabels = collisionRegionLabels(visible)
  // Resolve the complete visible set before producing output. A legacy custom
  // registry retains ownership of its default; recorded choices require the
  // owned presentation registry until a caller explicitly qualifies an adapter.
  const renderers = new Map<
    string,
    (context: SliceRenderContext) => React.ReactNode
  >()
  for (const slice of visible) {
    if (
      ctx.presentationCatalog &&
      !ctx.presentationCatalog.installedTypes.includes(readSlice(slice).type)
    )
      throw new Error("Slice presentation rendering refused: type-unavailable.")
    const usesSiteDefault =
      registry === SLICE_COMPONENTS &&
      Object.hasOwn(SITE_PRESENTATION_DEFAULTS, readSlice(slice).type)
    if (readSlice(slice).presentationIdV1 === undefined && !usesSiteDefault)
      continue
    if (registry !== SLICE_COMPONENTS || !ctx.presentationCatalog)
      throw new Error(
        "Slice presentation rendering requires a qualified source catalog and registry."
      )
    const resolution = resolveRenderedSlicePresentation(
      ctx.presentationCatalog,
      {
        type: readSlice(slice).type,
        presentationId: readSlice(slice).presentationIdV1,
      }
    )
    if (resolution.status === "refused")
      throw new Error(
        `Slice presentation rendering refused: ${resolution.reason}.`
      )
    // Validate dispatch before invoking an admin preview interceptor.
    const checked = renderSlicePresentation(slice, ctx, resolution)
    if (checked.status === "refused")
      throw new Error(
        `Slice presentation rendering refused: ${checked.reason}.`
      )
    renderers.set(readSlice(slice).id, (context) => {
      const result = renderSlicePresentation(slice, context, resolution)
      if (result.status === "refused")
        throw new Error("Slice presentation renderer is unavailable.")
      return result.node
    })
  }
  return (
    <>
      {visible.map((slice) => {
        const render = registryReads[readSlice(slice).type]
        const renderOccurrence = (context: SliceRenderContext) => {
          context = {
            ...context,
            outline: outline.fieldsBySliceId[readSlice(slice).id],
            regionLabel: regionLabels.get(readSlice(slice).id),
          }
          const presentation = renderers.get(readSlice(slice).id)
          return presentation ? (
            presentation(context)
          ) : render ? (
            render(slice as never, context)
          ) : (
            <FallbackSlice slice={slice} />
          )
        }
        return (
          <div key={readSlice(slice).id}>
            {ctx.previewSlice
              ? ctx.previewSlice(slice, renderOccurrence)
              : renderOccurrence(ctx)}
          </div>
        )
      })}
    </>
  )
}
