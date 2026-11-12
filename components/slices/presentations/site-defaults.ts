import type { SliceType } from "@/convex/lib/slices"

export type SitePresentationDefault = Readonly<{
  id: string
  /** Pin only this Type and selected presentation's structural contracts. */
  typeContractSha256: string
  presentationContractSha256: string
}>

export type SitePresentationDefaults = Readonly<
  Partial<Record<SliceType, SitePresentationDefault>>
>

/**
 * Optional installed site choices, owned by code beside the renderer registry.
 * Add a Type's ID, its contract digest and the selected entry's contract digest.
 * Unrelated catalog additions do not invalidate these dependency-local pins.
 * site-defaults-config.test.tsx verifies the installed choices without fallback.
 * Empty configuration preserves legacy rendering. These are render choices,
 * never occurrence metadata, stored Settings, or assignment/write authority.
 */
export const SITE_PRESENTATION_DEFAULTS: SitePresentationDefaults =
  Object.freeze({})
