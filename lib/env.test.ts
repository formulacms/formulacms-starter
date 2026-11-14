import { describe, expect, test } from "vitest"
import { getNextAuthEnv, validateNextRuntimeEnv } from "./env"

const validEnv = {
  NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
}

describe("Next runtime env validation", () => {
  test("accepts the required runtime values", () => {
    expect(() => validateNextRuntimeEnv(validEnv)).not.toThrow()
    expect(getNextAuthEnv(validEnv)).toEqual({
      convexUrl: "https://example.convex.cloud",
    })
  })

  test("needs no auth secret in the Next.js app (ADR-0056)", () => {
    expect(() =>
      validateNextRuntimeEnv({ NEXT_PUBLIC_CONVEX_URL: "cloud-value" })
    ).not.toThrow()
  })

  const invalidValues = [
    { label: "undefined", value: undefined },
    { label: "empty", value: "" },
    { label: "whitespace-only", value: " \t\n " },
    { label: "replace-with placeholder", value: "fixture-replace-with-value" },
    {
      label: "your-deployment placeholder",
      value: "https://your-deployment.convex.cloud",
    },
  ] as const

  test.each(invalidValues)(
    "rejects NEXT_PUBLIC_CONVEX_URL when $label",
    ({ value }) => {
      const message =
        "Missing required environment variable NEXT_PUBLIC_CONVEX_URL. On your computer, run pnpm dev in a terminal and answer Convex's question; Convex writes it to .env.local. On a hosted site, set NEXT_PUBLIC_CONVEX_URL in your host's environment."
      expect(() =>
        validateNextRuntimeEnv({ NEXT_PUBLIC_CONVEX_URL: value })
      ).toThrow(message)
      expect(() => getNextAuthEnv({ NEXT_PUBLIC_CONVEX_URL: value })).toThrow(
        message
      )
    }
  )

  test("auth returns the trimmed URL", () => {
    expect(
      getNextAuthEnv({ NEXT_PUBLIC_CONVEX_URL: " \tcloud-value\n " })
    ).toEqual({ convexUrl: "cloud-value" })
  })
})
