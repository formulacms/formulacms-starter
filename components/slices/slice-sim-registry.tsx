import type { InstalledSlice } from "@/convex/lib/slices"
import type { SliceRenderContext } from "@/lib/slices/links"
// The query-scoped renderer imports and registry below are GENERATED from
// lib/slices/slices.manifest.json by `pnpm slices:sync` (Plan 032 Phase 1).
// @slice-codegen:slice-sim-renderer-imports:start
import { FaqSimple } from "@/components/slices/faq-simple?tweak-loc"
import { FeaturesIconGrid } from "@/components/slices/features-icon-grid?tweak-loc"
import { HeroAgency } from "@/components/slices/hero-agency?tweak-loc"
import { HeroWithImage } from "@/components/slices/hero-with-image?tweak-loc"
import { RichTextBody } from "@/components/slices/rich-text-body?tweak-loc"
// @slice-codegen:slice-sim-renderer-imports:end

// @slice-codegen:slice-sim-components:start
export const SLICE_SIM_COMPONENTS = {
  "faq-simple": (slice, ctx) => <FaqSimple slice={slice} ctx={ctx} />,
  "features-icon-grid": (slice, ctx) => <FeaturesIconGrid slice={slice} ctx={ctx} />,
  "hero-agency": (slice, ctx) => <HeroAgency slice={slice} ctx={ctx} />,
  "hero-with-image": (slice, ctx) => <HeroWithImage slice={slice} ctx={ctx} />,
  "rich-text-body": (slice, ctx) => <RichTextBody slice={slice} ctx={ctx} />,
} satisfies {
  [T in InstalledSlice["type"]]: (
    slice: Extract<InstalledSlice, { type: T }>,
    ctx: SliceRenderContext
  ) => React.ReactNode
}
// @slice-codegen:slice-sim-components:end
