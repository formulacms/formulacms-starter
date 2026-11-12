import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import { OWNER_CLAIM_HEADER } from "../../convex/lib/ownerClaim"
import { pageTranslator, anonymousClient, clientFor, localOrigin, requireDisposable, required, signIn } from "../support"

/**
 * V02 browser portions. Preconditions: completed French owner app (R7.8 6.3 step 5), B already
 * signed up, owner claim consumed, and the private reset_pty.py operator step
 * has reset the owner's password to FR6_E2E_RESET_OWNER_PASSWORD. The reset
 * driver and its secrets are never shipped by this spec. Set
 * FORMULACMS_DISPOSABLE_TARGET=1 and FR6_E2E_START_STATE=owned-after-reset.
 * Postcondition: ownership is unchanged and all signup probes are denied.
 * The operator owns the private password-reset step.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V02 neutral recovery copy, refused claims on both origins, and owner continuity", async ({ browser, request }) => {
  requireDisposable("owned-after-reset")
  const signedOut = await browser.newContext({ baseURL: localOrigin() })
  const page = await signedOut.newPage()
  try {
    const publicClient = anonymousClient()
    const ownerState = await publicClient.query(api.cms.owner.getOwnerEstablished, {})
    const claimState = await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})
    expect(ownerState).toEqual({ established: true })
    expect(claimState).toEqual({ available: false })
    await page.goto("/forgot-password")
    await page.getByLabel((await pageTranslator(page))("auth.forgotPassword.emailLabel")).fill(required("FR6_E2E_OWNER_EMAIL"))
    await page.getByRole("button", { name: (await pageTranslator(page))("auth.forgotPassword.sendResetLink") }).click()
    await expect(page.getByText((await pageTranslator(page))("auth.forgotPassword.confirmation"))).toBeVisible()
    await page.goto("/reset-password?token=invalid")
    await expect(page.getByRole("heading", { name: (await pageTranslator(page))("auth.resetPassword.invalid.title") })).toBeVisible()

    const convexSite = new URL(required("FR6_E2E_CONVEX_SITE_URL"))
    if (
      convexSite.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(convexSite.hostname)
    ) throw new Error("FR6_E2E_CONVEX_SITE_URL must be local HTTP")
    const origins = [new URL(required("PUBLIC_BASE_URL")).origin, convexSite.origin]
    const claim = required("FR6_E2E_OWNER_CLAIM")
    for (const [kind, header] of [
      ["replayed", claim],
      ["wrong", `${claim}-wrong`],
      ["missing", null],
    ] as const) {
      for (const origin of origins) {
        const response = await request.post(`${origin}/api/auth/sign-up/email`, {
          data: {
            name: `FR6 ${kind}`,
            email: `fr6-${kind}-${Date.now()}@example.invalid`,
            password: required("FR6_E2E_B_PASSWORD"),
          },
          ...(header === null ? {} : { headers: { [OWNER_CLAIM_HEADER]: header } }),
          failOnStatusCode: false,
        })
        expect(response.status(), `${kind} claim at ${new URL(origin).hostname}`).toBe(403)
      }
    }

    await page.goto("/sign-in")
    await signIn(page, required("FR6_E2E_OWNER_EMAIL"), required("FR6_E2E_RESET_OWNER_PASSWORD"))
    await expect(page).toHaveURL(/\/admin(?:\/|$)/)
    expect((await (await clientFor(page)).query(api.cms.owner.getOwnerSession, {}))?.email).toBe(
      required("FR6_E2E_OWNER_EMAIL")
    )
    expect(await publicClient.query(api.cms.owner.getOwnerEstablished, {})).toEqual(ownerState)
    expect(await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})).toEqual(claimState)
  } finally {
    await signedOut.close()
  }
})
