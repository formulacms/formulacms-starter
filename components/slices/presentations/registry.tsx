// @starter-projection:hero-presentations:start
import { hasSliceType } from "@/convex/lib/slices/identity"
// @starter-projection:hero-presentations:end
import { readSlice } from "@/convex/lib/slices/identity"
import type { ReactNode } from "react"
// @starter-projection:hero-presentations:start
import type { HeroWithImageSlice } from "@/convex/lib/slices/heroWithImage"
// @starter-projection:hero-presentations:end
import type { Slice } from "@/convex/lib/slices"
// @starter-projection:hero-presentations:start
import type { SlicePresentationId } from "@/convex/lib/slices/presentationResolution"
// @starter-projection:hero-presentations:end
import type { RenderPresentationResolution } from "./resolution"
import type { SliceRenderContext } from "@/lib/slices/links"
// @starter-projection:hero-presentations:start
import { HeroWithImage } from "../hero-with-image"
// @starter-projection:hero-presentations:end
import { SLICE_COMPONENTS } from "../slice-zone-registry"
// @starter-projection:hero-presentations:start
import { HeroWithImageCentered } from "./hero-with-image-centered"
// @starter-projection:hero-presentations:end

// @starter-projection:hero-presentations:start
/** Owned source dispatch only; neither SliceZone nor a caller registry changes. */
export const HERO_PRESENTATION_RENDERERS = {
  default: (slice, ctx) => <HeroWithImage slice={slice} ctx={ctx} />,
  centered: (slice, ctx) => <HeroWithImageCentered slice={slice} ctx={ctx} />,
} satisfies Record<
  SlicePresentationId,
  (slice: HeroWithImageSlice, ctx: SliceRenderContext) => ReactNode
>
// @starter-projection:hero-presentations:end

/** Installed dispatch availability, separate from catalog qualification. */
export function hasSlicePresentationRenderer(
  type: string,
  id: string
): boolean {
  // @starter-projection:hero-presentations:start
  if (type === "hero-with-image")
    return Object.hasOwn(HERO_PRESENTATION_RENDERERS, id)
  // @starter-projection:hero-presentations:end
  return id === "default" && Object.hasOwn(SLICE_COMPONENTS, type)
}

export type SlicePresentationRenderResult =
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
export function renderSlicePresentation(
  slice: Slice,
  ctx: SliceRenderContext,
  resolution: RenderPresentationResolution
): SlicePresentationRenderResult {
  if (resolution.status === "refused")
    return { status: "refused", reason: "resolution-refused", resolution }
  if (readSlice(slice).type !== resolution.type)
    return { status: "refused", reason: "type-mismatch", resolution }
  if (
    !hasSlicePresentationRenderer(readSlice(slice).type, resolution.resolvedId)
  )
    return { status: "refused", reason: "renderer-unavailable", resolution }
  // @starter-projection:hero-presentations:start
  if (hasSliceType(slice, "hero-with-image")) {
    return {
      status: "rendered",
      resolution,
      node: HERO_PRESENTATION_RENDERERS[resolution.resolvedId](slice, ctx),
    }
  }
  // @starter-projection:hero-presentations:end
  // The discriminator selects the existing generated, type-complete registry.
  // Keep its current dispatch rather than duplicating every non-pilot renderer.
  const rendererReads: Readonly<
    Partial<
      Record<string, (slice: never, context: SliceRenderContext) => ReactNode>
    >
  > = SLICE_COMPONENTS
  const renderDefault = rendererReads[readSlice(slice).type] as (
    value: Slice,
    context: SliceRenderContext
  ) => ReactNode
  return { status: "rendered", resolution, node: renderDefault(slice, ctx) }
}
