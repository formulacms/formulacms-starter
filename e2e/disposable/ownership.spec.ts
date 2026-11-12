import { expect, test, type Page } from "playwright/test"
import { OWNER_CLAIM_HEADER } from "../../convex/lib/ownerClaim"
import {
  pageTranslator,
  adminLocale,
  adminMessages,
  anonymousClient,
  clientFor,
  localOrigin,
  requireDisposable,
  required,
} from "../support"
import { api } from "../../convex/_generated/api"

/** Setup opens on the language step: accept the prefilled choices and go on. */
async function continueFromLanguageStep(page: Page) {
  await page.getByRole("button", { name: (await pageTranslator(page))("setup.actions.continue") }).click()
}

async function fillFreshAccount(page: Page, name: string, email: string, password: string) {
  await page.goto("/setup")
  await expect(page.getByRole("heading", { name: (await pageTranslator(page))("setup.wizard.title") })).toBeVisible()
  await continueFromLanguageStep(page)
  await page.getByLabel((await pageTranslator(page))("setup.fields.name")).fill(name)
  await page.getByLabel((await pageTranslator(page))("setup.fields.signInEmail")).fill(email)
  await page.getByLabel((await pageTranslator(page))("setup.fields.newPassword")).fill(password)
  await page.getByLabel((await pageTranslator(page))("setup.fields.confirmPassword")).fill(password)
  await page.getByLabel((await pageTranslator(page))("setup.fields.ownerCode")).fill(required("FR6_E2E_OWNER_CLAIM"))
}

