import type { Slice } from "@/convex/lib/slices"
import type { SliceRenderContext } from "@/lib/slices/links"
// The renderer imports and SLICE_COMPONENTS below are GENERATED from
// lib/slices/slices.manifest.json by `pnpm slices:sync` (ADR-0021). Do not edit
// the regions between the @slice-codegen markers by hand.
// @slice-codegen:slice-renderer-imports:start
import { FaqSimple } from "./faq-simple"
import { FeaturesIconGrid } from "./features-icon-grid"
import { HeroAgency } from "./hero-agency"
import { HeroWithImage } from "./hero-with-image"
import { RichTextBody } from "./rich-text-body"
// @slice-codegen:slice-renderer-imports:end

/**
 * Render-side registry: maps a slice type to its public component. Phase 2's
 * generator appends one entry here per generated slice type. The `satisfies`
 * clause makes `tsc` a renderer-completeness gate — adding a slice type to the
 * union without a renderer entry here is a type error, so a registered slice can
 * never silently fall through to the fallback at runtime.
 *
 * Exported so the slice simulator / authoring-agent verify-loop (ADR-0016) can
 * assert a generated slice has a real renderer wired (see {@link hasRenderer}).
 */
// @slice-codegen:slice-components:start
export const SLICE_COMPONENTS = {
  "faq-simple": (slice, ctx) => <FaqSimple slice={slice} ctx={ctx} />,
  "features-icon-grid": (slice, ctx) => <FeaturesIconGrid slice={slice} ctx={ctx} />,
  "hero-agency": (slice, ctx) => <HeroAgency slice={slice} ctx={ctx} />,
  "hero-with-image": (slice, ctx) => <HeroWithImage slice={slice} ctx={ctx} />,
  "rich-text-body": (slice, ctx) => <RichTextBody slice={slice} ctx={ctx} />,
} satisfies {
  [T in Slice["type"]]: (
    slice: Extract<Slice, { type: T }>,
    ctx: SliceRenderContext
  ) => React.ReactNode
}
// @slice-codegen:slice-components:end

/** True when `type` has a registered public renderer (i.e. `SliceZone` would not
 *  fall back to the unstyled fallback). Used by the simulator + agent verify-loop. */
export function hasRenderer(type: Slice["type"]): boolean {
  return type in SLICE_COMPONENTS
}
