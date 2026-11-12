import { v, type Infer } from "convex/values"
import type { SliceStructure, SliceDescriptorStructure } from "./identity"

// ---- registry + reusable field descriptors --------------------------------
export * from "./primitives"

export {
  imagePrimitive,
  imageField,
  linkPrimitive,
  cmsLinkField,
  button,
  buttonField,
} from "./fields"
export type { ImageField, CMSLinkField, ButtonField } from "./fields"

// ---- slice descriptors -----------------------------------------------------
//
// The generated regions between the @slice-codegen markers below are projected from
// lib/slices/slices.manifest.json by `pnpm slices:sync` (ADR-0021). Do not edit
// them by hand — register a slice by writing its descriptor + a manifest entry
// and re-running the sync.

// @slice-codegen:slice-exports:start
export { faqSimpleDef, faqSimpleSlice } from "./faqSimple"
export type { FaqSimpleSlice } from "./faqSimple"

export { featuresIconGridDef, featuresIconGridSlice } from "./featuresIconGrid"
export type { FeaturesIconGridSlice } from "./featuresIconGrid"

export { heroAgencyDef, heroAgencySlice } from "./heroAgency"
export type { HeroAgencySlice } from "./heroAgency"

export { heroWithImageDef, heroWithImageSlice } from "./heroWithImage"
export type { HeroWithImageSlice } from "./heroWithImage"

export { richTextBodyDef, richTextBodySlice } from "./richTextBody"
export type { RichTextBodySlice } from "./richTextBody"
// @slice-codegen:slice-exports:end

// @slice-codegen:slice-imports:start
import { withSliceOccurrencePresentation } from "./occurrencePresentation"
import { faqSimpleDef } from "./faqSimple"
import { featuresIconGridDef } from "./featuresIconGrid"
import { heroAgencyDef } from "./heroAgency"
import { heroWithImageDef } from "./heroWithImage"
import { richTextBodyDef } from "./richTextBody"
// @slice-codegen:slice-imports:end

/** The discriminated union of every registered slice, built from registry defs. */
// @slice-codegen:slice-validator:start
export const sliceValidator = v.union(
  withSliceOccurrencePresentation(faqSimpleDef.validator),
  withSliceOccurrencePresentation(featuresIconGridDef.validator),
  withSliceOccurrencePresentation(heroAgencyDef.validator),
  withSliceOccurrencePresentation(heroWithImageDef.validator),
  withSliceOccurrencePresentation(richTextBodyDef.validator),
)
// @slice-codegen:slice-validator:end

export type Slice = Infer<typeof sliceValidator>

/** The static installed-code validator used by authoring and restore inputs. */
// @slice-codegen:slice-installed-validator:start
export const installedSliceValidator = v.union(
  withSliceOccurrencePresentation(faqSimpleDef.validator),
  withSliceOccurrencePresentation(featuresIconGridDef.validator),
  withSliceOccurrencePresentation(heroAgencyDef.validator),
  withSliceOccurrencePresentation(heroWithImageDef.validator),
  withSliceOccurrencePresentation(richTextBodyDef.validator),
)
// @slice-codegen:slice-installed-validator:end

export type InstalledSlice = Infer<typeof installedSliceValidator>

/**
 * Registry of every slice's primitive descriptors, keyed by type. The shared
 * source the schema-driven editor walks (Phase C) and the write-path gate reads.
 * `items` is present only on slices that have a bounded list.
 */
// @slice-codegen:slice-defs:start
export const sliceDefs = {
  "faq-simple": faqSimpleDef,
  "features-icon-grid": featuresIconGridDef,
  "hero-agency": heroAgencyDef,
  "hero-with-image": heroWithImageDef,
  "rich-text-body": richTextBodyDef,
} as const
// @slice-codegen:slice-defs:end

