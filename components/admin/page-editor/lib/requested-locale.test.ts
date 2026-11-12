import { describe, expect, test } from "vitest"
import { resolveRequestedEditorLocale } from "./requested-locale"

describe("resolveRequestedEditorLocale", () => {
  test.each([
    { name: "enabled", raw: "fr", expected: "fr" },
    { name: "first array value", raw: ["fr", "en"], expected: "fr" },
    { name: "invalid", raw: "nonsense", expected: undefined },
    { name: "disabled", raw: "es", expected: undefined },
    { name: "absent", raw: undefined, expected: undefined },
    { name: "empty array", raw: [], expected: undefined },
    { name: "empty string", raw: "", expected: undefined },
    { name: "first invalid, later valid", raw: ["es", "fr"], expected: undefined },
    { name: "case mismatch", raw: "FR", expected: undefined },
  ])("$name", ({ raw, expected }) => {
    expect(resolveRequestedEditorLocale(raw, ["en", "fr"])).toBe(expected)
  })
  test("no enabled locales ignores the request", () => {
    expect(resolveRequestedEditorLocale("fr", [])).toBeUndefined()
  })
})
