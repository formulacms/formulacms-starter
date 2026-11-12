import { describe, expect, test } from "vitest"
import { resolveNavigationPathname } from "./presentation-locale"

describe("public navigation pathname", () => {
  test.each([
    ["/en/services", "/services"],
    ["/services", "/services"],
    ["/en/services/consulting/", "/services/consulting/"],
    ["/en", "/"],
    ["/en/", "/"],
    ["/", "/"],
    ["/english/services", "/english/services"],
    ["/fr/services", "/fr/services"],
  ])("%s uses public path %s", (route, expected) => {
    expect(resolveNavigationPathname(route, {
      locale: "en", defaultLocale: "en",
    })).toBe(expected)
  })

  test("uses the configured default language rather than a fixed English prefix", () => {
    expect(resolveNavigationPathname("/fr/services", {
      locale: "fr", defaultLocale: "fr",
    })).toBe("/services")
    expect(resolveNavigationPathname("/fr/services", {
      locale: "fr", defaultLocale: "en",
    })).toBe("/fr/services")
  })

  test.each(["/en/services", "/fr/services", "", null])(
    "preview override %s wins without route normalization",
    (publicPath) => {
      expect(resolveNavigationPathname("/admin/pages/page/live-frame/en", {
        locale: "en", defaultLocale: "en", publicPath,
      })).toBe(publicPath ?? "")
    }
  )
})
