import { describe, expect, test } from "vitest"
import { selectPublicLocaleContent } from "./public-locale-content"

const content = {
  en: { title: "English" },
  fr: { title: "Français" },
}

describe("selectPublicLocaleContent", () => {
  test("fails closed when public content is unavailable in the requested locale", () => {
    expect(
      selectPublicLocaleContent(
        { en: content.en },
        "fr",
        "en",
        false
      )
    ).toBeNull()
  })

  test("retains default-locale fallback for authenticated preview", () => {
    expect(
      selectPublicLocaleContent(
        { en: content.en },
        "fr",
        "en",
        true
      )
    ).toEqual({ content: content.en, renderLocale: "en", isFallback: true })
  })

  test("selects the sole enabled locale without fallback", () => {
    expect(
      selectPublicLocaleContent(
        { fr: content.fr },
        "fr",
        "fr",
        false
      )
    ).toEqual({ content: content.fr, renderLocale: "fr", isFallback: false })
  })
})
