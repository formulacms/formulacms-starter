import { ConvexError } from "convex/values"
import { describe, expect, test } from "vitest"
import { helpErrorKind } from "./help-errors"

describe("helpErrorKind", () => {
  test.each([
    ["PROVIDER_UNAVAILABLE", "unreachable"],
    ["TIMEOUT", "unreachable"],
    ["RATE_LIMITED", "busy"],
    ["QUOTA_EXHAUSTED", "busy"],
    ["AUTH_REQUIRED", "refused"],
    ["CONFIG_MISSING", "missing"],
    ["AI_OFF", "missing"],
    ["INVALID_OUTPUT", "other"],
    ["CANCELLED", "other"],
    ["INPUT_TOO_LARGE", "other"],
    ["toString", "other"],
  ])("category %s is %s", (category, kind) => {
    expect(
      helpErrorKind(new ConvexError({ category, message: "secret detail" }))
    ).toBe(kind)
  })

  test("the rate limiter's own refusal is busy", () => {
    expect(
      helpErrorKind(
        new ConvexError({ kind: "RateLimited", name: "aiCallPerUser", retryAfter: 1000 })
      )
    ).toBe("busy")
  })

  test.each([
    ["string data", new ConvexError("Question too long.")],
    ["null data", new ConvexError(null as never)],
    ["object without category", new ConvexError({ code: "X" })],
    ["non-string category", new ConvexError({ category: 7 })],
    ["plain error", new Error("PROVIDER_UNAVAILABLE")],
    ["thrown string", "TIMEOUT"],
    ["undefined", undefined],
  ])("%s is other", (_label, error) => {
    expect(helpErrorKind(error)).toBe("other")
  })
})
