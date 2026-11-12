import { describe, expect, it } from "vitest"
import type { PrePublishChecklist } from "./types"
import { buildPageReadinessSuggestions } from "./readiness"

function checklist(
  partial: Partial<PrePublishChecklist> = {}
): PrePublishChecklist {
  return { canPublish: false, blockers: [], warnings: [], ...partial }
}

describe("buildPageReadinessSuggestions", () => {
  it("maps checklist issues to a small deduplicated set of existing actions", () => {
    const suggestions = buildPageReadinessSuggestions(
      checklist({
        blockers: [
          {
            code: "missing_default_locale_title",
            severity: "blocker",
            message: "Add a title.",
            locales: ["en"],
          },
          {
            code: "broken_internal_link",
            severity: "blocker",
            message: "Replace the missing page.",
            locales: ["fr"],
          },
        ],
        warnings: [
          {
            code: "missing_seo_title",
            severity: "warning",
            message: "Add an SEO title.",
            locales: ["en"],
          },
          {
            code: "missing_seo_description",
            severity: "warning",
            message: "Add an SEO description.",
          },
          {
            code: "missing_enabled_locale_translation",
            severity: "warning",
            message: "Add French content.",
            locales: ["fr"],
          },
        ],
      }),
      { canGenerateMeta: true }
    )

    expect(suggestions).toEqual([
      { id: "focus-title", label: "Add title", locale: "en" },
      { id: "open-content", label: "Review content", locale: "fr" },
      { id: "generate-meta", label: "Generate SEO suggestion", locale: "en" },
      { id: "review-locale", label: "Review FR content", locale: "fr" },
    ])
  })

  it("opens SEO directly when metadata generation is unavailable", () => {
    const suggestions = buildPageReadinessSuggestions(
      checklist({
        warnings: [
          {
            code: "missing_seo_title",
            severity: "warning",
            message: "Add an SEO title.",
            locales: ["en"],
          },
        ],
      }),
      { canGenerateMeta: false }
    )

    expect(suggestions).toEqual([
      { id: "open-seo", label: "Review SEO", locale: "en" },
    ])
  })

  it("offers the slice picker when the page has no content sections", () => {
    const suggestions = buildPageReadinessSuggestions(
      checklist({
        warnings: [
          {
            code: "missing_default_locale_content",
            severity: "warning",
            message: "Add content.",
            locales: ["en"],
          },
        ],
      }),
      { canGenerateMeta: false }
    )

    expect(suggestions).toEqual([
      { id: "add-content", label: "Add content", locale: "en" },
    ])
  })
})
