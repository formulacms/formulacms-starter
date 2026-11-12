import type { Slice } from "@/convex/lib/slices"
import { INSTALLED_SLICE_TYPES, type InstalledSlice } from "@/convex/lib/slices"
export { createDefaultSlice } from "@/convex/lib/slices"
// The lucide import and SLICE_METADATA below are GENERATED from
// lib/slices/slices.manifest.json by `pnpm slices:sync` (ADR-0021). Do not edit
// the regions between the @slice-codegen markers by hand.
// @slice-codegen:slice-icons:start
import {
  FileText,
  HelpCircle,
  Layers,
  Layout,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react"
// @slice-codegen:slice-icons:end

export type SliceType = InstalledSlice["type"]
export type RegisteredSliceType = Slice["type"]

/**
 * Closed union of picker section IDs. Slices declare exactly one (no
 * multi-tagging) — a single-home picker is easier to scan, and the catalog is
 * authored as code so widening this later via PR is cheap. ADR-0016: new
 * slices added by the slice-author skill must pick an existing group;
 * introducing a new group is the exception and should be argued in the PR.
 */
export type SliceGroup =
  "heroes" | "cta" | "faq" | "features" | "forms" | "body-copy" | "misc"

export const SLICE_GROUPS: { id: SliceGroup; label: string }[] = [
  { id: "heroes", label: "Heroes" },
  { id: "cta", label: "CTA" },
  { id: "faq", label: "FAQ" },
  { id: "features", label: "Features" },
  { id: "forms", label: "Forms" },
  { id: "body-copy", label: "Body copy" },
  { id: "misc", label: "Misc" },
]

/**
 * Provenance of a registered slice. `system` = a reference slice that ships
 * with formulacms (present since install); `user` = a slice authored on this
 * site through the ADR-0019 funnel. Used by
 * the admin catalog to separate the shipped set from the owner's own slices.
 * Absent in the manifest ⇒ `system` (so the shipped entries stay diff-free);
 * the scaffolder stamps `user` on every slice it appends.
 */
export type SliceOrigin = "system" | "user"

export type SliceMetadata = {
  label: string
  description: string
  icon: LucideIcon
  group: SliceGroup
  origin: SliceOrigin
}

/**
 * Display metadata for the installed authoring set. Registered stored content
 * may legitimately have no metadata after its Slice Type is deselected.
 */
// @slice-codegen:slice-metadata:start
export const SLICE_METADATA: Partial<Record<RegisteredSliceType, SliceMetadata>> &
  Record<SliceType, SliceMetadata> = {
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
// @slice-codegen:slice-metadata:end

/** @deprecated Choose INSTALLED_SLICE_TYPES explicitly in new consumers. */
export const SLICE_TYPES = INSTALLED_SLICE_TYPES

/** A read view; the registered/installed metadata intersection above stays exact. */
export function readSliceMetadata(type: string): SliceMetadata | undefined {
  const metadata: Readonly<Partial<Record<string, SliceMetadata>>> =
    SLICE_METADATA
  return metadata[type]
}
