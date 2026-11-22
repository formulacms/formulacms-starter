import type { Block } from "@/convex/lib/blocks"
import { INSTALLED_BLOCK_TYPES, type InstalledBlock } from "@/convex/lib/blocks"
export { createDefaultBlock } from "@/convex/lib/blocks"
// The lucide import and BLOCK_METADATA below are GENERATED from
// lib/blocks/blocks.manifest.json by `pnpm blocks:sync` (ADR-0021). Do not edit
// the regions between the @block-codegen markers by hand.
// @block-codegen:block-icons:start
import {
  FileText,
  HelpCircle,
  Layers,
  Layout,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react"
// @block-codegen:block-icons:end

export type BlockType = InstalledBlock["type"]
export type RegisteredBlockType = Block["type"]

/**
 * Closed union of picker section IDs. Blocks declare exactly one (no
 * multi-tagging) — a single-home picker is easier to scan, and the catalog is
 * authored as code so widening this later via PR is cheap. ADR-0016: new
 * blocks added by the block-author skill must pick an existing group;
 * introducing a new group is the exception and should be argued in the PR.
 */
export type BlockGroup =
  "heroes" | "cta" | "faq" | "features" | "forms" | "body-copy" | "misc"

export const BLOCK_GROUPS: { id: BlockGroup; label: string }[] = [
  { id: "heroes", label: "Heroes" },
  { id: "cta", label: "CTA" },
  { id: "faq", label: "FAQ" },
  { id: "features", label: "Features" },
  { id: "forms", label: "Forms" },
  { id: "body-copy", label: "Body copy" },
  { id: "misc", label: "Misc" },
]

/**
 * Provenance of a registered block. `system` = a reference block that ships
 * with formulacms (present since install); `user` = a block authored on this
 * site through the ADR-0019 funnel. Used by
 * the admin catalog to separate the shipped set from the owner's own blocks.
 * Absent in the manifest ⇒ `system` (so the shipped entries stay diff-free);
 * the scaffolder stamps `user` on every block it appends.
 */
export type BlockOrigin = "system" | "user"

export type BlockMetadata = {
  label: string
  description: string
  icon: LucideIcon
  group: BlockGroup
  origin: BlockOrigin
}

/**
 * Display metadata for the installed authoring set. Registered stored content
 * may legitimately have no metadata after its Block Type is deselected.
 */
// @block-codegen:block-metadata:start
export const BLOCK_METADATA: Partial<Record<RegisteredBlockType, BlockMetadata>> &
  Record<BlockType, BlockMetadata> = {
  "faq-simple": {
    label: "FAQ Simple",
    description: "Section heading with an expandable accordion of FAQ items.",
    icon: HelpCircle,
    group: "faq",
    origin: "system",
  },
  "features-icon-grid": {
    label: "Features Icon Grid",
    description: "Responsive grid of feature cards with optional icon, title, and description under a section heading.",
    icon: LayoutGrid,
    group: "features",
    origin: "system",
  },
  "hero-agency": {
    label: "Hero Agency",
    description: "High-impact agency hero with eyebrow text and split footer layout.",
    icon: Layout,
    group: "heroes",
    origin: "system",
  },
  "hero-with-image": {
    label: "Hero with Image",
    description: "Split hero with eyebrow announcement, headline, description, CTAs, and a side image.",
    icon: Layers,
    group: "heroes",
    origin: "system",
  },
  "rich-text-body": {
    label: "Rich Text Body",
    description: "A plain full-width rich-text content block for article bodies, long-form prose, or imported documents.",
    icon: FileText,
    group: "body-copy",
    origin: "system",
  },
}
// @block-codegen:block-metadata:end

/** @deprecated Choose INSTALLED_BLOCK_TYPES explicitly in new consumers. */
export const BLOCK_TYPES = INSTALLED_BLOCK_TYPES

/** A read view; the registered/installed metadata intersection above stays exact. */
export function readBlockMetadata(type: string): BlockMetadata | undefined {
  const metadata: Readonly<Partial<Record<string, BlockMetadata>>> =
    BLOCK_METADATA
  return metadata[type]
}