/** Descriptor view exposed to the installed authoring profile. */
// @slice-codegen:slice-installed-defs:start
export const installedSliceDefs = {
  "faq-simple": faqSimpleDef,
  "features-icon-grid": featuresIconGridDef,
  "hero-agency": heroAgencyDef,
  "hero-with-image": heroWithImageDef,
  "rich-text-body": richTextBodyDef,
} as const
// @slice-codegen:slice-installed-defs:end

/**
 * A slice type slug. Derived from `sliceDefs` so the registry is the single
 * enumeration — adding a descriptor adds the type with no second list to keep
 * in sync.
 */
export type SliceType = keyof typeof sliceDefs
export type InstalledSliceType = keyof typeof installedSliceDefs

const registeredDescriptorReads: Readonly<
  Partial<Record<string, SliceDescriptorStructure>>
> = sliceDefs
const installedDescriptorReads: Readonly<
  Partial<Record<string, SliceDescriptorStructure>>
> = installedSliceDefs

export function readSliceDefinition(type: SliceType): SliceDescriptorStructure
export function readSliceDefinition(
  type: string
): SliceDescriptorStructure | undefined
export function readSliceDefinition(
  type: string
): SliceDescriptorStructure | undefined {
  return registeredDescriptorReads[type]
}

export function readInstalledSliceDefinition(
  type: InstalledSliceType
): SliceDescriptorStructure
export function readInstalledSliceDefinition(
  type: string
): SliceDescriptorStructure | undefined
export function readInstalledSliceDefinition(
  type: string
): SliceDescriptorStructure | undefined {
  return installedDescriptorReads[type]
}

/**
 * Build a valid empty slice from the registry's canonical defaults.
 *
 * Defaults are cloned per call because group/list primitives compute their
 * default once at module load. Convex actions and Next server-only modules can
 * therefore share one structural trust boundary without UI dependencies.
 */
export function createDefaultSlice(type: InstalledSliceType): InstalledSlice
export function createDefaultSlice(type: string): SliceStructure {
  const def = readInstalledSliceDefinition(type)
  if (!def) throw new Error(`Slice type is not installed: ${type}`)
  const slice: SliceStructure = {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    primary: structuredClone(def.primary.default),
  }
  if (def.items) slice.items = structuredClone(def.items.default)
  return slice
}

/**
 * Canonical, dependency-free list of slice type slugs, derived from the
 * registry (insertion order preserved). Server-safe (no UI imports) so Convex
 * modules like the permission registry can map `slices.<type>` permissions
 * from it.
 */
export const REGISTERED_SLICE_TYPES = Object.keys(sliceDefs) as SliceType[]
export const INSTALLED_SLICE_TYPES = Object.keys(
  installedSliceDefs
) as InstalledSliceType[]
/** @deprecated Choose REGISTERED_SLICE_TYPES or INSTALLED_SLICE_TYPES explicitly. */
export const SLICE_TYPES = INSTALLED_SLICE_TYPES

/**
 * Compile-time guard: the validator union (`sliceValidator` → `Slice["type"]`)
 * and the descriptor registry (`sliceDefs`) must enumerate the same slice
 * types. Convex needs the union args statically, so the two lists stay
 * separate — but diverging them (add to one, forget the other) fails tsc here
 * instead of silently drifting permissions or rendering.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _unionMatchesDefs: Mutual<keyof typeof sliceDefs, Slice["type"]> = true
void _unionMatchesDefs
const _installedUnionMatchesDefs: Mutual<
  keyof typeof installedSliceDefs,
  InstalledSlice["type"]
> = true
void _installedUnionMatchesDefs

/**
 * The AI-facing hint co-located on every slice descriptor (ADR-0014).
 * `purpose` is a one-liner the page-level outline prompt advertises so the
 * model can pick a sensible slice mix from a brief. `fields` is the
 * per-slice fenced-block block slice-level Write appends to the user
 * prompt.
 */
export type AIHint = {
  purpose: string
  fields: string
}
