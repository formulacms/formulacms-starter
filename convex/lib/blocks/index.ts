import { v, type Infer } from "convex/values"
import type { BlockStructure, BlockDescriptorStructure } from "./identity"
import { blockDefinitionProblems } from "../definitions/blocks"
import { formatDefinitionProblems } from "../definitions/common"

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

// ---- block descriptors -----------------------------------------------------
//
// The generated regions between the @block-codegen markers below are projected from
// lib/blocks/blocks.manifest.json by `pnpm blocks:sync` (ADR-0021). Do not edit
// them by hand — register a block by writing its descriptor + a manifest entry
// and re-running the sync.

// @block-codegen:block-exports:start
export { faqSimpleDef, faqSimpleBlock } from "./faqSimple"
export type { FaqSimpleBlock } from "./faqSimple"

export { featuresIconGridDef, featuresIconGridBlock } from "./featuresIconGrid"
export type { FeaturesIconGridBlock } from "./featuresIconGrid"

export { heroAgencyDef, heroAgencyBlock } from "./heroAgency"
export type { HeroAgencyBlock } from "./heroAgency"

export { heroWithImageDef, heroWithImageBlock } from "./heroWithImage"
export type { HeroWithImageBlock } from "./heroWithImage"

export { richTextBodyDef, richTextBodyBlock } from "./richTextBody"
export type { RichTextBodyBlock } from "./richTextBody"
// @block-codegen:block-exports:end

// @block-codegen:block-imports:start
import { withBlockOccurrencePresentation } from "./occurrencePresentation"
import { faqSimpleDef } from "./faqSimple"
import { featuresIconGridDef } from "./featuresIconGrid"
import { heroAgencyDef } from "./heroAgency"
import { heroWithImageDef } from "./heroWithImage"
import { richTextBodyDef } from "./richTextBody"
// @block-codegen:block-imports:end

/** The discriminated union of every registered block, built from registry defs. */
// @block-codegen:block-validator:start
export const blockValidator = v.union(
  withBlockOccurrencePresentation(faqSimpleDef.validator),
  withBlockOccurrencePresentation(featuresIconGridDef.validator),
  withBlockOccurrencePresentation(heroAgencyDef.validator),
  withBlockOccurrencePresentation(heroWithImageDef.validator),
  withBlockOccurrencePresentation(richTextBodyDef.validator),
)
// @block-codegen:block-validator:end

export type Block = Infer<typeof blockValidator>

/** The static installed-code validator used by authoring and restore inputs. */
// @block-codegen:block-installed-validator:start
export const installedBlockValidator = v.union(
  withBlockOccurrencePresentation(faqSimpleDef.validator),
  withBlockOccurrencePresentation(featuresIconGridDef.validator),
  withBlockOccurrencePresentation(heroAgencyDef.validator),
  withBlockOccurrencePresentation(heroWithImageDef.validator),
  withBlockOccurrencePresentation(richTextBodyDef.validator),
)
// @block-codegen:block-installed-validator:end

export type InstalledBlock = Infer<typeof installedBlockValidator>

/**
 * Registry of every block's primitive descriptors, keyed by type. The shared
 * source the schema-driven editor walks (Phase C) and the write-path gate reads.
 * `items` is present only on blocks that have a bounded list.
 */
// @block-codegen:block-defs:start
export const blockDefs = {
  "faq-simple": faqSimpleDef,
  "features-icon-grid": featuresIconGridDef,
  "hero-agency": heroAgencyDef,
  "hero-with-image": heroWithImageDef,
  "rich-text-body": richTextBodyDef,
} as const
// @block-codegen:block-defs:end

/** Descriptor view exposed to the installed authoring profile. */
// @block-codegen:block-installed-defs:start
export const installedBlockDefs = {
  "faq-simple": faqSimpleDef,
  "features-icon-grid": featuresIconGridDef,
  "hero-agency": heroAgencyDef,
  "hero-with-image": heroWithImageDef,
  "rich-text-body": richTextBodyDef,
} as const
// @block-codegen:block-installed-defs:end

