import { canonicalizeRendererBody } from "./canonicalize"
import { validateRendererHeadings } from "./renderer-heading-rule"
import type { RendererHeadingFieldAccess } from "./renderer-heading-rule"
import { RENDERER_UNSAFE_RULES } from "./renderer-safety"

interface LintRule {
  re: RegExp
  msg: string
}

const ARBITRARY_VALUE_RE =
  /\b(?:[a-z0-9-]+:)*(?:w|min-w|max-w|h|min-h|max-h|text|leading|tracking|bg|border|ring|fill|stroke|outline|decoration|shadow|inset|left|right|top|bottom|m|mx|my|mt|mr|mb|ml|p|px|py|pt|pr|pb|pl|gap|gap-x|gap-y|translate-x|translate-y|aspect|grid-cols|grid-rows|basis|flex|rounded)-\[[^\]]+\]/g

const ALLOWED_ARBITRARY_VALUE_CLASSES = [
  /^(?:[a-z0-9-]+:)*(?:h|min-h|max-h)-\[var\(--radix-[a-z0-9-]+\)\]$/,
  /^(?:[a-z0-9-]+:)*(?:w|min-w|max-w|h|min-h|max-h)-\[[1-9]\d{0,3}px\]$/,
]

const FIDELITY_RULES: LintRule[] = [
  {
    re: /^\s*["']use client["']/m,
    msg: '`"use client"` directive — public slice renderers must stay server-first; isolate real interactions in a child island',
  },
  {
    re: /\bfrom\s+["'](?:convex\/react|sonner|@\/components\/admin\/[^"']+|@\/components\/providers|@\/components\/theme-provider)["']/,
    msg: "client/admin dependency import — public slice renderers must not pull Convex React, toasts, admin UI, or global providers into visitor routes",
  },
  {
    re: /\bfrom\s+["'](?:framer-motion|motion\/react|gsap|@gsap\/react|animejs|swiper(?:\/react)?|embla-carousel-react|react-slick|three|@react-three\/fiber)["']/,
    msg: "heavy interaction/animation dependency import — public slice renderers must not pull animation, carousel, or 3D libraries into visitor routes by default",
  },
  ...RENDERER_UNSAFE_RULES,
  {
    re: /-\[#[0-9a-fA-F]{3,8}\]/,
    msg: "hardcoded hex color — bind to a color token (bg-surface / text-on-surface / text-brand …)",
  },
  {
    re: /\b(?:bg|text|border|ring|fill|stroke|divide|outline|decoration)-(?:white|black)\b/,
    msg: "raw white/black color — use a surface/on-surface token, or scope the section with the `dark` class so tokens flip",
  },
  {
    re: /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}(?:\/[0-9]+)?\b/,
    msg: "hardcoded Tailwind palette color — translate source colors to semantic tokens",
  },
  {
    re: /\btext-[4-9]xl\b/,
    msg: "raw fixed type size (text-4xl+) — use a fluid type-scale token (text-display / text-title / text-heading)",
  },
  {
    re: /\btext-\[[0-9.]+(?:px|rem|em)\]/,
    msg: "arbitrary font size — use a type-scale token",
  },
]

const QUALITY_WARNINGS: LintRule[] = [
  {
    re: /\bkey=\{(?:index|i|rowIndex|cellIndex)\}/,
    msg: "index-based list key — prefer a stable field-derived key; use index only for static presentation lists with no stable field",
  },
  {
    re: /<section\b(?![^>]*(?:aria-labelledby|aria-label))/,
    msg: "unlabelled section — when a visible heading exists, label the section with aria-labelledby using a stable id derived from slice.id",
  },
]

function suggestCompliantClass(className: string): string | null {
  const { changes } = canonicalizeRendererBody(className)
  return changes[0]?.to ?? null
}

function lintArbitraryValues(code: string): string[] {
  const leak = [...code.matchAll(ARBITRARY_VALUE_RE)]
    .map((match) => match[0])
    .find(
      (className) =>
        !ALLOWED_ARBITRARY_VALUE_CLASSES.some((allowed) =>
          allowed.test(className)
        )
    )
  if (!leak) return []
  const suggestion = suggestCompliantClass(leak)
  return [
    `renderer style leak: arbitrary Tailwind value — use semantic tokens or standard utilities; only required runtime sizing is allow-listed (found "${leak}")` +
      (suggestion ? `; write "${suggestion}" instead` : ""),
  ]
}

export type RendererSourceLintResult = {
  failures: string[]
  warnings: string[]
}

export function lintRendererSourceTextWithHeadingResolver(
  source: string,
  isInlineRichTextField?: (access: RendererHeadingFieldAccess) => boolean,
  includeFidelityRules = true
): RendererSourceLintResult {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
  const scan = (rules: LintRule[], label: string) =>
    rules.flatMap((rule) => {
      const match = code.match(rule.re)
      return match ? [`${label}: ${rule.msg} (found "${match[0]}")`] : []
    })
  const contentModelFailures = validateRendererHeadings(
    code,
    isInlineRichTextField
  ).map((failure) => `renderer content-model leak: ${failure}`)

  if (!includeFidelityRules) {
    return { failures: contentModelFailures, warnings: [] }
  }

  return {
    failures: [
      ...scan(FIDELITY_RULES, "renderer style leak"),
      ...lintArbitraryValues(code),
      ...contentModelFailures,
    ],
    warnings: scan(QUALITY_WARNINGS, "renderer quality note"),
  }
}

export function lintRendererSourceText(
  source: string
): RendererSourceLintResult {
  return lintRendererSourceTextWithHeadingResolver(source)
}
