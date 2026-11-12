import { describe, expect, test } from "vitest"
import {
  expectedLanguageLinks,
  expectedStarterAppLocaleContract,
  inferLocaleContract,
  languageLinkFailures,
  localeContractMismatch,
  sameOriginPath,
} from "./starter-app-contract"

describe("expectedStarterAppLocaleContract", () => {
  test("returns null only when no explicit contract is configured", () => {
    expect(expectedStarterAppLocaleContract(undefined, undefined)).toBeNull()
    expect(() => expectedStarterAppLocaleContract("en", undefined)).toThrow(
      "together"
    )
  })

  test("requires the explicit locale list to include the default", () => {
    expect(() => expectedStarterAppLocaleContract("en", "fr")).toThrow(
      "include default locale en"
    )
    expect(expectedStarterAppLocaleContract("en", "en, fr")).toEqual({
      defaultLocale: "en",
      locales: ["en", "fr"],
    })
  })

  test("rejects duplicate locales instead of weakening the contract", () => {
    expect(() => expectedStarterAppLocaleContract("en", "en,en")).toThrow(
      "must not contain duplicates"
    )
  })
})

describe("sameOriginPath", () => {
  test("accepts relative and same-origin absolute public URLs", () => {
    expect(sameOriginPath("/fr/services/", "http://localhost:3000")).toBe(
      "/fr/services"
    )
    expect(
      sameOriginPath(
        "http://localhost:3000/fr/services",
        "http://localhost:3000"
      )
    ).toBe("/fr/services")
  })

  test("rejects metadata and navigation URLs on another origin", () => {
    expect(() =>
      sameOriginPath("https://wrong.example/fr", "http://localhost:3000")
    ).toThrow("expected origin http://localhost:3000")
  })
})

describe("localeContractMismatch", () => {
  test("requires the generated app to expose exactly the intended locales", () => {
    const expected = { defaultLocale: "en", locales: ["en", "fr"] }
    expect(localeContractMismatch(expected, expected)).toBeNull()
    expect(
      localeContractMismatch(expected, {
        defaultLocale: "en",
        locales: ["en"],
      })
    ).toBe("expected enabled locales en,fr, saw en")
    expect(
      localeContractMismatch(expected, {
        defaultLocale: "fr",
        locales: ["en", "fr"],
      })
    ).toBe("expected default locale en, saw fr")
  })
})

// F09 row 23: with one enabled language a public page publishes a canonical
// link only. More than one adds hreflang alternates and x-default.
const singleLanguageHome = { htmlLang: "en", finalPath: "/", alternates: {} }
const english = { defaultLocale: "en", locales: ["en"] }
const englishAndFrench = { defaultLocale: "en", locales: ["en", "fr"] }

describe("expectedLanguageLinks", () => {
  test("expects hreflang alternates only when more than one language is enabled", () => {
    expect(expectedLanguageLinks(english)).toBe("canonical-only")
    expect(expectedLanguageLinks(englishAndFrench)).toBe("hreflang")
  })
})

describe("inferLocaleContract", () => {
  test("infers a single-language site from <html lang> when no alternates are published", () => {
    expect(inferLocaleContract(singleLanguageHome)).toEqual({
      contract: english,
      links: "canonical-only",
      failures: [],
    })
  })

  test("still fails when neither <html lang> nor an alternate names the language", () => {
    expect(
      inferLocaleContract({ htmlLang: "", alternates: {} }).failures
    ).toEqual(["/: cannot infer default locale because <html lang> is empty."])
  })

  test("infers a multilingual site from its hreflang alternates", () => {
    expect(
      inferLocaleContract({
        htmlLang: "en",
        alternates: { fr: "/fr", en: "/", "x-default": "/" },
      })
    ).toEqual({ contract: englishAndFrench, links: "hreflang", failures: [] })
  })

  test("keeps a home published with alternates on the hreflang path", () => {
    // A multilingual home indexable in one language still lists itself and
    // x-default; that is not the single-language shape.
    expect(
      inferLocaleContract({
        htmlLang: "en",
        alternates: { en: "/", "x-default": "/" },
      })
    ).toEqual({ contract: english, links: "hreflang", failures: [] })
  })

  test("requires the default locale among the published alternates", () => {
    expect(
      inferLocaleContract({
        htmlLang: "en",
        alternates: { fr: "/fr", "x-default": "/fr" },
      }).failures
    ).toEqual(["/: hreflang alternates do not include default locale en."])
  })
})

describe("languageLinkFailures on a single-language site", () => {
  test("accepts the canonical-only home under an explicit or inferred contract", () => {
    const inferred = inferLocaleContract(singleLanguageHome)
    expect(
      languageLinkFailures(
        singleLanguageHome,
        "desktop /",
        "en",
        english,
        expectedLanguageLinks(english)
      )
    ).toEqual([])
    expect(
      languageLinkFailures(
        singleLanguageHome,
        "desktop /",
        "en",
        inferred.contract,
        inferred.links
      )
    ).toEqual([])
  })

  test("rejects any hreflang alternate, x-default included", () => {
    expect(
      languageLinkFailures(
        { finalPath: "/", alternates: { en: "/", "x-default": "/" } },
        "desktop /",
        "en",
        english,
        "canonical-only"
      )
    ).toEqual([
      "desktop /: a single-language site publishes a canonical link only, but the page exposes hreflang alternates en, x-default.",
    ])
  })

  test("rejects a lone x-default", () => {
    expect(
      languageLinkFailures(
        { finalPath: "/", alternates: { "x-default": "/" } },
        "mobile /",
        "en",
        english,
        "canonical-only"
      )
    ).toEqual([
      "mobile /: a single-language site publishes a canonical link only, but the page exposes hreflang alternates x-default.",
    ])
  })
})

describe("languageLinkFailures on a multilingual site", () => {
  test("accepts every enabled language plus a matching x-default", () => {
    expect(
      languageLinkFailures(
        {
          finalPath: "/fr",
          alternates: { en: "/", fr: "/fr", "x-default": "/" },
        },
        "desktop /fr",
        "fr",
        englishAndFrench,
        "hreflang"
      )
    ).toEqual([])
  })

  test("still fails an explicit multilingual contract whose page has no alternates", () => {
    expect(
      languageLinkFailures(
        singleLanguageHome,
        "desktop /",
        "en",
        englishAndFrench,
        expectedLanguageLinks(englishAndFrench)
      )
    ).toEqual([
      "desktop /: missing hreflang alternate for en.",
      "desktop /: missing hreflang alternate for fr.",
      "desktop /: missing x-default hreflang alternate.",
    ])
    expect(
      localeContractMismatch(
        englishAndFrench,
        inferLocaleContract(singleLanguageHome).contract
      )
    ).toBe("expected enabled locales en,fr, saw en")
  })

  test("requires x-default to match the default-language URL", () => {
    expect(
      languageLinkFailures(
        {
          finalPath: "/",
          alternates: { en: "/", fr: "/fr", "x-default": "/fr" },
        },
        "desktop /",
        "en",
        englishAndFrench,
        "hreflang"
      )
    ).toEqual(["desktop /: x-default /fr does not match default-locale URL /."])
  })

  test("requires the page's own alternate to point at the page", () => {
    expect(
      languageLinkFailures(
        {
          finalPath: "/fr",
          alternates: { en: "/", fr: "/fr/autre", "x-default": "/" },
        },
        "desktop /fr",
        "fr",
        englishAndFrench,
        "hreflang"
      )
    ).toEqual(["desktop /fr: hreflang fr points to /fr/autre, expected /fr."])
  })
})
