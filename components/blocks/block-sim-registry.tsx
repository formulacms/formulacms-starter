import type { InstalledBlock } from "@/convex/lib/blocks"
import type { BlockRenderContext } from "@/lib/blocks/links"
// The query-scoped renderer imports and registry below are GENERATED from
// lib/blocks/blocks.manifest.json by `pnpm blocks:sync` (Plan 032 Phase 1).
// @block-codegen:block-sim-renderer-imports:start
import { FaqSimple } from "@/components/blocks/faq-simple?tweak-loc"
import { FeaturesIconGrid } from "@/components/blocks/features-icon-grid?tweak-loc"
import { HeroAgency } from "@/components/blocks/hero-agency?tweak-loc"
import { HeroWithImage } from "@/components/blocks/hero-with-image?tweak-loc"
import { RichTextBody } from "@/components/blocks/rich-text-body?tweak-loc"
// @block-codegen:block-sim-renderer-imports:end

// @block-codegen:block-sim-components:start
export const BLOCK_SIM_COMPONENTS = {
  "faq-simple": (block, ctx) => <FaqSimple block={block} ctx={ctx} />,
  "features-icon-grid": (block, ctx) => <FeaturesIconGrid block={block} ctx={ctx} />,
  "hero-agency": (block, ctx) => <HeroAgency block={block} ctx={ctx} />,
  "hero-with-image": (block, ctx) => <HeroWithImage block={block} ctx={ctx} />,
  "rich-text-body": (block, ctx) => <RichTextBody block={block} ctx={ctx} />,
} satisfies {
  [T in InstalledBlock["type"]]: (
    block: Extract<InstalledBlock, { type: T }>,
    ctx: BlockRenderContext
  ) => React.ReactNode
}
// @block-codegen:block-sim-components:end
