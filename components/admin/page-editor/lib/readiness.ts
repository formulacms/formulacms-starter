import type { PrePublishChecklist } from "./types"

export type PageReadinessSuggestion =
  | { id: "focus-title"; label: string; locale?: string }
  | { id: "add-content"; label: string; locale?: string }
  | { id: "open-content"; label: string; locale?: string }
  | { id: "open-seo"; label: string; locale?: string }
  | { id: "generate-meta"; label: string; locale?: string }
  | { id: "review-locale"; label: string; locale: string }

const CONTENT_ISSUE_CODES = new Set([
  "missing_required_slice_field",
  "missing_required_field",
  "missing_image_alt_text",
  "broken_internal_link",
  "archived_relation_target",
])

export function buildPageReadinessSuggestions(
  checklist: PrePublishChecklist,
  { canGenerateMeta }: { canGenerateMeta: boolean }
): PageReadinessSuggestion[] {
  const items = [...checklist.blockers, ...checklist.warnings]
  const codes = new Set(items.map((item) => item.code))
  const suggestions: PageReadinessSuggestion[] = []
  const firstLocaleFor = (matchingCodes: ReadonlySet<string>) =>
    items.find((item) => matchingCodes.has(item.code))?.locales?.[0]

  if (codes.has("missing_default_locale_title")) {
    suggestions.push({
      id: "focus-title",
      label: "Add title",
      locale: firstLocaleFor(new Set(["missing_default_locale_title"])),
    })
  }

  if (codes.has("missing_default_locale_content")) {
    suggestions.push({
      id: "add-content",
      label: "Add content",
      locale: firstLocaleFor(new Set(["missing_default_locale_content"])),
    })
  }

  if (items.some((item) => CONTENT_ISSUE_CODES.has(item.code))) {
    suggestions.push({
      id: "open-content",
      label: "Review content",
      locale: firstLocaleFor(CONTENT_ISSUE_CODES),
    })
  }

  if (codes.has("missing_seo_title") || codes.has("missing_seo_description")) {
    const locale = firstLocaleFor(
      new Set(["missing_seo_title", "missing_seo_description"])
    )
    suggestions.push(
      canGenerateMeta
        ? { id: "generate-meta", label: "Generate SEO suggestion", locale }
        : { id: "open-seo", label: "Review SEO", locale }
    )
  }

  const missingLocales = new Set<string>()
  for (const item of items) {
    if (item.code !== "missing_enabled_locale_translation") continue
    for (const locale of item.locales ?? []) missingLocales.add(locale)
  }
  for (const locale of [...missingLocales].sort()) {
    suggestions.push({
      id: "review-locale",
      label: `Review ${locale.toUpperCase()} content`,
      locale,
    })
  }

  return suggestions
}
