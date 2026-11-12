import { describe, expect, it, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { createTranslator } from "next-intl"
import { getContentDefault, type ContentDefaultKey } from "./content-defaults"
import { formatMediaBytes, formatScheduleTime } from "./admin-format"

const keys: ContentDefaultKey[] = [
  "button",
  "menuItem",
  "recentPosts",
  "seeAll",
  "importedPage",
  "recoveredDraft",
]
for (const [locale, messages] of [
  ["en", en],
  ["fr", fr],
] as const) {
  describe(`content defaults and admin format ${locale}`, () => {
    it.each(keys)("uses target content locale for %s", (key) => {
      expect(getContentDefault(locale, key)).toBe(messages.contentDefaults[key])
      expect(getContentDefault(locale, key)).not.toBe(
        (locale === "fr" ? en : fr).contentDefaults[key]
      )
    })
    const t = createTranslator({
      locale,
      messages,
      namespace: "inventory.mediaLibrary",
    })
    it.each([0, 1023, 1024, 1536, 1048576])(
      "formats byte threshold %i in admin locale",
      (bytes) => {
        const key =
          bytes < 1024 ? "bytes" : bytes < 1048576 ? "kilobytes" : "megabytes"
        const value =
          bytes < 1024
            ? bytes
            : bytes < 1048576
              ? bytes / 1024
              : bytes / 1048576
        const digits = bytes < 1024 ? 0 : 1
        expect(formatMediaBytes(bytes, locale, t)).toBe(
          t(key, {
            value: new Intl.NumberFormat(locale, {
              minimumFractionDigits: digits,
              maximumFractionDigits: digits,
            }).format(value),
          })
        )
      }
    )
    it("formats scheduled date in the browser zone with no zone suffix", () => {
      vi.stubEnv("TZ", "America/Los_Angeles")
      try {
        const at = Date.UTC(2026, 8, 30, 18, 5)
        const expected = new Date(at).toLocaleString(locale, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/Los_Angeles",
        })
        const format = vi.spyOn(Date.prototype, "toLocaleString")
        expect(formatScheduleTime(locale, at)).toBe(expected)
        expect(format).toHaveBeenLastCalledWith(locale, {
          month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        })
        format.mockRestore()
      } finally {
        vi.unstubAllEnvs()
      }
    })
    it("omits absent schedule times", () => {
      expect(formatScheduleTime(locale)).toBe("")
    })
  })
}
it("uses English fallback only for unsupported content locales", () => {
  expect(getContentDefault("de", "importedPage")).toBe(
    en.contentDefaults.importedPage
  )
})
