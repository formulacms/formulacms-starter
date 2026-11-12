import { describe, expect, test } from "vitest"
import {
  hasReservedLocalePrefix,
  isLocalePrefixPath,
  localePrefixRange,
} from "./localePrefix"

describe("language locale prefixes", () => {
  test.each([
    ["/nl", true],
    ["/nl/contact", true],
    ["/fr", true],
    ["/fr/a/b", true],
    ["/deutsch", false],
    ["/de-offer", false],
    ["/xx/contact", false],
    ["/", false],
  ])("reserves supported first segment for %s", (path, reserved) => {
    expect(hasReservedLocalePrefix(path)).toBe(reserved)
  })

  test("matches only the locale root and descendants within its index range", () => {
    expect(localePrefixRange("de")).toEqual({ start: "/de", end: "/de0" })
    expect(isLocalePrefixPath("/de", "de")).toBe(true)
    expect(isLocalePrefixPath("/de/contact", "de")).toBe(true)
    expect(isLocalePrefixPath("/deutsch", "de")).toBe(false)
    expect(isLocalePrefixPath("/de-offer", "de")).toBe(false)
  })
})
