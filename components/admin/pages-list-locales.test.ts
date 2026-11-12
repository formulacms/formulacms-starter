import { describe, expect, it } from "vitest"
import { ConvexError } from "convex/values"
import {
  firstTitle,
  openingLanguage,
  pageMatchesStatus,
  rowAddress,
  rowStatus,
  siteLocaleOrder,
} from "./pages-list-locales"
import { hasErrorCode, rowErrorKind } from "./pages-list-errors"

const locale = (
  l: string,
  state: "published" | "draft" | "not_translated",
  extra: Record<string, unknown> = {}
) =>
  ({
    locale: l,
    state,
    draftGeneration: 1,
    publicGeneration: 1,
    releaseGeneration: 1,
    ...extra,
  }) as never

describe("per-language list logic", () => {
  it("orders site languages with the default first", () => {
    expect(siteLocaleOrder(["en", "fr", "de"], "fr")).toEqual([
      "fr",
      "en",
      "de",
    ])
    expect(siteLocaleOrder(["en", "fr"], undefined)).toEqual(["en", "fr"])
  })

  it("opens on the admin language when the site has it, else the default", () => {
    expect(openingLanguage("fr", ["en", "fr"], "en")).toBe("fr")
    expect(openingLanguage("de", ["en", "fr"], "en")).toBe("en")
  })

  it("no entry and a not_translated entry are both Not translated", () => {
    const page = {
      locales: [locale("en", "draft"), locale("fr", "not_translated")],
    }
    expect(rowStatus(page, "en")).toBe("draft")
    expect(rowStatus(page, "fr")).toBe("notTranslated")
    expect(rowStatus(page, "de")).toBe("notTranslated")
    expect(rowStatus({}, "en")).toBe("notTranslated")
  })

  it("a Not translated row borrows the first translated site language's title", () => {
    const page = {
      locales: [
        locale("en", "not_translated", { title: "ignored" }),
        locale("fr", "draft", { title: "Bonjour" }),
        locale("de", "draft", { title: "Hallo" }),
      ],
    }
    expect(firstTitle(page, ["en", "fr", "de"])).toEqual({
      title: "Bonjour",
      locale: "fr",
    })
    expect(firstTitle({ locales: [] }, ["en"])).toBeNull()
    expect(
      firstTitle({ locales: [], localizedTitles: { de: "Nur Titel" } }, [
        "en",
        "de",
      ])
    ).toEqual({ title: "Nur Titel", locale: "de" })
  })

  it("addresses follow toPublicPath; absent is a placeholder; null shows nothing", () => {
    const page = {
      locales: [
        locale("en", "published", { path: "/about" }),
        locale("fr", "published", { path: "/a-propos" }),
        locale("de", "draft", { path: null }),
        locale("es", "draft"),
      ],
    }
    expect(rowAddress(page, "en", "en")).toEqual({
      kind: "path",
      value: "/about",
    })
    expect(rowAddress(page, "fr", "en")).toEqual({
      kind: "path",
      value: "/fr/a-propos",
    })
    expect(
      rowAddress(
        { locales: [locale("fr", "published", { path: "/" })] },
        "fr",
        "en"
      )
    ).toEqual({ kind: "path", value: "/fr" })
    expect(rowAddress(page, "de", "en")).toEqual({ kind: "hidden" })
    expect(rowAddress(page, "es", "en")).toEqual({ kind: "none" })
    expect(rowAddress(page, "it", "en")).toEqual({ kind: "none" })
  })

  it("the status filter looks at the languages shown, Not translated included", () => {
    const page = { locales: [locale("en", "published"), locale("fr", "draft")] }
    expect(pageMatchesStatus(page, "notTranslated", ["en", "fr"])).toBe(false)
    expect(pageMatchesStatus(page, "notTranslated", ["en", "fr", "de"])).toBe(
      true
    )
    expect(pageMatchesStatus(page, "draft", ["en"])).toBe(false)
    expect(pageMatchesStatus(page, "draft", ["en", "fr"])).toBe(true)
    expect(pageMatchesStatus(page, "all", [])).toBe(true)
  })
})

describe("row refusal codes", () => {
  it.each([
    ["PAGE_LOCALE_DRAFT_STALE", "stale"],
    ["PAGE_PUBLICATION_LIFECYCLE_STALE", "stale"],
    ["PAGE_LOCALE_PUBLICATION_STALE", "stale"],
    ["PAGE_SHARED_DRAFT_STALE", "stale"],
    ["PUBLICATION_HOME_CONFIGURATION_STALE", "stale"],
    ["PUBLISHED_SNAPSHOT_CUTOVER_STALE", "stale"],
    ["PAGE_ANCESTRY_IN_USE", "ancestryInUse"],
    ["PUBLICATION_HOME_MUST_BE_ROOT", "homeMustBeRoot"],
    ["PAGE_LOCALE_RELEASE_REPLACEMENT_REQUIRED", "releaseReplacement"],
    ["PAGE_HOME_LIFECYCLE_REFUSED", "homeLifecycle"],
    ["LEGACY_PUBLICATION_WRITER_DISABLED", "writerDisabled"],
  ] as const)(
    "recognises %s from a ConvexError or a formatted message",
    (code, kind) => {
      expect(rowErrorKind(new ConvexError(code))).toBe(kind)
      expect(rowErrorKind(new ConvexError({ code }))).toBe(kind)
      expect(
        rowErrorKind(new Error(`[Request ID: x] Server Error Uncaught ${code}`))
      ).toBe(kind)
    }
  )

  it("never maps unknown failures", () => {
    expect(rowErrorKind(new Error("boom"))).toBeNull()
    expect(rowErrorKind("PAGE_ANCESTRY_IN_USE")).toBeNull()
    expect(hasErrorCode(new Error("x"), "PAGE_ANCESTRY_IN_USE")).toBe(false)
  })
})
