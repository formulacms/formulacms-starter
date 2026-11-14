import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import { anonymousClient, clientFor, localOrigin, requireDisposable, required, signIn } from "../support"

/**
 * V02 browser portions. Preconditions: completed owner app (R7.8 6.3 step 5)
 * with the owner claim consumed. Set FORMULACMS_DISPOSABLE_TARGET=1 and
 * FR6_E2E_START_STATE=owned. Postcondition: ownership is unchanged and every
 * account-creation probe is refused (ADR-0056: no public sign-up; the owner
 * code works once).
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V02 refused account creation on every path, and owner continuity", async ({ browser, request }) => {
  requireDisposable("owned")
  const signedOut = await browser.newContext({ baseURL: localOrigin() })
  const page = await signedOut.newPage()
  try {
    const publicClient = anonymousClient()
    const ownerState = await publicClient.query(api.cms.owner.getOwnerEstablished, {})
    const claimState = await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})
    expect(ownerState).toEqual({ established: true })
    expect(claimState).toEqual({ available: false })

    const claim = required("FR6_E2E_OWNER_CLAIM")
    const password = required("FR6_E2E_OWNER_PASSWORD")
    for (const [kind, code] of [
      ["replayed", claim],
      ["wrong", `${claim}-wrong`],
    ] as const) {
      const result = await publicClient.mutation(api.cms.owner.createOwnerAccount, {
        code,
        name: `FR6 ${kind}`,
        username: `fr6-${kind}-${Date.now()}`,
        password,
      })
      expect(result, `${kind} owner code`).toEqual({ status: "unavailable" })
    }
    // The public sign-up has no grant, so it creates no account and no session.
    const signUp: unknown = await publicClient
      .mutation(api.auth.signUpWithUsernamePassword, {
        username: `fr6-direct-${Date.now()}`,
        password,
      })
      .catch((error: unknown) => error)
    expect(JSON.stringify(signUp ?? null)).not.toContain("accessToken")
    // The sign-in route forwards only the sign-in function.
    const proxied = await request.post("/auth/signin?path=/api/mutation", {
      headers: { Origin: localOrigin(), "content-type": "application/json" },
      data: {
        path: "auth:signUpWithUsernamePassword",
        format: "convex_encoded_json",
        args: [{ username: `fr6-proxy-${Date.now()}`, password }],
      },
      failOnStatusCode: false,
    })
    expect(proxied.status()).toBe(403)

    await signIn(page, required("FR6_E2E_OWNER_USERNAME"), password)
    await expect(page).toHaveURL(/\/admin(?:\/|$)/)
    expect((await (await clientFor(page)).query(api.cms.owner.getOwnerSession, {}))?.username).toBe(
      required("FR6_E2E_OWNER_USERNAME")
    )
    expect(await publicClient.query(api.cms.owner.getOwnerEstablished, {})).toEqual(ownerState)
    expect(await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})).toEqual(claimState)
  } finally {
    await signedOut.close()
  }
})
