// Shared prompt-block builder for source markup (HTML or JSX/TSX) passed into
// the slice-authoring agents (ADR-0016). Both authoring paths use it so they
// cannot drift:
//   - the CLI (scripts/generate-slice-from-snapshot.ts), which reads --html/--tsx
//   - the in-admin "From code" tab → convex/agents/sliceAuthor.ts actions
//
// Markup is the STRUCTURAL SOURCE OF TRUTH (above any screenshot): the author
// agent derives the field set from repeated DOM structures, and the renderer
// agent translates the source's raw Tailwind classes into design-system tokens.
// This module is pure string assembly — no Convex or Node runtime imports — so
// it is importable from both the Convex bundle and a plain `tsx` script. The
// one import, `type-scale.ts`, is zero-dependency pure TS and holds to the same
// rule; it is imported rather than re-typed because a second copy of that
// mapping is exactly what drifted here (A1).

import { describeTypeScaleMappings } from "../../../lib/slices/authoring/type-scale"

export type MarkupLang = "html" | "tsx"

/** Upper bound on a single markup payload threaded through a Convex action arg.
 *  Generous enough for a full section component, small enough to stay well under
 *  Convex argument limits and inline-context budgets. */
export const MAX_MARKUP_CHARS = 80_000

const HTML_BLOCK = (html: string) =>
  `\n\n## Source markup (HTML) — STRUCTURAL SOURCE OF TRUTH\n\nThe design's real markup is below. Treat it as authoritative for STRUCTURE and RESPONSIVE INTENT, above the screenshots:\n- Derive the field set from its repeating structures — a \`<dl>\`/\`<ul>\`/\`<ol>\` (or any repeated sibling block) of rows becomes a \`list\` of a \`group\`, one field per distinct child per row; a single labelled region becomes a primary field.\n- TRANSLATE its Tailwind classes into the site design-system tokens and standard utilities — never copy raw utilities. Map color (e.g. \`text-indigo-400\`→\`text-brand\`, dark \`bg-gray-900\`→a \`bg-surface\` dark role), body type (\`text-lg\`→\`text-lead\`), spacing (\`py-24 sm:py-32\`→\`py-section\`, \`px-6\`→\`px-gutter\`), and containers (\`max-w-7xl\`→\`max-w-wide\`, \`max-w-2xl\`→\`max-w-content\`). Heading type scale: ${describeTypeScaleMappings()}. Do not carry over arbitrary/computed values such as \`w-[57rem]\`, \`tracking-[0.22em]\`, \`leading-[0.9]\`, \`bg-[#...]\`, \`text-white\`, \`text-black\`, or \`ring-white/10\`.\n- Preserve the breakpoints the markup already encodes (its \`sm:\`/\`md:\`/\`lg:\` reflow), authored mobile-first.\nThe screenshot(s), when attached, are the visual cross-check.\n\n\`\`\`html\n${html}\n\`\`\`\n`

const TSX_BLOCK = (tsx: string) =>
  `\n\n## Source markup (JSX/TSX) — STRUCTURAL SOURCE OF TRUTH\n\nThe design's real React/JSX is below. Apply the same rules as for source HTML: derive fields from its repeating structures and TRANSLATE its className utilities into design-system tokens and standard utilities, preserving its responsive breakpoints. Do not copy arbitrary/computed values such as \`w-[...]\`, \`tracking-[...]\`, \`leading-[...]\`, or \`bg-[#...]\`. Ignore JS logic, props, and imports — only its rendered structure and classes matter.\n\n\`\`\`tsx\n${tsx}\n\`\`\`\n`

/** Build the shared markup prompt section. Empty/whitespace-only inputs are
 *  dropped. When both are present (CLI can pass both), HTML precedes TSX. The
 *  TSX block is worded to stand alone so it also reads correctly when only TSX
 *  is provided (the in-admin path passes exactly one). Returns "" when neither
 *  is provided. */
export function buildMarkupBlock(input: {
  html?: string | null
  tsx?: string | null
}): string {
  const html = input.html?.trim()
  const tsx = input.tsx?.trim()
  let block = ""
  if (html) block += HTML_BLOCK(html)
  if (tsx) block += TSX_BLOCK(tsx)
  return block
}

/** Convenience for the single-payload UI path: pick the block by language. */
export function buildMarkupBlockForLang(
  markup: string | null | undefined,
  lang: MarkupLang
): string {
  return lang === "html"
    ? buildMarkupBlock({ html: markup })
    : buildMarkupBlock({ tsx: markup })
}
