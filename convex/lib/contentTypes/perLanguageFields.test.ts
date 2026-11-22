import { describe, expect, test } from "vitest"
import {
  PER_LANGUAGE_DRAFT_KEYS,
  PER_LANGUAGE_SEO_KEYS,
  applyPerLanguageInput,
  draftInputFromContent,
  normalizeSnapshotPayload,
  perLanguageDraftFields,
  planDraftBackfill,
  stripMovedSharedValues,
} from "./perLanguageFields"
import { contentTypeDefs } from "./index"
import { contentDraftInputValidator } from "./inputShapes"
import { perLanguageDraftValidatorFields } from "./perLanguageFields"

// ADR-0037 amendment (2026-11-17): the rule that resolves the old shared values.

function payload(
  locale: string,
  shared: {
    seo?: Record<string, unknown>
    cardExcerpt?: string
    category?: string
  },
  content: Record<string, unknown> = { title: "T" }
) {
  return {
    locale,
    localized: { slug: "s", content },
    shared: {
      system: {
        ...(shared.seo ? { seo: shared.seo } : {}),
        ...(shared.cardExcerpt ? { cardExcerpt: shared.cardExcerpt } : {}),
      },
      descriptor: shared.category ? { category: shared.category } : {},
    },
  }
}

describe("normalizeSnapshotPayload", () => {
  const old = {
    seo: {
      noIndex: true,
      noFollow: true,
      ogTitle: "Title",
      keywords: ["k"],
      metaDescription: "Meta",
      ogImage: "/i.png",
    },
    cardExcerpt: "Excerpt",
    category: "News",
  }

  test("the legacy language gets the text and the robots choices", () => {
    const next = normalizeSnapshotPayload(payload("en", old), "en")
    expect(next.localized.content).toMatchObject({
      seo: { noIndex: true, noFollow: true, ogTitle: "Title", keywords: ["k"] },
      cardExcerpt: "Excerpt",
      category: "News",
      metaDescription: "Meta",
    })
    expect(next.shared.system.seo).toEqual({ ogImage: "/i.png" })
    expect(next.shared.system).not.toHaveProperty("cardExcerpt")
    expect(next.shared.descriptor).not.toHaveProperty("category")
  })

  test("another language gets the robots choices and none of the text", () => {
    const next = normalizeSnapshotPayload(payload("fr", old), "en")
    expect(next.localized.content.seo).toEqual({
      noIndex: true,
      noFollow: true,
    })
    expect(next.localized.content).not.toHaveProperty("cardExcerpt")
    expect(next.localized.content).not.toHaveProperty("category")
    expect(next.localized.content).not.toHaveProperty("metaDescription")
  })

  test("a language's own value wins over the shared one", () => {
    const next = normalizeSnapshotPayload(
      payload("en", old, {
        title: "T",
        seo: { ogTitle: "Own", noIndex: false },
        cardExcerpt: "Own excerpt",
      }),
      "en"
    )
    expect(next.localized.content).toMatchObject({
      seo: { ogTitle: "Own", noIndex: false },
      cardExcerpt: "Own excerpt",
    })
  })

  test("a snapshot in the new shape passes through unchanged", () => {
    const fresh = payload(
      "fr",
      { seo: { ogImage: "/i.png" } },
      {
        title: "T",
        seo: { noIndex: true },
      }
    )
    expect(normalizeSnapshotPayload(fresh, "en")).toBe(fresh)
  })

  test("stripping the moved values leaves only the shared image", () => {
    const stripped = stripMovedSharedValues(payload("en", old).shared)
    expect(stripped.system).toEqual({ seo: { ogImage: "/i.png" } })
    expect(stripped.descriptor).toEqual({})
  })
})

describe("planDraftBackfill", () => {
  const base = {
    sharedSeo: { noIndex: true, ogTitle: "Title", metaTitle: "Meta title" },
    sharedCardExcerpt: "Excerpt",
    sharedCategory: "News",
    hasCategoryField: true,
  }

  test("fills the legacy language only where empty", () => {
    const plan = planDraftBackfill({
      ...base,
      locale: "en",
      legacyLocale: "en",
      content: { title: "T", metaTitle: "Own meta" },
    })
    expect(plan).toMatchObject({
      metaTitle: "Own meta",
      cardExcerpt: "Excerpt",
      category: "News",
      seo: { noIndex: true, ogTitle: "Title" },
    })
  })

  test("another language gets only the robots choices", () => {
    expect(
      planDraftBackfill({
        ...base,
        locale: "fr",
        legacyLocale: "en",
        content: { title: "T" },
      })
    ).toEqual({ title: "T", seo: { noIndex: true } })
  })

  test("nothing to change returns null, so a re-run writes nothing", () => {
    const first = planDraftBackfill({
      ...base,
      locale: "en",
      legacyLocale: "en",
      content: { title: "T" },
    })!
    expect(
      planDraftBackfill({
        ...base,
        locale: "en",
        legacyLocale: "en",
        content: first,
      })
    ).toBeNull()
  })
})

