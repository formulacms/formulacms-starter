import { describe, expect, test } from "vitest"
import {
  canServeFromCache,
  unreachableSiteConfigState,
  type SiteConfig,
} from "./site-config"

const ONBOARDED: SiteConfig = {
  onboardingCompletedAt: 1,
  defaultLocale: "en",
  enabledLocales: ["en"],
  languageVersion: 1,
}
const NOT_ONBOARDED: SiteConfig = { ...ONBOARDED, onboardingCompletedAt: null }

const NOW = 1_800_000_000_000

describe("site config cache admission", () => {
  test("serves a fresh onboarded verdict", () => {
    expect(
      canServeFromCache({ value: ONBOARDED, expiresAt: NOW + 1 }, NOW)
    ).toBe(true)
  })

  test("refuses an expired entry", () => {
    expect(
      canServeFromCache({ value: ONBOARDED, expiresAt: NOW - 1 }, NOW)
    ).toBe(false)
  })

  test("refuses an empty cache", () => {
    expect(canServeFromCache(null, NOW)).toBe(false)
  })

  // The first-run gate reads this. A cached `null` is the one verdict that is
  // both stale and consequential: serving it funnels the operator back into
  // the wizard they just finished. Onboarding is one-way, so refusing it only
  // ever costs a round-trip before the transition, never after.
  test("refuses a not-onboarded verdict even when fresh", () => {
    expect(
      canServeFromCache({ value: NOT_ONBOARDED, expiresAt: NOW + 14_000 }, NOW)
    ).toBe(false)
  })
})

describe("unreachable Convex fallback", () => {
  test("keeps an unavailable read distinct from a fresh deployment", () => {
    expect(unreachableSiteConfigState(null)).toMatchObject({
      status: "unavailable",
      fallback: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
      },
    })
  })

  // The cookie that used to cover the post-onboarding window is gone, so a
  // slow read must not be able to answer "not onboarded" from a stale entry:
  // that sends the operator who just clicked Finish back into the wizard.
  test("never reuses a stale not-onboarded entry", () => {
    expect(
      unreachableSiteConfigState({
        value: NOT_ONBOARDED,
        expiresAt: NOW + 14_000,
      })
    ).toMatchObject({
      status: "unavailable",
      fallback: { onboardingCompletedAt: null, defaultLocale: "en" },
    })
  })

  test("reuses an onboarded entry, which one-way transition makes safe", () => {
    expect(
      unreachableSiteConfigState({
        value: ONBOARDED,
        expiresAt: NOW - 1,
      })
    ).toEqual({
      status: "ready",
      value: ONBOARDED,
    })
  })
})
