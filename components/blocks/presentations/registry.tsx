// @starter-projection:hero-presentations:start
import { hasBlockType } from "@/convex/lib/blocks/identity"
// @starter-projection:hero-presentations:end
import { readBlock } from "@/convex/lib/blocks/identity"
import type { ReactNode } from "react"
// @starter-projection:hero-presentations:start
import type { HeroWithImageBlock } from "@/convex/lib/blocks/heroWithImage"
// @starter-projection:hero-presentations:end
import type { Block } from "@/convex/lib/blocks"
// @starter-projection:hero-presentations:start
import type { BlockPresentationId } from "@/convex/lib/blocks/presentationResolution"
// @starter-projection:hero-presentations:end
import type { RenderPresentationResolution } from "./resolution"
import type { BlockRenderContext } from "@/lib/blocks/links"
// @starter-projection:hero-presentations:start
import { HeroWithImage } from "../hero-with-image"
// @starter-projection:hero-presentations:end
import { BLOCK_COMPONENTS } from "../block-registry"
// @starter-projection:hero-presentations:start
import { HeroWithImageCentered } from "./hero-with-image-centered"
// @starter-projection:hero-presentations:end

// @starter-projection:hero-presentations:start
/** Owned source dispatch only; neither BlockList nor a caller registry changes. */
export const HERO_PRESENTATION_RENDERERS = {
  default: (block, ctx) => <HeroWithImage block={block} ctx={ctx} />,
  centered: (block, ctx) => <HeroWithImageCentered block={block} ctx={ctx} />,
} satisfies Record<
  BlockPresentationId,
  (block: HeroWithImageBlock, ctx: BlockRenderContext) => ReactNode
>
// @starter-projection:hero-presentations:end

/** Installed dispatch availability, separate from catalog qualification. */
export function hasBlockPresentationRenderer(
  type: string,
  id: string
): boolean {
  // @starter-projection:hero-presentations:start
  if (type === "hero-with-image")
    return Object.hasOwn(HERO_PRESENTATION_RENDERERS, id)
  // @starter-projection:hero-presentations:end
  return id === "default" && Object.hasOwn(BLOCK_COMPONENTS, type)
}

export type BlockPresentationRenderResult =
  | {
      status: "rendered"
      resolution: Exclude<RenderPresentationResolution, { status: "refused" }>
      node: ReactNode
    }
  | {
      status: "refused"
      reason: "resolution-refused" | "type-mismatch" | "renderer-unavailable"
      resolution: RenderPresentationResolution
    }

/**
 * Consume the whole resolver result so retained requested IDs/fallback reasons
 * survive dispatch. This is an explicit internal source adapter, not public
 * registration, Page acceptance or support for a legacy custom registry.
 */
export function renderBlockPresentation(
  block: Block,
  ctx: BlockRenderContext,
  resolution: RenderPresentationResolution
): BlockPresentationRenderResult {
  if (resolution.status === "refused")
    return { status: "refused", reason: "resolution-refused", resolution }
  if (readBlock(block).type !== resolution.type)
    return { status: "refused", reason: "type-mismatch", resolution }
  if (
    !hasBlockPresentationRenderer(readBlock(block).type, resolution.resolvedId)
  )
    return { status: "refused", reason: "renderer-unavailable", resolution }
  // @starter-projection:hero-presentations:start
  if (hasBlockType(block, "hero-with-image")) {
    return {
      status: "rendered",
      resolution,
      node: HERO_PRESENTATION_RENDERERS[resolution.resolvedId](block, ctx),
    }
  }
  // @starter-projection:hero-presentations:end
  // The discriminator selects the existing generated, type-complete registry.
  // Keep its current dispatch rather than duplicating every non-pilot renderer.
  const rendererReads: Readonly<
    Partial<
      Record<string, (block: never, context: BlockRenderContext) => ReactNode>
    >
  > = BLOCK_COMPONENTS
  const renderDefault = rendererReads[readBlock(block).type] as (
    value: Block,
    context: BlockRenderContext
  ) => ReactNode
  return { status: "rendered", resolution, node: renderDefault(block, ctx) }
}