// Definition check: runs once when this module loads, never per request, and
// reports every problem in one error (key and literal mismatches, a reserved
// field name, duplicate types).
{
  const problems = blockDefinitionProblems({ definitions: blockDefs })
  if (problems.length > 0) {
    throw new Error(formatDefinitionProblems(problems))
  }
}

/**
 * A block type slug. Derived from `blockDefs` so the registry is the single
 * enumeration — adding a descriptor adds the type with no second list to keep
 * in sync.
 */
export type BlockType = keyof typeof blockDefs
export type InstalledBlockType = keyof typeof installedBlockDefs

const registeredDescriptorReads: Readonly<
  Partial<Record<string, BlockDescriptorStructure>>
> = blockDefs
const installedDescriptorReads: Readonly<
  Partial<Record<string, BlockDescriptorStructure>>
> = installedBlockDefs

export function readBlockDefinition(type: BlockType): BlockDescriptorStructure
export function readBlockDefinition(
  type: string
): BlockDescriptorStructure | undefined
export function readBlockDefinition(
  type: string
): BlockDescriptorStructure | undefined {
  return registeredDescriptorReads[type]
}

export function readInstalledBlockDefinition(
  type: InstalledBlockType
): BlockDescriptorStructure
export function readInstalledBlockDefinition(
  type: string
): BlockDescriptorStructure | undefined
export function readInstalledBlockDefinition(
  type: string
): BlockDescriptorStructure | undefined {
  return installedDescriptorReads[type]
}

/**
 * Build a valid empty block from the registry's canonical defaults.
 *
 * Defaults are cloned per call because group/list primitives compute their
 * default once at module load. Convex actions and Next server-only modules can
 * therefore share one structural trust boundary without UI dependencies.
 */
export function createDefaultBlock(type: InstalledBlockType): InstalledBlock
export function createDefaultBlock(type: string): BlockStructure {
  const def = readInstalledBlockDefinition(type)
  if (!def) throw new Error(`Block type is not installed: ${type}`)
  const block: BlockStructure = {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    primary: structuredClone(def.primary.default),
  }
  if (def.items) block.items = structuredClone(def.items.default)
  return block
}

/**
 * Canonical, dependency-free list of block type slugs, derived from the
 * registry (insertion order preserved). Server-safe (no UI imports) so Convex
 * modules like the permission registry can map `blocks.<type>` permissions
 * from it.
 */
export const REGISTERED_BLOCK_TYPES = Object.keys(blockDefs) as BlockType[]
export const INSTALLED_BLOCK_TYPES = Object.keys(
  installedBlockDefs
) as InstalledBlockType[]
/** @deprecated Choose REGISTERED_BLOCK_TYPES or INSTALLED_BLOCK_TYPES explicitly. */
export const BLOCK_TYPES = INSTALLED_BLOCK_TYPES

/**
 * Compile-time guard: the validator union (`blockValidator` → `Block["type"]`)
 * and the descriptor registry (`blockDefs`) must enumerate the same block
 * types. Convex needs the union args statically, so the two lists stay
 * separate — but diverging them (add to one, forget the other) fails tsc here
 * instead of silently drifting permissions or rendering.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _unionMatchesDefs: Mutual<keyof typeof blockDefs, Block["type"]> = true
void _unionMatchesDefs
const _installedUnionMatchesDefs: Mutual<
  keyof typeof installedBlockDefs,
  InstalledBlock["type"]
> = true
void _installedUnionMatchesDefs

/**
 * The AI-facing hint co-located on every block descriptor (ADR-0014).
 * `purpose` is a one-liner the page-level outline prompt advertises so the
 * model can pick a sensible block mix from a brief. `fields` is the
 * per-block tagged-field guide that block-level Write appends to the user
 * prompt.
 */
export type AIHint = {
  purpose: string
  fields: string
}
