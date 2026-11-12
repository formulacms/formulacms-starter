import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import {
  anonymousClient,
  clientFor,
  escapeRegExp,
  expectConvexDenial,
  localOrigin,
  localPath,
  ownerPage,
  pageTranslator,
  required,
  signIn,
} from "../support"

const rulePath = `/fr6-v08-${Date.now()}`

async function redirectsToggle(page: Page) {
  const t = await pageTranslator(page)
  return page.getByRole("checkbox", {
    name: t("settings.modules.toggle", { name: t("settings.modules.items.redirects.name") }),
    exact: true,
  })
}

async function setRedirects(page: Page, enabled: boolean) {
  await page.goto("/admin/settings/modules")
  const toggle = await redirectsToggle(page)
  await expect(toggle).toBeChecked({ checked: !enabled })
  await toggle.click()
  await page.getByRole("button", { name: (await pageTranslator(page))("settings.modules.save") }).click()
  await expect(toggle).toBeChecked({ checked: enabled })
}

async function moduleSaveOutcome(page: Page) {
  const saved = page.getByText((await pageTranslator(page))("settings.modules.saved"), { exact: true })
  const stale = page.getByText((await pageTranslator(page))("settings.modules.stale"), { exact: true })
  await expect(saved.or(stale)).toBeVisible()
  return (await saved.isVisible()) ? "saved" : "stale"
}

/**
 * V08. Preconditions: built English app, owner setup complete, Redirects off,
 * and no active rules. The spec owns one unique rule and returns Redirects to
 * off.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V08 Redirects enablement, rule, blocker, denial surface, and stale owner race", async ({ browser, request }) => {
  const first = await ownerPage(browser)
  const second = await ownerPage(browser)
  const unrelatedContext = await browser.newContext({ baseURL: localOrigin() })
  const unrelated = await unrelatedContext.newPage()
  try {
    const historicalPath = localPath("FR6_E2E_V08_HISTORICAL_PATH")
    const historicalLocation = localPath("FR6_E2E_V08_HISTORICAL_LOCATION")
    const historicalBefore = await request.get(historicalPath, {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(historicalBefore.status()).toBe(307)
    expect(historicalBefore.headers().location).toBe(historicalLocation)
    await setRedirects(first, true)
    await signIn(unrelated, required("FR6_E2E_B_EMAIL"), required("FR6_E2E_B_PASSWORD"))
    const ownerClient = await clientFor(first)
    const unrelatedClient = await clientFor(unrelated)
    const anonymous = anonymousClient()
    const emptyRules = await ownerClient.query(api.cms.redirects.list, {})
    expect(emptyRules).toEqual([])
    await expectConvexDenial(unrelatedClient.query(api.cms.redirects.list, {}), "CMS_OWNER_REQUIRED")
    await expectConvexDenial(anonymous.query(api.cms.redirects.list, {}), "UNAUTHENTICATED")
    expect(await ownerClient.query(api.cms.redirects.list, {})).toEqual(emptyRules)

    await first.goto("/admin/redirects")
    await first.getByRole("button", { name: (await pageTranslator(first))("inventory.redirects.add") }).click()
    await first.getByRole("tab", { name: (await pageTranslator(first))("inventory.redirects.customPath") }).click()
    await first.getByPlaceholder((await pageTranslator(first))("inventory.redirects.customPathPlaceholder")).fill(rulePath)
    await first.getByRole("tab", { name: (await pageTranslator(first))("inventory.redirects.externalUrl") }).click()
    await first.getByPlaceholder((await pageTranslator(first))("inventory.redirects.externalPlaceholder")).fill("/")
    await first.getByRole("button", { name: (await pageTranslator(first))("inventory.redirects.create"), exact: true }).click()
    await expect(first.getByText((await pageTranslator(first))("inventory.redirects.created"))).toBeVisible()
    await expect.poll(async () => {
      const response = await request.get(rulePath, { maxRedirects: 0, failOnStatusCode: false })
      return response.status()
    }).toBe(301)

    await test.step("an active rule blocks turning the module off", async () => {
      await first.goto("/admin/settings/modules")
      await (await redirectsToggle(first)).click()
      // modules-settings.tsx passes the blocker's ruleCount; this spec owns the one
      // rule. The sentence is a bare text node followed by the rule list in the
      // same item, so anchor the exact sentence at the start of that item.
      const blocker = (await pageTranslator(first))("settings.modules.redirectRulesBlocker", { count: 1 })
      await expect(
        first.getByRole("listitem").filter({ has: first.getByTestId("redirect-rules-blocker") })
      ).toHaveText(new RegExp(`^${escapeRegExp(blocker)}`))
      await expect(first.getByRole("button", { name: (await pageTranslator(first))("settings.modules.save") })).toBeDisabled()
    })

    await first.goto("/admin/redirects")
    await first
      .getByRole("button", {
        name: (await pageTranslator(first))("inventory.redirects.deleteLabel", { path: rulePath }),
        exact: true,
      })
      .click()
    await expect(first.getByText((await pageTranslator(first))("inventory.redirects.deleted"))).toBeVisible()
    await first.goto("/admin/settings/modules")
    await second.goto("/admin/settings/modules")
    await (await redirectsToggle(first)).click()
    await (await redirectsToggle(second)).click()
    await Promise.all([
      first.getByRole("button", { name: (await pageTranslator(first))("settings.modules.save") }).click(),
      second.getByRole("button", { name: (await pageTranslator(second))("settings.modules.save") }).click(),
    ])
    const outcomes = await Promise.all([moduleSaveOutcome(first), moduleSaveOutcome(second)])
    expect([...outcomes].sort()).toEqual(["saved", "stale"])
    const loser = outcomes[0] === "stale" ? first : second
    await expect(loser.getByRole("button", { name: (await pageTranslator(loser))("settings.modules.reviewAgain") })).toBeVisible()
    await first.reload()
    await second.reload()
    await expect(await redirectsToggle(first)).not.toBeChecked()
    await expect(await redirectsToggle(second)).not.toBeChecked()
    await first.goto("/admin/redirects")
    await expect(first).toHaveURL(/\/admin\/settings\/modules(?:\?|$)/)
    await expect(first.getByText((await pageTranslator(first))("inventory.redirects.moduleOffNotice"))).toBeVisible()
    await expectConvexDenial(ownerClient.query(api.cms.redirects.list, {}), "CMS_MODULE_DISABLED")
    await expectConvexDenial(unrelatedClient.query(api.cms.redirects.list, {}), "CMS_OWNER_REQUIRED")
    await expectConvexDenial(anonymous.query(api.cms.redirects.list, {}), "UNAUTHENTICATED")
    const historicalAfter = await request.get(historicalPath, {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(historicalAfter.status()).toBe(307)
    expect(historicalAfter.headers().location).toBe(historicalLocation)
  } finally {
    await first.context().close()
    await second.context().close()
    await unrelatedContext.close()
  }
})
