import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { ConvexHttpClient } from "convex/browser"
import {
  pageTranslator,
  adminLocale,
  adminMessages,
  adminTranslator,
  clientFor,
  fr,
  getLocaleDisplayName,
  localOrigin,
  ownerPage,
  requireDisposableStage,
} from "../support"

async function startCorrection(page: Page, source: string, target: string) {
  await page.goto("/admin/settings/languages")
  const locale = await adminLocale(page)
  const messages = adminMessages(locale)
  await page
    .getByRole("combobox", { name: messages.settings.languages.newLanguage })
    .selectOption(target)
  await page
    .getByLabel(messages.settings.languages.modes.correct_label.title)
    .click()
  await page
    .getByRole("button", {
      name: messages.settings.languages.start,
      exact: true,
    })
    .click()
  const heading = adminTranslator(locale)("settings.languages.progressHeading", {
    source: getLocaleDisplayName(source),
    target: getLocaleDisplayName(target),
  })
  await expect(
    page.getByRole("heading", { name: heading, exact: true })
  ).toBeVisible()
}

async function activateCorrection(client: ConvexHttpClient) {
  let state = await client.query(api.cms.language.getLanguageState, {})
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (
      state.transition?.phase === "preparing" ||
      state.transition?.phase === "ready"
    )
      break
    if (!state.transition) throw new Error("Fallback correction disappeared")
    await client.mutation(api.cms.language.continueLanguageTransition, {
      transitionId: state.transition._id,
      expectedGeneration: state.transition.generation,
    })
    state = await client.query(api.cms.language.getLanguageState, {})
  }
  if (!state.transition) throw new Error("No fallback correction to confirm")
  await client.mutation(api.cms.language.confirmTransitionPreview, {
    transitionId: state.transition._id,
    expectedPreparedSetVersion: state.transition.preparedSetVersion,
    expectedCarryDecisionDigest:
      state.transition.carryDecisionDigest ?? undefined,
  })
  state = await client.query(api.cms.language.getLanguageState, {})
  await client.mutation(api.cms.language.validateLanguageTransition, {
    transitionId: state.transition!._id,
    expectedGeneration: state.transition!.generation,
  })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    state = await client.query(api.cms.language.getLanguageState, {})
    if (state.transition?.phase === "ready") break
    await client.mutation(api.cms.language.continueLanguageTransition, {
      transitionId: state.transition!._id,
      expectedGeneration: state.transition!.generation,
    })
  }
  state = await client.query(api.cms.language.getLanguageState, {})
  const settings = await client.query(api.cms.settings.getSettings, {})
  if (
    !settings ||
    !state.transition?.readinessVersion ||
    state.version === null
  ) {
    throw new Error("Fallback activation tokens are incomplete")
  }
  await client.mutation(api.cms.language.activateLanguageTransition, {
    transitionId: state.transition._id,
    expectedGeneration: state.transition.generation,
    expectedAuthorityVersion: state.version,
    expectedSettingsUpdatedAt: settings.updatedAt,
    expectedReadinessVersion: state.transition.readinessVersion,
  })
}

/**
 * F09 stage 3 — P9 admin-language independence under the owner's EN/FR-only
 * starter ruling. Preconditions: stage 2 left current `en`, no open transition,
 * and no saved admin preference. The owner sees effective English with the
 * matching bundle/direction and only the two shipped admin choices, then saves
 * French. Postcondition: the supported French preference and bundle/direction
 * survive `en -> fr -> en` while the public site follows each site-language
 * change. The operator owns final disposable teardown. Start state:
 * `after-f09-2-row4-remedy`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("F09 uses only English and French while keeping admin language independent", async ({
  browser,
  request,
}) => {
  requireDisposableStage("f09", "f09-3-fallback")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    expect(
      await client.query(api.cms.userPreferences.getAdminLocale, {})
    ).toBeNull()
    const before = await client.query(api.cms.language.getLanguageState, {})
    expect(before).toMatchObject({
      kind: "current",
      currentLocale: "en",
      transition: null,
    })
    await owner.goto("/admin/settings/account")
    await expect(owner.locator("html")).toHaveAttribute("lang", "en")
    await expect(owner.locator("html")).toHaveAttribute("dir", "ltr")
    await expect(
      owner.getByRole("heading", { name: (await pageTranslator(owner))("settings.account.title") })
    ).toBeVisible()
    await owner.getByRole("combobox").click()
    await expect(owner.getByRole("option")).toHaveCount(2)
    await expect(
      owner.getByRole("option", { name: getLocaleDisplayName("en"), exact: true })
    ).toBeVisible()
    await owner
      .getByRole("option", { name: getLocaleDisplayName("fr"), exact: true })
      .click()
    await owner
      .getByRole("button", { name: (await pageTranslator(owner))("settings.account.ok"), exact: true })
      .click()
    await expect(owner.locator("html")).toHaveAttribute("lang", "fr")
    await expect(owner.locator("html")).toHaveAttribute("dir", "ltr")
    await expect(
      owner.getByRole("heading", { name: fr.settings.account.title })
    ).toBeVisible()
    expect(await client.query(api.cms.userPreferences.getAdminLocale, {})).toBe(
      "fr"
    )

    await startCorrection(owner, "en", "fr")
    await activateCorrection(client)
    expect(await client.query(api.cms.userPreferences.getAdminLocale, {})).toBe(
      "fr"
    )
    expect(
      await client.query(api.cms.language.getLanguageState, {})
    ).toMatchObject({
      kind: "current",
      currentLocale: "fr",
      enabledLocales: ["fr"],
      transition: null,
    })

    await owner.goto("/admin/settings/account")
    await expect(owner.locator("html")).toHaveAttribute("lang", "fr")
    await expect(owner.locator("html")).toHaveAttribute("dir", "ltr")
    await expect(
      owner.getByRole("heading", { name: fr.settings.account.title })
    ).toBeVisible()
    const signedOut = await browser.newContext({ baseURL: localOrigin() })
    try {
      const signIn = await signedOut.newPage()
      await signIn.goto("/sign-in")
      await expect(signIn.locator("html")).toHaveAttribute("lang", "fr")
      await expect(signIn.locator("html")).toHaveAttribute("dir", "ltr")
    } finally {
      await signedOut.close()
    }
    const publicFrench = await request.get("/")
    const publicFrenchBody = await publicFrench.text()
    expect(publicFrenchBody).toMatch(/<html[^>]+lang=["']fr["']/)
    expect(publicFrenchBody).toMatch(/<html[^>]+dir=["']ltr["']/)

    await startCorrection(owner, "fr", "en")
    await activateCorrection(client)
    expect(await client.query(api.cms.userPreferences.getAdminLocale, {})).toBe(
      "fr"
    )
    await owner.goto("/admin/settings/account")
    await expect(owner.locator("html")).toHaveAttribute("lang", "fr")
    await expect(owner.locator("html")).toHaveAttribute("dir", "ltr")
    await expect(
      owner.getByRole("heading", { name: fr.settings.account.title })
    ).toBeVisible()
    expect(
      await client.query(api.cms.language.getLanguageState, {})
    ).toMatchObject({
      kind: "current",
      currentLocale: "en",
      enabledLocales: ["en"],
      transition: null,
    })
    const publicEnglish = await request.get("/")
    const publicEnglishBody = await publicEnglish.text()
    expect(publicEnglishBody).toMatch(/<html[^>]+lang=["']en["']/)
    expect(publicEnglishBody).toMatch(/<html[^>]+dir=["']ltr["']/)
  } finally {
    await owner.context().close()
  }
})
