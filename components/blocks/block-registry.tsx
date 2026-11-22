import type { Block } from "@/convex/lib/blocks"
import type { BlockRenderContext } from "@/lib/blocks/links"
// The renderer imports and BLOCK_COMPONENTS below are GENERATED from
// lib/blocks/blocks.manifest.json by `pnpm blocks:sync` (ADR-0021). Do not edit
// the regions between the @block-codegen markers by hand.
// @block-codegen:block-renderer-imports:start
import { FaqSimple } from "./faq-simple"
import { FeaturesIconGrid } from "./features-icon-grid"
import { HeroAgency } from "./hero-agency"
import { HeroWithImage } from "./hero-with-image"
import { RichTextBody } from "./rich-text-body"
// @block-codegen:block-renderer-imports:end

/**
 * Render-side registry: maps a block type to its public component. Phase 2's
 * generator appends one entry here per generated block type. The `satisfies`
 * clause makes `tsc` a renderer-completeness gate — adding a block type to the
 * union without a renderer entry here is a type error, so a registered block can
 * never silently fall through to the fallback at runtime.
 *
 * Exported so the block simulator / authoring-agent verify-loop (ADR-0016) can
 * assert a generated block has a real renderer wired (see {@link hasRenderer}).
 */
// @block-codegen:block-components:start
export const BLOCK_COMPONENTS = {
  "faq-simple": (block, ctx) => <FaqSimple block={block} ctx={ctx} />,
  "features-icon-grid": (block, ctx) => <FeaturesIconGrid block={block} ctx={ctx} />,
  "hero-agency": (block, ctx) => <HeroAgency block={block} ctx={ctx} />,
  "hero-with-image": (block, ctx) => <HeroWithImage block={block} ctx={ctx} />,
  "rich-text-body": (block, ctx) => <RichTextBody block={block} ctx={ctx} />,
} satisfies {
  [T in Block["type"]]: (
    block: Extract<Block, { type: T }>,
    ctx: BlockRenderContext
  ) => React.ReactNode
}
// @block-codegen:block-components:end

/** True when `type` has a registered public renderer (i.e. `BlockList` would not
 *  fall back to the unstyled fallback). Used by the simulator + agent verify-loop. */
export function hasRenderer(type: Block["type"]): boolean {
  return type in BLOCK_COMPONENTS
}
