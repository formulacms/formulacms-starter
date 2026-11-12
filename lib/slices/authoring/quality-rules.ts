// Pure prompt text shared by Convex agents, the in-admin authoring UI, and tests.

export const SLICE_RENDERER_QUALITY_RULES = [
  'Render public slices as pure React Server Components by default. Do not add "use client", hooks, effects, event handlers, browser globals, timers, random values, or date-now logic.',
  "Use composition for clarity, not abstraction theater: extract small local subcomponents only for repeated structures such as cards, stat rows, media blocks, or CTA groups. Keep props primitive and explicit.",
  "Do not use React.memo, useMemo, or useCallback in generated public slice renderers. Those are client re-render optimizations; use them only inside deliberate client islands with expensive children and stable props.",
  "Keep render work cheap and deterministic. Do not sort, filter, parse, fetch, format large arrays, or build complex derived structures inside JSX. Content order should come from the CMS.",
  "Use semantic HTML: section plus heading, ul/ol/li for repeated lists, article for cards, dl/dt/dd for stats or term-description rows, blockquote/cite for testimonials, figure/figcaption for captioned media, and table/caption/th scope for real tabular data.",
  "Every CMS field intended as a heading is a title-contract richText field rendered through the kit RichText host with no `as` prop. Never wrap it in a literal h1–h6 tag and never interpolate a plain text field as a heading.",
  "When a section has a visible heading, label the section with aria-labelledby using a stable id derived from slice.id. Interactive-looking elements must be real links or buttons; navigation uses links, not buttons.",
  "Use stable keys for lists. Prefer a field-derived key such as item.title, item.label, or item.slug; fall back to index only for static presentation lists with no stable field.",
  "Use the injected kit hosts: RichText, Text, Buttons, KitImage and SliceIcon. Do not hand-roll image, button, rich text, icon, or link behavior.",
  "Keep edited and translated copy longer than the design sample inside its responsive column. Allow mobile headings to wrap; do not clip, truncate, or force no-wrap to preserve a desktop single-line reference. Wrap long words and URLs when needed.",
  "Stress Grid and Flex with long headlines, body copy, links, labels, and maximum repeated items at 320–390px. Use min-w-0 on shrinking children and zero-minimum grid tracks (minmax(0,1fr), as in standard grid-cols utilities). Reject fixed widths wider than the column. At 390px, reject scrollWidth > clientWidth; this requires Slice Editor geometry verification, not prompt inspection alone.",
  "Prevent layout shift: images and media need a stable aspect ratio or fill container; cards and grids need predictable dimensions and gaps; hover/focus states must not resize layout.",
  "Avoid heavy client features in public slices: no animation libraries, carousels, particles, theme providers, auth, toasts, Convex React, admin components, or global providers.",
  "Keep accessibility visible: meaningful heading hierarchy, accessible link text, helper-managed alt/caption behavior, focus-visible states for interactive elements, and no icon-only content without a label.",
  "Use CSS transitions only for cheap properties like opacity, transform, or color. Respect motion-reduce when adding motion.",
  "Never generate raw HTML injection, inline style objects, dynamic class names from CMS text, or arbitrary Tailwind values unless explicitly allow-listed by verification.",
] as const

export const SLICE_RENDERER_QUALITY_RULE_BULLETS =
  SLICE_RENDERER_QUALITY_RULES.map((rule) => `- ${rule}`)

export const SLICE_RENDERER_QUALITY_RULES_TEXT =
  SLICE_RENDERER_QUALITY_RULE_BULLETS.join("\n")
