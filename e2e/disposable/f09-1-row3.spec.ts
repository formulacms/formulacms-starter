import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import type { ConvexHttpClient } from "convex/browser"
import {
  adminLocale,
  adminMessages,
  adminTranslator,
  assertNotFoundWithNoindex,
  clientFor,
  getLocaleDisplayName,
  ownerPage,
  requireDisposableStage,
  required,
  sitemap,
} from "../support"

async function start(
  page: Page,
  source: string,
  target: string,
  mode: "correct_label" | "replace_content"
) {
  await page.goto("/admin/settings/languages")
  const locale = await adminLocale(page)
  const language = adminMessages(locale).settings.languages
  await page.getByRole("combobox", { name: language.newLanguage }).selectOption(target)
  await page.getByLabel(language.modes[mode].title).click()
  await page.getByRole("button", { name: language.start, exact: true }).click()
  const heading = adminTranslator(locale)("settings.languages.progressHeading", {
    source: getLocaleDisplayName(source),
    target: getLocaleDisplayName(target),
  })
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
}

async function continueToPreparing(client: ConvexHttpClient) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await client.query(api.cms.language.getLanguageState, {})
    if (state.transition?.phase === "preparing" || state.transition?.phase === "ready") return state
    if (!state.transition) throw new Error("F09 row 3 transition disappeared")
    await client.mutation(api.cms.language.continueLanguageTransition, {
      transitionId: state.transition._id,
      expectedGeneration: state.transition.generation,
    })
  }
  throw new Error("F09 row 3 did not reach preparation")
}

async function confirmValidateActivate(client: ConvexHttpClient) {
  let state = await continueToPreparing(client)
  if (!state.transition) throw new Error("No transition to confirm")
  await client.mutation(api.cms.language.confirmTransitionPreview, {
    transitionId: state.transition._id,
    expectedPreparedSetVersion: state.transition.preparedSetVersion,
    expectedCarryDecisionDigest: state.transition.carryDecisionDigest ?? undefined,
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
  if (!settings || !state.transition?.readinessVersion || state.version === null) {
    throw new Error("F09 row 3 activation tokens are incomplete")
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
 * F09 stage 1 — revision-6 row 3. Preconditions: disposable French setup is
 * complete, the Home Working Draft has never been published, no locale has a
 * candidate/current snapshot, no continuity route exists, and no transition is
 * open. The stage performs the short-path `fr -> en` label correction followed
 * immediately by the short-path `en -> fr` content replacement. Postcondition:
 * current locale and the private Home draft are French again; public Home and
 * sitemap remain empty and no transition is open. The operator owns the
 * never-published fixture. Start state: `single-fr`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("F09 row 3 round-trips a never-published French site without stray public state", async ({ browser, request }) => {
  requireDisposableStage("f09", "f09-1-row3")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    const pageId = required("FR6_E2E_F09_HOME_ID") as Id<"pages">
    const before = await client.query(api.cms.language.getLanguageState, {})
    expect(before).toMatchObject({ kind: "current", currentLocale: "fr", enabledLocales: ["fr"], transition: null })
    expect(await client.query(api.cms.pages.getPublicPageById, {
      id: pageId,
      locale: "fr",
      languageVersion: before.version!,
    })).toBeNull()
    await assertNotFoundWithNoindex(request, "/")
    expect(await sitemap(request)).not.toContain("<url>")

    await start(owner, "fr", "en", "correct_label")
    await confirmValidateActivate(client)
    let state = await client.query(api.cms.language.getLanguageState, {})
    expect(state).toMatchObject({ kind: "current", currentLocale: "en", enabledLocales: ["en"], transition: null })
    const englishDraft = await client.query(api.cms.pages.getForEdit, { id: pageId })
    expect(JSON.stringify(englishDraft)).toContain('"en"')
    expect(await client.query(api.cms.pages.getPublicPageById, {
      id: pageId,
      locale: "en",
      languageVersion: state.version!,
    })).toBeNull()

    await start(owner, "en", "fr", "replace_content")
    await confirmValidateActivate(client)
    state = await client.query(api.cms.language.getLanguageState, {})
    expect(state).toMatchObject({ kind: "current", currentLocale: "fr", enabledLocales: ["fr"], transition: null })
    const frenchDraft = await client.query(api.cms.pages.getForEdit, { id: pageId })
    expect(JSON.stringify(frenchDraft)).toContain('"fr"')
    expect(await client.query(api.cms.pages.getPublicPageById, {
      id: pageId,
      locale: "fr",
      languageVersion: state.version!,
    })).toBeNull()
    await assertNotFoundWithNoindex(request, "/")
    expect(await sitemap(request)).not.toContain("<url>")
  } finally {
    await owner.context().close()
  }
})
