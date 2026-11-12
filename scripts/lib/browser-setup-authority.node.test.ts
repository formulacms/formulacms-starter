import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { assertAuthoritativeSetupComplete } from "./browser-setup-authority"

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

describe("browser verification setup authority", () => {
  test("refuses a setup redirect instead of treating client state as onboarding proof", () => {
    expect(() =>
      assertAuthoritativeSetupComplete(
        "http://localhost:3000/setup",
        "check:app-creation"
      )
    ).toThrow(
      "check:app-creation requires authoritative completed setup; the server redirected to /setup"
    )
  })

  test("accepts a route reached after authoritative setup", () => {
    expect(() =>
      assertAuthoritativeSetupComplete(
        "http://localhost:3000/forgot-password",
        "check:e2e"
      )
    ).not.toThrow()
  })

  // This guard also runs inside generated apps, so it reads only harnesses
  // that ship with them.
  test("keeps the retired forgeable cookie out of every shipped browser harness", () => {
    const harnesses = [
      "scripts/verify-starter-e2e.ts",
      "scripts/verify-app-creation.ts",
    ]

    for (const relativePath of harnesses) {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8")
      expect(source, relativePath).not.toMatch(
        /nextcms-onboarded|ONBOARDED_COOKIE/
      )
    }

    expect(existsSync(path.join(repoRoot, "lib/onboarding-cookie.ts"))).toBe(
      false
    )
  })
})
