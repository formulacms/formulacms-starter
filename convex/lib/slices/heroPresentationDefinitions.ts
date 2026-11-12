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
      "sha256:ea5e766a3801e03544631c05be55036986fe11e67bec2f004f589a187dec244a",
    rendererSource: "components/slices/hero-with-image.tsx",
    exportName: "HeroWithImage",
  },
  {
    id: "centered",
    label: "Centered",
    state: "active",
    installed: true,
    contractSha256:
      "sha256:ea5e766a3801e03544631c05be55036986fe11e67bec2f004f589a187dec244a",
    rendererSource:
      "components/slices/presentations/hero-with-image-centered.tsx",
    exportName: "HeroWithImageCentered",
  },
] as const
