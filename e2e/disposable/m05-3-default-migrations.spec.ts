import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { ConvexHttpClient } from "convex/browser"
import {
  adminMessages,
  adminLocale,
  anonymousClient,
  clientFor,
  controlSnapshot,
  expectConvexDenialWithoutChange,
  ownerPage,
  pageTranslator,
  publicLifecycleEvidence,
  publicLifecycleProbe,
  requireDisposableStage,
  required,
  sitemap,
} from "../support"

async function startDefaultMigration(page: Page, localeLabel: string) {
  await page.goto("/admin/settings/languages")
  const languages = (
    adminMessages(await adminLocale(page))
  ).settings.multilingualLanguages
  const row = page.getByRole("listitem").filter({ hasText: localeLabel })
  await row
    .getByRole("button", {
      name: languages.list.actionsFor.replace("{language}", localeLabel),
    })
    .click()
  await page
    .getByRole("menuitem", { name: languages.list.makeDefault })
    .click()
  await page
    .getByRole("button", { name: languages.makeDefault.start })
    .click()
}

async function finishEnumeration(client: ConvexHttpClient) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await client.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    const migration = state.defaultMigration
    if (migration?.phase === "ready") return migration
    if (!migration)
      throw new Error("The default-language migration disappeared")
    await client.mutation(
      api.cms.multilingual.continueDefaultLanguageMigration,
      {
        migrationId: migration.migrationId,
        expectedGeneration: migration.generation,
      }
    )
  }
  throw new Error(
    "The default-language migration did not become ready in 80 bounded continuations"
  )
}

/** Reads every disclosure page without recording anything (evidence only). */
async function readEveryDisclosurePage(client: ConvexHttpClient) {
  const state = await client.query(api.cms.multilingual.getMultilingualState, {})
  const migration = state.defaultMigration
  if (!migration) throw new Error("No open default-language migration")
  const disclosures: unknown[] = []
  for (let ordinal = 0; ordinal < migration.disclosurePageCount; ordinal += 1) {
    const page = await client.query(
      api.cms.multilingual.listDefaultMigrationDisclosure,
      {
        migrationId: migration.migrationId,
        generation: migration.generation,
        ordinal,
      }
    )
    expect(page.stale).toBe(false)
    if (page.stale) throw new Error(`Disclosure page ${ordinal} became stale`)
    disclosures.push(...page.items)
  }
  return { migration, disclosures }
}

async function readAllRoutes(client: ConvexHttpClient) {
  const state = await client.query(
    api.cms.multilingual.getMultilingualState,
    {}
  )
  const migration = state.defaultMigration
  if (!migration) throw new Error("No open migration for route pagination")
  const rows: Array<{
    fromPath: string
    locale: string
    origin: string
    retiredAt?: number
    manualRule?: "shadowed"
  }> = []
  let cursor: string | null = null
  do {
    const page: (typeof api.cms.multilingual.listDefaultLanguageRoutes)["_returnType"] =
      await client.query(api.cms.multilingual.listDefaultLanguageRoutes, {
        migrationId: migration.migrationId,
        generation: migration.generation,
        paginationOpts: { cursor, numItems: 5 },
        filter: "all" as const,
      })
    rows.push(...page.page)
    cursor = page.isDone ? null : page.continueCursor
  } while (cursor !== null)
  expect(rows.length).toBeGreaterThan(5)
  return rows
}

/**
 * The Make default dialog lists every page of the review; one button records
 * the receipts and makes the change. Nothing is recorded before that click.
 */
async function activateReviewedMigration(
  client: ConvexHttpClient,
  page: Page,
  localeLabel: string,
  locale: string
) {
  const { migration, disclosures } = await readEveryDisclosurePage(client)
  expect(migration.readinessVersion).not.toBeNull()
  expect(migration.reviewedThroughOrdinal).toBe(-1)
  const t = await pageTranslator(page)
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("region", {
      name: t("settings.multilingualLanguages.review.listLabel"),
    })
  ).toBeVisible()
  await dialog
    .getByRole("button", {
      name: t("settings.multilingualLanguages.migration.activate", {
        language: localeLabel,
      }),
    })
    .click()
  await expect
    .poll(async () => {
      const state = await client.query(
        api.cms.multilingual.getMultilingualState,
        {}
      )
      return state.defaultLocale
    })
    .toBe(locale)
  return { result: { locale }, disclosures }
}

