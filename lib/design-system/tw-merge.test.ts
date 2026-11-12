import { describe, expect, test } from "vitest"
import { mergeTailwindClasses } from "./tw-merge"

const conflicts = [
  ["py-section", "py-16"],
  ["text-display", "text-xl"],
  ["max-w-content", "max-w-4xl"],
  ["gap-stack", "gap-8"],
  ["px-gutter", "px-4"],
] as const

describe("mergeTailwindClasses", () => {
  test.each(conflicts)(
    "resolves %s against %s with last value winning",
    (token, utility) => {
      expect(mergeTailwindClasses(token, utility)).toBe(utility)
      expect(mergeTailwindClasses(utility, token)).toBe(token)
    }
  )

  test("keeps independent utilities and applies the same conflicts inside variants", () => {
    expect(
      mergeTailwindClasses("flex py-section", "sm:py-section sm:py-16")
    ).toBe("flex py-section sm:py-16")
  })
})
