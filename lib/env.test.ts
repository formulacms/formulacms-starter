import { describe, expect, test } from "vitest"
import { getNextAuthEnv, validateNextRuntimeEnv } from "./env"

const validEnv = {
  NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://example.convex.site",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
}

describe("Next runtime env validation", () => {
  test("accepts the required runtime values", () => {
    expect(() => validateNextRuntimeEnv(validEnv)).not.toThrow()
    expect(getNextAuthEnv(validEnv)).toEqual({
      convexUrl: "https://example.convex.cloud",
      convexSiteUrl: "https://example.convex.site",
    })
  })

  test("rejects missing required values", () => {
    expect(() =>
      validateNextRuntimeEnv({
        ...validEnv,
        NEXT_PUBLIC_CONVEX_URL: "",
      })
    ).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
  })

  test("rejects copied example placeholders", () => {
    expect(() =>
      validateNextRuntimeEnv({
        ...validEnv,
        BETTER_AUTH_SECRET: "replace-with-openssl-rand-hex-32",
      })
    ).toThrow(/BETTER_AUTH_SECRET/)
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
  const invalidCases = [
    "NEXT_PUBLIC_CONVEX_URL",
    "NEXT_PUBLIC_CONVEX_SITE_URL",
    "BETTER_AUTH_SECRET",
  ].flatMap((name) =>
    invalidValues.map(({ label, value }) => ({ name, label, value }))
  )

  test.each(invalidCases)(
    "runtime rejects $name when $label",
    ({ name, value }) => {
      expect(() => validateNextRuntimeEnv({ ...validEnv, [name]: value })).toThrow(
        `Missing required environment variable ${name}.`
      )
    }
  )

  test.each(invalidCases.filter(({ name }) => name !== "BETTER_AUTH_SECRET"))(
    "auth rejects $name when $label",
    ({ name, value }) => {
      expect(() => getNextAuthEnv({ ...validEnv, [name]: value })).toThrow(
        `Missing required environment variable ${name}.`
      )
    }
  )

  test("sends a missing BETTER_AUTH_SECRET reader through the README Quickstart", () => {
    expect(() =>
      validateNextRuntimeEnv({ ...validEnv, BETTER_AUTH_SECRET: "" })
    ).toThrow(
      `Missing required environment variable BETTER_AUTH_SECRET. The local setup is not finished. Do the README Quickstart steps in order before you run "pnpm dev": they create the secrets in .env.local, copy them to Convex and set the owner setup code. If .env.local already exists, keep it (it holds your Convex values) and add the missing lines from .env.local.example; do not copy the template over it. On a hosted site, set BETTER_AUTH_SECRET in your host's environment.`
    )
  })

  test.each(["NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CONVEX_SITE_URL"])(
    "says the first backend start writes a missing %s",
    (name) => {
      expect(() => getNextAuthEnv({ ...validEnv, [name]: "" })).toThrow(
        `Missing required environment variable ${name}. On your computer, the first backend start in the README Quickstart writes it to .env.local. On a hosted site, set it in your host's environment.`
      )
    }
  )

  test.each([
    {
      label: "cloud and site URLs",
      convexUrl: "https://example.convex.cloud",
      convexSiteUrl: "https://example.convex.site",
    },
    { label: "plain values", convexUrl: "cloud-value", convexSiteUrl: "site-value" },
  ])(
    "auth returns trimmed $label without requiring a secret",
    ({ convexUrl, convexSiteUrl }) => {
      expect(
        getNextAuthEnv({
          NEXT_PUBLIC_CONVEX_URL: ` \t${convexUrl}\n `,
          NEXT_PUBLIC_CONVEX_SITE_URL: ` \t${convexSiteUrl}\n `,
        })
      ).toEqual({ convexUrl, convexSiteUrl })
    }
  )
})
