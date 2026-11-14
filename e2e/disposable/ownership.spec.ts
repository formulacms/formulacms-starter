import { expect, test, type Page } from "playwright/test"
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

async function fillFreshAccount(page: Page, name: string, username: string, password: string) {
  await page.goto("/setup")
  await expect(page.getByRole("heading", { name: (await pageTranslator(page))("setup.wizard.title") })).toBeVisible()
  await continueFromLanguageStep(page)
  await page.getByLabel((await pageTranslator(page))("setup.fields.name")).fill(name)
  await page.getByLabel((await pageTranslator(page))("setup.fields.username")).fill(username)
  await page.getByLabel((await pageTranslator(page))("setup.fields.newPassword")).fill(password)
  await page.getByLabel((await pageTranslator(page))("setup.fields.confirmPassword")).fill(password)
  await page.getByLabel((await pageTranslator(page))("setup.fields.ownerCode")).fill(required("FR6_E2E_OWNER_CLAIM"))
}

/**
 * V01. Preconditions: a fresh, unclaimed local backend, zero site settings,
 * one valid owner claim, and two unused usernames. FR6_E2E_START_STATE=
 * fresh-unclaimed and FORMULACMS_DISPOSABLE_TARGET=1 are mandatory.
 * Postcondition: exactly one account obtains the owner UI; the losing form
 * keeps its values, shows the R3 copy and creates no account (ADR-0056:
 * there is no public sign-up, so a second account cannot exist). The
 * operator must reset the disposable backend before another fresh-claim
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
    const aUsername = required("FR6_E2E_OWNER_USERNAME")
    const bUsername = required("FR6_E2E_B_USERNAME")
    const password = required("FR6_E2E_OWNER_PASSWORD")
    await fillFreshAccount(first, "FR6 Owner A", aUsername, password)
    await fillFreshAccount(second, "FR6 Owner B", bUsername, password)
    const createA = first.getByRole("button", { name: (await pageTranslator(first))("setup.actions.createAccount") })
    const createB = second.getByRole("button", { name: (await pageTranslator(second))("setup.actions.createAccount") })
    await expect(createA).toBeEnabled()
    await expect(createB).toBeEnabled()
    await Promise.allSettled([createA.click(), createB.click()])
    await expect.poll(async () => {
      const advanced = await Promise.all([
        first.getByLabel((await pageTranslator(first))("setup.fields.siteName")).isVisible(),
        second.getByLabel((await pageTranslator(second))("setup.fields.siteName")).isVisible(),
      ])
      return advanced.filter(Boolean).length
    }).toBe(1)
    const firstAdvanced = await first.getByLabel((await pageTranslator(first))("setup.fields.siteName")).isVisible().catch(() => false)
    const winner = firstAdvanced ? first : second
    const loser = firstAdvanced ? second : first
    // Wait for the consumed public claim state, then require the R3 copy.
    await expect.poll(() => publicClient.query(api.cms.owner.getOwnerClaimAvailability, {}))
      .toEqual({ available: false })
    const loserMessages = adminMessages(await adminLocale(loser)).setup.errors
    await expect(loser.getByRole("alert")).toHaveText(loserMessages.ownerCodeUnavailable)
    await expect(loser.getByText(loserMessages.ownerCodeMismatch, { exact: true })).toHaveCount(0)
    await expect(loser.getByLabel((await pageTranslator(loser))("setup.fields.username"))).toHaveValue(
      firstAdvanced ? bUsername : aUsername
    )
    await expect(loser.getByLabel((await pageTranslator(loser))("setup.fields.ownerCode"))).toHaveValue(required("FR6_E2E_OWNER_CLAIM"))
    await winner.getByLabel((await pageTranslator(winner))("setup.fields.siteName")).fill("FR6 ownership probe")
    await winner.getByLabel((await pageTranslator(winner))("setup.fields.siteUrl")).fill(localOrigin())
    await winner.getByRole("button", { name: (await pageTranslator(winner))("setup.actions.finishSetup") }).click()
    await expect(winner).toHaveURL(/\/admin(?:\/|$)/)
    const winnerSession = await (await clientFor(winner)).query(api.cms.owner.getOwnerSession, {})
    expect(winnerSession?.username).toBe(firstAdvanced ? aUsername : bUsername)
    expect(await publicClient.query(api.cms.owner.getOwnerEstablished, {})).toEqual({ established: true })
    expect(await publicClient.query(api.cms.owner.getOwnerClaimAvailability, {})).toEqual({ available: false })
    await loser.goto("/admin")
    await expect(loser).not.toHaveURL(/\/admin(?:\/|$)/)
    // The losing sign-up rolled back, so its username signs nothing in.
    await expect(clientFor(loser)).rejects.toThrow(/did not receive a Convex token/)
  } finally {
    await firstContext.close()
    await secondContext.close()
  }
})
