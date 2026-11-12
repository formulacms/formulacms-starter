/** Creation-only scope rules. Tweak and refine flows already target one Slice. */
export const SLICE_SCOPE_RULES = [
  "A slice is ONE independently placeable editorial section with ONE editorial job. The test is whether an editor could place it on another page by itself and it would still make sense.",
  'If the input shows a site header, primary navigation, breadcrumb, site footer, or more than one independently placeable section, it is a PAGE. Return a fenced JSON decomposition shaped as {"sections":[{"slug":"kebab-case","purpose":"one line","triage":{"decision":"new-slice"}}]} from top to bottom, and emit no SliceSpec.',
  "Never model a site header, primary navigation, breadcrumb, site footer, or content-type header as a slice. Those belong to app-shell layout or a content-type renderer.",
  "Prefer the smaller coherent section. A related-items row, pull quote, or stat strip that has its own editorial job should remain independently placeable.",
  "Size alone is not the test. A content-heavy section is still one slice when every field serves the same editorial job.",
  'Run the ADR-0044 reuse triage for every section: {"decision":"reuse","type":"registered-type"} when an existing type and renderer express the job exactly and unchanged; {"decision":"new-presentation","type":"registered-type","contractSha256":"sha256:<exact supplied reference>"} for a new visual design using its exact unchanged editorial contract; {"decision":"new-sibling","family":"family-name"} for a distinct editorial or repeated-field contract; {"decision":"new-slice"} for a genuinely new reusable contract; or {"decision":"app-shell"} for site chrome and content-type headers.',
  'Reuse means unchanged. Never mutate or extend an existing Slice Type to absorb a different design. A close match that needs schema contortions is "new-sibling" or "new-slice", never "reuse".',
  "Ground every reuse or new-presentation decision in the supplied registered slice catalog. Never invent a catalog type or contract reference. Styling-only differences belong to tokens/CSS and do not earn a new Slice Type.",
  "A new-presentation verdict is a non-writing classification handoff for presentation review, not a generated renderer, compatibility approval or source acceptance. Copy its contractSha256 from the current supplied references; emit no SliceSpec, fields, defaults or source payload. Adding even an optional editorial field, changing field meaning/optionality or changing repetition requires new-sibling or new-slice.",
] as const

export const SLICE_SCOPE_RULES_TEXT = SLICE_SCOPE_RULES.map(
  (rule) => `- ${rule}`
).join("\n")
