/** Owned exact-Hero source data. Candidate acceptance appends reviewed entries;
 * the complete dataset and static renderer dispatch are one gated write set.
 * Keeping the default first preserves its separately reviewed contract pin.
 * No candidate, request or runtime registry supplies these definitions. */
export const HERO_PRESENTATION_DEFINITIONS = [
  {
    id: "default",
    label: "Default",
    state: "active",
    installed: true,
    contractSha256:
      "sha256:3663f3f8e90071fbcec80d51b8a5ef1b2e629cc1769dff000c61bf2ba21a0d38",
    rendererSource: "components/blocks/hero-with-image.tsx",
    exportName: "HeroWithImage",
  },
  {
    id: "centered",
    label: "Centered",
    state: "active",
    installed: true,
    contractSha256:
      "sha256:3663f3f8e90071fbcec80d51b8a5ef1b2e629cc1769dff000c61bf2ba21a0d38",
    rendererSource:
      "components/blocks/presentations/hero-with-image-centered.tsx",
    exportName: "HeroWithImageCentered",
  },
] as const
