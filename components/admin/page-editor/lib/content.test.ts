import { describe, it, expect } from "vitest"
import {
  getTitle,
  hasAnyContent,
  slugify,
  summarizeLocaleContent,
} from "./content"
import type { Page, Slice } from "./types"

function slice(partial: Partial<Slice>): Slice {
  return { id: "s", type: "test-block", ...partial } as unknown as Slice
}

describe("slugify", () => {
  it("folds accented letters to their ASCII base rather than dropping them", () => {
    // Friction G regression: `résultats` must become `resultats`, not `rsultats`.
    expect(slugify("Résultats")).toBe("resultats")
    expect(slugify("Château déjà vu")).toBe("chateau-deja-vu")
  })

  it("lowercases, collapses whitespace/underscores to single dashes", () => {
    expect(slugify("Hello   World")).toBe("hello-world")
    expect(slugify("foo_bar baz")).toBe("foo-bar-baz")
  })

  it("strips non-word punctuation and trims leading/trailing dashes", () => {
    expect(slugify("  !!Hello, World!!  ")).toBe("hello-world")
    expect(slugify("---edge---")).toBe("edge")
  })

  it("keeps every ASCII and Latin-accented output exactly as before the fallback", () => {
    expect(slugify("Hello World")).toBe("hello-world")
    expect(slugify("Résultats 2026")).toBe("resultats-2026")
    expect(slugify("a_b c")).toBe("a-b-c")
    expect(slugify("  --x--  ")).toBe("x")
    expect(slugify("Ça va?")).toBe("ca-va")
    expect(slugify("Иван 2")).toBe("2")
  })

  it("returns an empty string for a blank title", () => {
    expect(slugify("")).toBe("")
    expect(slugify("   ")).toBe("")
  })

  it("gives a title with no ASCII letters a stable page-<hash> address", () => {
    expect(slugify("Иван")).toBe("page-114d4170")
    expect(slugify("東京")).toBe("page-06271ed0")
    expect(slugify("서울")).toBe("page-f1ca7419")
    expect(slugify("नमस्ते")).toBe("page-a4718a3d")
    // Punctuation-only titles used to yield an address nobody could save.
    expect(slugify("!!!")).toBe("page-2d53a722")
  })
})

describe("getTitle", () => {
  it("reads the title for the requested locale", () => {
    const page = { content: { en: { title: "Hi" }, fr: {} } } as unknown as Page
    expect(getTitle(page, "en")).toBe("Hi")
  })

  it("falls back to an empty string when absent", () => {
    const page = { content: {} } as unknown as Page
    expect(getTitle(page, "en")).toBe("")
  })
})

describe("hasAnyContent", () => {
  it("is true when there is a non-empty title", () => {
    expect(hasAnyContent([], "Title")).toBe(true)
  })

  it("is true when at least one slice is enabled", () => {
    expect(hasAnyContent([slice({ enabled: true })], "  ")).toBe(true)
  })

  it("ignores disabled slices", () => {
    expect(hasAnyContent([slice({ enabled: false })], "")).toBe(false)
  })

  it("treats slices without an explicit `enabled` flag as enabled", () => {
    expect(hasAnyContent([slice({})], "")).toBe(true)
  })
})

describe("summarizeLocaleContent", () => {
  it("flags any content across title/meta/slices", () => {
    expect(summarizeLocaleContent({ metaTitle: "x" })).toEqual({
      hasAny: true,
      hasTranslatable: true,
    })
  })

  it("marks title, metadata, and slices as translatable", () => {
    expect(summarizeLocaleContent({ title: "T" }).hasTranslatable).toBe(true)
    expect(
      summarizeLocaleContent({ slices: [slice({})] }).hasTranslatable
    ).toBe(true)
    expect(
      summarizeLocaleContent({ metaDescription: "d" }).hasTranslatable
    ).toBe(true)
  })

  it("reports nothing for empty content", () => {
    expect(summarizeLocaleContent({})).toEqual({
      hasAny: false,
      hasTranslatable: false,
    })
  })
})