/**
 * M05 stage 3 — P6, disclosure pagination, the default-language parts of P7
 * and V10, plus the UI-reachable P24 precursor. Preconditions: stage 2 left
 * S4 with `en` default, `fr` published fixtures, more than five migration
 * route rows, menu-locale omission, and the two manual-rule fixtures. This
 * stage migrates `en -> fr`, moves the designated English Page from its old
 * address to a new one while English is non-default, then migrates `fr -> en`.
 * Postcondition: S4 with `en` default and a pointed round-trip generation for
 * stage 5; no open operation. Start state: `after-m05-2-languages`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("M05 stage 3 reviews paginated migrations, preserves V10, and creates the P24 pointer", async ({
  browser,
  request,
}, testInfo) => {
  requireDisposableStage("m05", "m05-3-default-migrations")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    const initial = await client.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    expect(initial).toMatchObject({
      lifecycleState: "S4",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
    })
    const rootBefore = await publicLifecycleProbe(request, "/")
    const oldEnglishBefore = await publicLifecycleProbe(
      request,
      required("FR6_E2E_M05_EN_PATH")
    )
    const frenchPrefixedBefore = await publicLifecycleProbe(
      request,
      required("FR6_E2E_M05_FR_PATH")
    )
    expect(rootBefore).toMatchObject({
      status: 200,
      rscStatus: 200,
      lang: "en",
      noindex: false,
    })
    expect(frenchPrefixedBefore).toMatchObject({
      status: 200,
      rscStatus: 200,
      lang: "fr",
      noindex: false,
    })
    const publicClient = anonymousClient()
    let siteConfig = await publicClient.query(
      api.cms.settings.getSiteConfig,
      {}
    )
    expect(
      await publicClient.query(api.cms.redirects.resolve, {
        path: required("FR6_E2E_M05_MANUAL_EN_PATH"),
        locale: "en",
        languageVersion: siteConfig.languageVersion,
      })
    ).toEqual({ destination: "/", statusCode: 302 })
    expect(
      await publicClient.query(api.cms.redirects.resolve, {
        path: required("FR6_E2E_M05_MANUAL_FR_PATH"),
        locale: "fr",
        languageVersion: siteConfig.languageVersion,
      })
    ).toEqual({ destination: "/fr", statusCode: 302 })

    await startDefaultMigration(owner, required("FR6_E2E_M05_FR_LABEL"))
    let migration = await finishEnumeration(client)
    const beforeReview = await client.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    await expectConvexDenialWithoutChange(
      () => client.query(api.cms.multilingual.getMultilingualState, {}),
      () =>
        client.mutation(api.cms.multilingual.activateDefaultLanguageMigration, {
          migrationId: migration.migrationId,
          expectedGeneration: migration.generation,
          expectedReadinessVersion: migration.readinessVersion!,
          expectedAuthorityVersion: beforeReview.version!,
        }),
      "DEFAULT_MIGRATION_REVIEW_INCOMPLETE"
    )
    expect(
      controlSnapshot(
        await client.query(api.cms.multilingual.getMultilingualState, {})
      )
    ).toBe(controlSnapshot(beforeReview))
    const forwardRoutes = await readAllRoutes(client)
    expect(
      forwardRoutes.some(
        (row) => row.fromPath === required("FR6_E2E_M05_MANUAL_EN_PATH")
      )
    ).toBe(true)
    const forward = await activateReviewedMigration(
      client,
      owner,
      required("FR6_E2E_M05_FR_LABEL"),
      "fr"
    )
    expect(forward.result.locale).toBe("fr")
    expect(JSON.stringify(forward.disclosures)).toContain(
      required("FR6_E2E_M05_MANUAL_EN_PATH")
    )
    expect(JSON.stringify(forward.disclosures)).toContain(
      required("FR6_E2E_M05_MANUAL_FR_PATH")
    )

    const rootFrench = await publicLifecycleProbe(request, "/")
    expect(rootFrench).toMatchObject({
      status: 200,
      rscStatus: 200,
      lang: "fr",
      noindex: false,
    })
    expect(rootFrench.body).toContain(required("FR6_E2E_M05_FR_MENU_LABEL"))
    expect(rootFrench.body).not.toContain(required("FR6_E2E_M05_EN_MENU_LABEL"))
    const oldEnglish = await publicLifecycleProbe(
      request,
      required("FR6_E2E_M05_EN_PATH")
    )
    expect(oldEnglish.status).toBe(307)
    expect(oldEnglish.location).toBe(required("FR6_E2E_M05_EN_PREFIXED_PATH"))
    const frenchPath = required("FR6_E2E_M05_FR_PATH")
    const frenchPrefix = "/fr"
    if (
      frenchPath !== frenchPrefix &&
      !frenchPath.startsWith(`${frenchPrefix}/`)
    ) {
      throw new Error(`Expected ${frenchPath} to be a French-prefixed path`)
    }
    const frenchDefaultPath =
      frenchPath === frenchPrefix ? "/" : frenchPath.slice(frenchPrefix.length)
    expect(await sitemap(request)).toContain(frenchDefaultPath)
    siteConfig = await publicClient.query(api.cms.settings.getSiteConfig, {})
    expect(
      await publicClient.query(api.cms.redirects.resolve, {
        path: required("FR6_E2E_M05_MANUAL_EN_PATH"),
        locale: "en",
        languageVersion: siteConfig.languageVersion,
      })
    ).toEqual({ destination: "/en", statusCode: 302 })
    expect(
      await publicClient.query(api.cms.redirects.resolve, {
        path: required("FR6_E2E_M05_MANUAL_FR_PATH"),
        locale: "fr",
        languageVersion: siteConfig.languageVersion,
      })
    ).toEqual({ destination: "/", statusCode: 302 })

    await owner.goto(required("FR6_E2E_P24_PAGE_EDITOR"))
    const editorMessages =
      adminMessages(await adminLocale(owner))
    await owner
      .getByRole("tab", { name: required("FR6_E2E_M05_EN_TAB") })
      .click()
    await owner
      .getByRole("button", { name: editorMessages.editor.page.moreActions })
      .click()
    await owner
      .getByRole("menuitem", { name: editorMessages.editor.page.unpublish })
      .click()
    await owner
      .getByRole("alertdialog")
      .getByRole("button", {
        name: editorMessages.pages.list.unpublish.confirm,
        exact: true,
      })
      .click()
    await expect(
      owner.getByText(editorMessages.editor.pageSave.unpublished, {
        exact: true,
      })
    ).toBeVisible()
    await owner
      .getByLabel(editorMessages.editor.settings.slug)
      .fill(required("FR6_E2E_P24_NEW_EN_SLUG"))
    await owner
      .getByRole("button", {
        name: editorMessages.editor.page.save,
        exact: true,
      })
      .click()
    await owner
      .getByRole("button", {
        name: editorMessages.editor.page.publish,
        exact: true,
      })
      .click()
    await expect(
      owner.getByText(editorMessages.editor.pageSave.published, { exact: true })
    ).toBeVisible()

    await startDefaultMigration(owner, required("FR6_E2E_M05_EN_LABEL"))
    migration = await finishEnumeration(client)
    const reverseRoutes = await readAllRoutes(client)
    expect(
      reverseRoutes.some(
        (row) => row.fromPath === required("FR6_E2E_P24_CARRY_PATH")
      )
    ).toBe(true)
    const dropLocaleRoute = reverseRoutes.find(
      (row) => row.fromPath === required("FR6_E2E_P24_DROP_LOCALE_PATH")
    )
    expect(dropLocaleRoute).toMatchObject({ locale: "fr" })
    expect(dropLocaleRoute?.retiredAt).toBeUndefined()
    const reverse = await activateReviewedMigration(
      client,
      owner,
      required("FR6_E2E_M05_EN_LABEL"),
      "en"
    )
    expect(reverse.result.locale).toBe("en")
    const finalState = await client.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    expect(finalState).toMatchObject({
      lifecycleState: "S4",
      defaultLocale: "en",
      openOperation: null,
    })
    expect(finalState.version).toBeGreaterThan(initial.version ?? 0)

    const noLoop = await request.get(required("FR6_E2E_P24_CARRY_PATH"), {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(noLoop.status()).toBe(307)
    expect(noLoop.headers().location).not.toBe(
      required("FR6_E2E_P24_CARRY_PATH")
    )
    const rootAfterReverse = await publicLifecycleProbe(request, "/")
    expect(rootAfterReverse).toMatchObject({
      status: 200,
      rscStatus: 200,
      lang: "en",
      noindex: false,
    })
    await testInfo.attach("p7-default-migrations", {
      body: JSON.stringify({
        rootBefore: publicLifecycleEvidence(rootBefore),
        oldEnglishBefore: publicLifecycleEvidence(oldEnglishBefore),
        frenchPrefixedBefore: publicLifecycleEvidence(frenchPrefixedBefore),
        rootFrench: publicLifecycleEvidence(rootFrench),
        oldEnglishAfterForward: publicLifecycleEvidence(oldEnglish),
        rootAfterReverse: publicLifecycleEvidence(rootAfterReverse),
      }),
      contentType: "application/json",
    })
  } finally {
    await owner.context().close()
  }
})