/**
 * V01 and B-before-ownership. Preconditions: a fresh, unclaimed local backend,
 * zero site settings, one valid owner claim, and two unused test identities.
 * FR6_E2E_START_STATE=fresh-unclaimed and FORMULACMS_DISPOSABLE_TARGET=1 are
 * mandatory. Postcondition: exactly one account obtains the owner UI; the
 * losing account retains its form values and cannot overwrite ownership.
 * The operator must reset the disposable backend before another fresh-claim
 * attempt.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V01 two contexts start from the same unclaimed state and yield one owner", async ({ browser, request }) => {
  requireDisposable("fresh-unclaimed")
  const publicClient = anonymousClient()
  expect(await publicClient.query(api.cms.owner.getOwnerEstablished, {})).toEqual({ established: false })
  expect(await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})).toEqual({ available: true })
  const setup = await request.get("/setup", { maxRedirects: 0 })
  expect(setup.status()).toBe(200)
  const firstContext = await browser.newContext({ baseURL: localOrigin() })
  const secondContext = await browser.newContext({ baseURL: localOrigin() })
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()
  try {
    const aEmail = required("FR6_E2E_OWNER_EMAIL")
    const bEmail = required("FR6_E2E_B_EMAIL")
    const bPassword = required("FR6_E2E_B_PASSWORD")
    const bSignup = await request.post("/api/auth/sign-up/email", {
      data: { name: "FR6 Account B", email: bEmail, password: bPassword },
      headers: { [OWNER_CLAIM_HEADER]: required("FR6_E2E_OWNER_CLAIM") },
      failOnStatusCode: false,
    })
    expect(bSignup.ok()).toBe(true)
    await second.goto("/sign-in")
    await second.getByLabel((await pageTranslator(second))("auth.signIn.form.emailLabel")).fill(bEmail)
    await second.getByLabel((await pageTranslator(second))("auth.signIn.form.passwordLabel")).fill(bPassword)
    await second.getByRole("button", { name: (await pageTranslator(second))("auth.signIn.form.submit") }).click()
    await second.goto("/setup")
    await expect(second.getByRole("heading", { name: (await pageTranslator(second))("setup.wizard.title") })).toBeVisible()
    await continueFromLanguageStep(second)
    expect(await publicClient.query(api.cms.owner.getOwnerEstablished, {})).toEqual({ established: false })
    expect(await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})).toEqual({ available: true })
    await second.getByLabel((await pageTranslator(second))("setup.fields.ownerCode")).fill(required("FR6_E2E_OWNER_CLAIM"))
    await second.goto("/admin")
    await expect(second).not.toHaveURL(/\/admin(?:\/|$)/)
    await second.goto("/setup")
    await continueFromLanguageStep(second)
    await second.getByLabel((await pageTranslator(second))("setup.fields.ownerCode")).fill(required("FR6_E2E_OWNER_CLAIM"))
    await fillFreshAccount(first, "FR6 Owner A", aEmail, required("FR6_E2E_OWNER_PASSWORD"))
    await expect(first.getByRole("button", { name: (await pageTranslator(first))("setup.actions.createAccount") })).toBeEnabled()
    await expect(second.getByRole("button", { name: (await pageTranslator(second))("setup.actions.continue") })).toBeEnabled()
    await Promise.allSettled([
      first.getByRole("button", { name: (await pageTranslator(first))("setup.actions.createAccount") }).click(),
      second.getByRole("button", { name: (await pageTranslator(second))("setup.actions.continue") }).click(),
    ])
    await expect.poll(async () => {
      const advanced = await Promise.all([
        first.getByLabel((await pageTranslator(first))("setup.fields.siteName")).isVisible(),
        second.getByLabel((await pageTranslator(second))("setup.fields.siteName")).isVisible(),
      ])
      return advanced.filter(Boolean).length
    }).toBe(1)
    const firstAdvanced = await first.getByLabel((await pageTranslator(first))("setup.fields.siteName")).isVisible().catch(() => false)
    const secondAdvanced = await second.getByLabel((await pageTranslator(second))("setup.fields.siteName")).isVisible().catch(() => false)
    expect(Number(firstAdvanced) + Number(secondAdvanced)).toBe(1)
    const winner = firstAdvanced ? first : second
    const loser = firstAdvanced ? second : first
    // Wait for the consumed public claim state, then require the R3 copy.
    await expect.poll(() => publicClient.query(api.cms.owner.getOwnerClaimAvailability, {}))
      .toEqual({ available: false })
    const loserMessages = adminMessages(await adminLocale(loser)).setup.errors
    await expect(loser.getByRole("alert")).toHaveText(loserMessages.ownerCodeUnavailable)
    await expect(loser.getByText(loserMessages.ownerCodeMismatch, { exact: true })).toHaveCount(0)
    if (firstAdvanced) {
      await expect(loser.getByLabel((await pageTranslator(loser))("setup.fields.ownerCode"))).toHaveValue(required("FR6_E2E_OWNER_CLAIM"))
    } else {
      await expect(loser.getByLabel((await pageTranslator(loser))("setup.fields.name"))).toHaveValue("FR6 Owner A")
      await expect(loser.getByLabel((await pageTranslator(loser))("setup.fields.email"))).toHaveValue(aEmail)
      await expect(loser.getByLabel((await pageTranslator(loser))("setup.fields.ownerCode"))).toHaveValue(required("FR6_E2E_OWNER_CLAIM"))
    }
    await winner.getByLabel((await pageTranslator(winner))("setup.fields.siteName")).fill("FR6 ownership probe")
    await winner.getByLabel((await pageTranslator(winner))("setup.fields.siteUrl")).fill(localOrigin())
    await winner.getByRole("button", { name: (await pageTranslator(winner))("setup.actions.finishSetup") }).click()
    await expect(winner).toHaveURL(/\/admin(?:\/|$)/)
    const winnerSession = await (await clientFor(winner)).query(api.cms.owner.getOwnerSession, {})
    expect(winnerSession?.email).toBe(firstAdvanced ? aEmail : bEmail)
    expect(await publicClient.query(api.cms.owner.getOwnerEstablished, {})).toEqual({ established: true })
    expect(await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})).toEqual({ available: false })
    await loser.goto("/admin")
    await expect(loser).not.toHaveURL(/\/admin(?:\/|$)/)
    expect(await (await clientFor(loser)).query(api.cms.owner.getOwnerSession, {})).toBeNull()
  } finally {
    await firstContext.close()
    await secondContext.close()
  }
})
