import { describe, expect, test } from "vitest"
import { translatedDraft } from "../../cms/aiJobs"
import { assembleTranslation, enumerateSegments } from "./translationWorkflow"

// ADR-0037 amendment (2026-11-17): AI translation covers the social title and
// description and the card excerpt. Structured data is never translated.

const source = {
  title: "Hello",
  ogTitle: "Social hello",
  ogDescription: "Social description",
  cardExcerpt: "Card excerpt",
  slices: [],
  translatables: [],
}

describe("AI translation of the per-language text", () => {
  test("the social text and the card excerpt become translation segments", async () => {
    const segments = await enumerateSegments(source)
    expect(segments.map((segment) => segment.address)).toEqual([
      "title",
      "ogTitle",
      "ogDescription",
      "cardExcerpt",
    ])
  })

  test("the translated draft carries the translated text and the robots choices, never structured data", async () => {
    const segments = await enumerateSegments(source)
    const translated = await assembleTranslation(
      source,
      segments.map((segment) => ({
        address: segment.address,
        text: `fr:${segment.text}`,
      }))
    )
    const draft = translatedDraft(
      {
        pageType: "landing-page",
        localized: { title: "Hello" },
        seo: { noIndex: true },
        slices: [],
      } as never,
      translated as never
    ) as unknown as {
      seo?: Record<string, unknown>
      cardExcerpt?: string
    }
    expect(draft.seo).toEqual({
      noIndex: true,
      ogTitle: "fr:Social hello",
      ogDescription: "fr:Social description",
    })
    expect(draft.cardExcerpt).toBe("fr:Card excerpt")
    expect(draft.seo).not.toHaveProperty("structuredData")
  })

  test("a page without them translates as before", async () => {
    const segments = await enumerateSegments({
      title: "Hello",
      slices: [],
      translatables: [],
    })
    expect(segments.map((segment) => segment.address)).toEqual(["title"])
  })
})
