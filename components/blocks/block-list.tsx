import { readBlock, type BlockStructure } from "@/convex/lib/blocks/identity"
import type { Block } from "@/convex/lib/blocks"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"
import { readFieldText } from "@/convex/lib/richtext/transitions"
import { richTextToDocument } from "@/lib/rich-text/render"
import {
  isOutlineFieldVisible,
  visibleOutlineBlocks,
  type PageOutline,
} from "@/lib/blocks/page-outline"
import type { BlockRenderContext } from "@/lib/blocks/links"
import { RichTextContent } from "./render-helpers"
import { BLOCK_COMPONENTS } from "./block-registry"
import { resolveRenderedBlockPresentation } from "@/components/blocks/presentations/resolution"
import { SITE_PRESENTATION_DEFAULTS } from "@/components/blocks/presentations/site-defaults"
import { renderBlockPresentation } from "@/components/blocks/presentations/registry"

export type BlockRendererRegistry = Partial<{
  [T in Block["type"]]: (
    block: Extract<Block, { type: T }>,
    ctx: BlockRenderContext
  ) => React.ReactNode
}>

/**
 * Fallback for a block type with no registered component yet (e.g. freshly
 * generated and not styled). Renders recognizable fields so the page is never
 * broken, with a dev hint.
 */
function FallbackBlock({ block }: { block: Block }) {
  const primary = "primary" in block ? readBlock(block).primary : undefined
  const title =
    primary && "title" in primary ? (primary.title as string) : undefined
  const content =
    primary && "content" in primary ? (primary.content as string) : undefined

  return (
    <section className="border-y border-dashed px-6 py-10">
      <div className="mx-auto max-w-2xl space-y-2">
        <p className="font-mono text-xs text-muted-foreground">
          Unstyled block: {readBlock(block).type}
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

/** Match the shipped renderers, including retained starter-only block types. */
function renderedRegionNames(block: BlockStructure) {
  const names: string[] = []
  const field = REGION_HEADING_FIELDS[block.type]
  const heading = field ? block.primary[field] : undefined
  if (typeof heading === "string" && isOutlineFieldVisible(heading)) {
    // Kit titles and legacy HeadingSlot content both use this tolerant reader.
    // Project its document, never the stored HTML (inline joins and entities).
    names.push(
      richTextToPlainText(JSON.stringify(richTextToDocument(heading, "inline")))
    )
  }
  if (
    block.type === "faq-simple" ||
    block.type === "faq-accordion-two-column"
  ) {
    const items =
      block.type === "faq-simple" ? block.items : block.primary.items
    const fieldPath =
      block.type === "faq-simple" ? "items.question" : "primary.items.question"
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item?.question !== "string") continue
        // FAQ Simple transitions recognized title documents; plain questions
        // and the two-column renderer's questions remain literal text.
        const name = readFieldText(
          { blockType: block.type, fieldPath },
          item.question
        )
        if (name.trim()) names.push(name)
      }
    }
  }
  const hero = block.type === "hero-with-image" || block.type === "hero-agency"
  return names.map((name) => ({
    id: block.id,
    name,
    key: regionNameKey(name),
    hero,
  }))
}

/** One inventory owns collision counts and reservations; only Heroes rename. */
function collisionRegionLabels(blocks: Block[]): Map<string, string> {
  const regions = blocks.flatMap(renderedRegionNames)
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

export function BlockList({
  blocks,
  ctx,
  outline,
  registry = BLOCK_COMPONENTS,
}: {
  blocks: Block[]
  ctx: BlockRenderContext
  outline: PageOutline
  registry?: BlockRendererRegistry
}) {
  const registryReads: Readonly<
    Partial<
      Record<string, (block: never, ctx: BlockRenderContext) => React.ReactNode>
    >
  > = registry
  const visible = visibleOutlineBlocks(blocks)
  const regionLabels = collisionRegionLabels(visible)
  // Resolve the complete visible set before producing output. A legacy custom
  // registry retains ownership of its default; recorded choices require the
  // owned presentation registry until a caller explicitly qualifies an adapter.
  const renderers = new Map<
    string,
    (context: BlockRenderContext) => React.ReactNode
  >()
  for (const block of visible) {
    if (
      ctx.presentationCatalog &&
      !ctx.presentationCatalog.installedTypes.includes(readBlock(block).type)
    )
      throw new Error("Block presentation rendering refused: type-unavailable.")
    const usesSiteDefault =
      registry === BLOCK_COMPONENTS &&
      Object.hasOwn(SITE_PRESENTATION_DEFAULTS, readBlock(block).type)
    if (readBlock(block).presentationIdV1 === undefined && !usesSiteDefault)
      continue
    if (registry !== BLOCK_COMPONENTS || !ctx.presentationCatalog)
      throw new Error(
        "Block presentation rendering requires a qualified source catalog and registry."
      )
    const resolution = resolveRenderedBlockPresentation(
      ctx.presentationCatalog,
      {
        type: readBlock(block).type,
        presentationId: readBlock(block).presentationIdV1,
      }
    )
    if (resolution.status === "refused")
      throw new Error(
        `Block presentation rendering refused: ${resolution.reason}.`
      )
    // Validate dispatch before invoking an admin preview interceptor.
    const checked = renderBlockPresentation(block, ctx, resolution)
    if (checked.status === "refused")
      throw new Error(
        `Block presentation rendering refused: ${checked.reason}.`
      )
    renderers.set(readBlock(block).id, (context) => {
      const result = renderBlockPresentation(block, context, resolution)
      if (result.status === "refused")
        throw new Error("Block presentation renderer is unavailable.")
      return result.node
    })
  }
  return (
    <>
      {visible.map((block) => {
        const render = registryReads[readBlock(block).type]
        const renderOccurrence = (context: BlockRenderContext) => {
          context = {
            ...context,
            outline: outline.fieldsByBlockId[readBlock(block).id],
            regionLabel: regionLabels.get(readBlock(block).id),
          }
          const presentation = renderers.get(readBlock(block).id)
          return presentation ? (
            presentation(context)
          ) : render ? (
            render(block as never, context)
          ) : (
            <FallbackBlock block={block} />
          )
        }
        return (
          <div key={readBlock(block).id}>
            {ctx.previewBlock
              ? ctx.previewBlock(block, renderOccurrence)
              : renderOccurrence(ctx)}
          </div>
        )
      })}
    </>
  )
}