describe("applyPerLanguageInput", () => {
  test("an absent key keeps the stored value; a present key sets or clears it", () => {
    const baseline = { seo: { ogTitle: "Stored" }, cardExcerpt: "Stored" }
    expect(applyPerLanguageInput({ title: "T" }, {}, baseline)).toEqual({
      title: "T",
      seo: { ogTitle: "Stored" },
      cardExcerpt: "Stored",
    })
    expect(
      applyPerLanguageInput(
        { title: "T" },
        { seo: { ogTitle: "New" }, cardExcerpt: "New" },
        baseline
      )
    ).toEqual({ title: "T", seo: { ogTitle: "New" }, cardExcerpt: "New" })
    expect(
      applyPerLanguageInput(
        { title: "T" },
        { seo: {}, cardExcerpt: "" },
        baseline
      )
    ).toEqual({ title: "T" })
  })

  test("only the per-language keys of a seo block are kept", () => {
    expect(
      applyPerLanguageInput(
        { title: "T" },
        { seo: { ogTitle: "A", ogImage: "/shared.png", canonicalUrl: "x" } },
        undefined
      )
    ).toEqual({ title: "T", seo: { ogTitle: "A" } })
  })
})

// Round 1 guard: ONE common per-language field definition and ONE adapter from
// stored content to the typed draft input. Every field of the definition must
// survive the adapter for every content type; which fields AI translates is a
// separate list (see the AI Accept test in convex/aiJobs.test.ts).
describe("draftInputFromContent: every common per-language field survives", () => {
  const seoValues: Record<(typeof PER_LANGUAGE_SEO_KEYS)[number], unknown> = {
    ogTitle: "Social title",
    ogDescription: "Social description",
    noIndex: true,
    noFollow: false,
    structuredData: '{"@type":"Thing"}',
    keywords: ["alpha", "beta"],
    focusKeyword: "alpha",
  }
  const content: Record<string, unknown> = {
    title: "Title",
    metaTitle: "Meta",
    metaDescription: "Meta description",
    category: "News",
    seo: seoValues,
    cardExcerpt: "Excerpt",
    blocks: [{ id: "s1" }],
  }
  const build = (pageType: keyof typeof contentTypeDefs) => {
    const def = contentTypeDefs[pageType]
    return draftInputFromContent({
      pageType,
      localizedKeys: Object.keys(def.localizedFields),
      blockBody: def.capabilities.blockBody,
      content,
    }) as {
      pageType: string
      localized: Record<string, unknown>
      seo?: Record<string, unknown>
      cardExcerpt?: string
      blocks?: unknown[]
    }
  }

  test("the definition lists the seo block and the card excerpt", () => {
    expect([...PER_LANGUAGE_DRAFT_KEYS]).toEqual(["seo", "cardExcerpt"])
  })

  test("every typed draft input arm carries exactly the definition's keys beside localized", () => {
    expect(Object.keys(perLanguageDraftValidatorFields)).toEqual([
      ...PER_LANGUAGE_DRAFT_KEYS,
    ])
    const arms = contentDraftInputValidator.members as unknown as Array<{
      fields: Record<string, unknown>
    }>
    expect(arms).toHaveLength(Object.keys(contentTypeDefs).length)
    for (const arm of arms)
      for (const key of PER_LANGUAGE_DRAFT_KEYS)
        expect(Object.keys(arm.fields)).toContain(key)
  })

  test.each(["landing-page", "page", "post", "author", "testimonial", "job"] as const)(
    "%s: the seo block and card excerpt are sent beside localized, never inside it",
    (pageType) => {
      const draft = build(pageType)
      for (const key of PER_LANGUAGE_SEO_KEYS)
        expect(draft.seo?.[key], `${pageType} seo.${key}`).toEqual(seoValues[key])
      expect(draft.cardExcerpt).toBe("Excerpt")
      for (const key of PER_LANGUAGE_DRAFT_KEYS)
        expect(draft.localized).not.toHaveProperty(key)
      expect(draft.localized).not.toHaveProperty("blocks")
      // Blocks travel only for a type with a block body.
      expect("blocks" in draft).toBe(contentTypeDefs[pageType].capabilities.blockBody)
    }
  )

  test("the category is a declared localized field of the post only", () => {
    for (const pageType of ["landing-page", "page", "post", "author", "testimonial", "job"] as const) {
      expect("category" in build(pageType).localized, pageType).toBe(
        pageType === "post"
      )
    }
  })

  test("an unset field stays unset, so a save keeps the stored value", () => {
    expect(perLanguageDraftFields({ title: "T" })).toEqual({})
    expect(perLanguageDraftFields({ seo: {}, cardExcerpt: "  " })).toEqual({})
    // A robots choice of false is a value, not an unset field.
    expect(perLanguageDraftFields({ seo: { noIndex: false } })).toEqual({
      seo: { noIndex: false },
    })
  })

  test("the AI narrowing is a separate list: robots only, no excerpt", () => {
    expect(
      perLanguageDraftFields(content, {
        seoKeys: ["noIndex", "noFollow"],
        cardExcerpt: false,
      })
    ).toEqual({ seo: { noIndex: true, noFollow: false } })
  })
})
