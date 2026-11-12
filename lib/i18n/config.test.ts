import { describe, expect, test } from "vitest"
import {
  FALLBACK_LOCALE,
  LOCALE_DEFINITIONS,
  SUPPORTED_LOCALES,
  getLocaleDirection,
  getLocaleDisplayName,
  getLocaleLabel,
} from "./config"

const EXPECTED_LOCALES = [
  "en",
  "fr",
  "es",
  "it",
  "pt",
  "pt-br",
  "nl",
  "sv",
  "pl",
  "ru",
  "tr",
  "hi",
  "zh",
  "ja",
  "ko",
]

describe("code-owned locale metadata", () => {
  test("defines all 15 known locale identities with an explicit LTR direction", () => {
    expect(LOCALE_DEFINITIONS).toEqual(
      EXPECTED_LOCALES.map((code) => ({ code, direction: "ltr" }))
    )
    expect(SUPPORTED_LOCALES).toEqual(EXPECTED_LOCALES)
  })

  test.each(EXPECTED_LOCALES)("resolves %s from the metadata", (locale) => {
    expect(getLocaleDirection(locale)).toBe("ltr")
  })

  test("uses the fallback locale direction for an unknown compatibility value", () => {
    expect(getLocaleDirection("unsupported-saved-value")).toBe(
      getLocaleDirection(FALLBACK_LOCALE)
    )
  })
})

describe("locale display names", () => {
  test("the display name is the endonym with its first letter capitalised; the label stays raw", () => {
    expect(getLocaleLabel("fr")).toBe("français")
    expect(getLocaleDisplayName("fr")).toBe("Français")
    expect(getLocaleDisplayName("es")).toBe("Español")
    expect(getLocaleDisplayName("en")).toBe("English")
  })

  test("every supported language gets a capitalised name; an unknown code is returned as is", () => {
    for (const code of SUPPORTED_LOCALES) {
      const name = getLocaleDisplayName(code)
      expect(name.charAt(0)).toBe(name.charAt(0).toLocaleUpperCase(code))
      expect(name.slice(1)).toBe(getLocaleLabel(code).slice(1))
    }
    expect(getLocaleDisplayName("not a code")).toBe("not a code")
  })
})
