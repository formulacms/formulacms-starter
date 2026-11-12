import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import type { ConvexHttpClient } from "convex/browser"
import {
  adminLocale,
  adminMessages,
  adminTranslator,
  anonymousClient,
  clientFor,
  controlSnapshot,
  expectConvexDenialWithoutChange,
  getLocaleDisplayName,
  localOrigin,
  ownerPage,
  pageTranslator,
  requireDisposableStage,
  required,
  signIn,
} from "../support"

async function startReplacement(page: Page, source: string, target: string) {
  await page.goto("/admin/settings/languages")
  const locale = await adminLocale(page)
  const language = adminMessages(locale).settings.languages
  await page.getByRole("combobox", { name: language.newLanguage }).selectOption(target)
  await page.getByLabel(language.modes.replace_content.title).click()
  await page.getByRole("button", { name: language.start, exact: true }).click()
  const heading = adminTranslator(locale)("settings.languages.progressHeading", {
    source: getLocaleDisplayName(source),
    target: getLocaleDisplayName(target),
  })
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
}

async function pages(client: ConvexHttpClient) {
  const state = await client.query(api.cms.language.getLanguageState, {})
  if (!state.transition) throw new Error("No open F09 transition")
  const rows: Array<
    (typeof api.cms.language.listLanguageTransitionPages)["_returnType"]["page"][number]
  > = []
  let cursor: string | null = null
  do {
    const result: (typeof api.cms.language.listLanguageTransitionPages)["_returnType"] = await client.query(api.cms.language.listLanguageTransitionPages, {
      transitionId: state.transition._id,
      paginationOpts: { cursor, numItems: 20 },
    })
    rows.push(...result.page)
    cursor = result.isDone ? null : result.continueCursor
  } while (cursor !== null)
  return rows
}

async function control(client: ConvexHttpClient) {
  return {
    state: await client.query(api.cms.language.getLanguageState, {}),
    pages: await pages(client),
  }
}

async function waitForPreparing(client: ConvexHttpClient) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await client.query(api.cms.language.getLanguageState, {})
    if (state.transition?.phase === "preparing" || state.transition?.phase === "ready") return state
    if (!state.transition) throw new Error("F09 row 4 transition disappeared")
    await client.mutation(api.cms.language.continueLanguageTransition, {
      transitionId: state.transition._id,
      expectedGeneration: state.transition.generation,
    })
  }
  throw new Error("F09 row 4 did not reach preparation")
}

async function denyBoth(
  readControl: () => Promise<unknown>,
  unrelatedAction: () => Promise<unknown>,
  signedOutAction: () => Promise<unknown>
) {
  await expectConvexDenialWithoutChange(readControl, unrelatedAction, "CMS_OWNER_REQUIRED")
  await expectConvexDenialWithoutChange(readControl, signedOutAction, "UNAUTHENTICATED")
}

/**
 * F09 stage 2 — row 4 plus F01/R2 remedy. Preconditions: stage 1 left current
 * French with no open operation; the owner and unrelated B have real sessions;
 * a French Home is now publishable and the English target editor is test-owned.
 * Row 4 checks start, prepare, confirm, activate and cancel through signed
 * clients: B and signed-out are refused with exact codes, every denial leaves
 * the owner-visible control rows byte-equivalent, and the owner positive action
 * succeeds. The resulting retained French target draft is then deleted only by
 * the guarded post-cancel editor remedy; restart is unblocked and is cancelled.
 * Postcondition: current `en`, no open operation, remedy draft deleted. No Page
 * is purged. The operator owns fixture teardown. Start state:
 * `after-f09-1-row3`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("F09 row 4 denies non-owners and the retained-target remedy unblocks restart", async ({ browser }) => {
  requireDisposableStage("f09", "f09-2-row4-remedy")
  const owner = await ownerPage(browser)
  const unrelatedContext = await browser.newContext({ baseURL: localOrigin() })
  const unrelatedPage = await unrelatedContext.newPage()
  try {
    const ownerClient = await clientFor(owner)
    expect(await ownerClient.query(api.cms.language.getLanguageState, {})).toMatchObject({
      kind: "current",
      currentLocale: "fr",
      enabledLocales: ["fr"],
      transition: null,
    })
    await signIn(unrelatedPage, required("FR6_E2E_B_EMAIL"), required("FR6_E2E_B_PASSWORD"))
    const unrelated = await clientFor(unrelatedPage)
    const signedOut = anonymousClient()
    const homeId = required("FR6_E2E_F09_HOME_ID") as Id<"pages">

    await owner.goto(required("FR6_E2E_F09_HOME_EDITOR"))
    const initialMessages = adminMessages(await adminLocale(owner))
    await owner.getByLabel(initialMessages.editor.page.pageTitle).fill(required("FR6_E2E_F09_FR_MARKER"))
    await owner.getByRole("button", { name: initialMessages.editor.page.save, exact: true }).click()
    await owner.getByRole("button", { name: initialMessages.editor.page.publish, exact: true }).click()
    await expect(owner.getByText(initialMessages.editor.pageSave.published, { exact: true })).toBeVisible()

    let state = await ownerClient.query(api.cms.language.getLanguageState, {})
    const settings = await ownerClient.query(api.cms.settings.getSettings, {})
    if (!settings || state.version === null) throw new Error("F09 start tokens are incomplete")
    const startArgs = {
      mode: "replace_content" as const,
      sourceLocale: "fr",
      targetLocale: "en",
      expectedSettingsUpdatedAt: settings.updatedAt,
      expectedAuthorityVersion: state.version,
    }
    const readPreStart = async () => ({
      state: await ownerClient.query(api.cms.language.getLanguageState, {}),
      page: await ownerClient.query(api.cms.pages.getForEdit, { id: homeId }),
    })
    await denyBoth(
      readPreStart,
      () => unrelated.mutation(api.cms.language.startLanguageTransition, startArgs),
      () => signedOut.mutation(api.cms.language.startLanguageTransition, startArgs)
    )
    await startReplacement(owner, "fr", "en")
    state = await waitForPreparing(ownerClient)
    let row = (await pages(ownerClient)).find((candidate) => candidate.pageId === homeId)
    if (!row || !state.transition) throw new Error("F09 Home transition row missing")

    const dispositionArgs = {
      transitionId: state.transition._id,
      pageId: homeId,
      disposition: "target" as const,
      expectedPageGeneration: row.generation,
    }
    await denyBoth(
      () => control(ownerClient),
      () => unrelated.mutation(api.cms.language.setPageDisposition, dispositionArgs),
      () => signedOut.mutation(api.cms.language.setPageDisposition, dispositionArgs)
    )
    await ownerClient.mutation(api.cms.language.setPageDisposition, dispositionArgs)

    await owner.goto(required("FR6_E2E_F09_EN_TARGET_EDITOR"))
    const targetMessages = adminMessages(await adminLocale(owner))
    await owner.getByLabel(targetMessages.editor.page.pageTitle).fill(required("FR6_E2E_F09_EN_MARKER"))
    await owner.getByRole("button", { name: targetMessages.editor.page.save, exact: true }).click()
    await expect(owner.getByText(targetMessages.editor.pageSave.saved, { exact: true })).toBeVisible()
    row = (await pages(ownerClient)).find((candidate) => candidate.pageId === homeId)
    if (!row || row.targetDraftGeneration === null || row.sharedDraftGeneration === null) {
      throw new Error("F09 target confirmation tokens are incomplete")
    }
    const confirmArgs = {
      transitionId: state.transition._id,
      pageId: homeId,
      expectedTargetDraftGeneration: row.targetDraftGeneration,
      expectedSharedDraftGeneration: row.sharedDraftGeneration,
      expectedPageGeneration: row.generation,
    }
    await denyBoth(
      () => control(ownerClient),
      () => unrelated.mutation(api.cms.language.confirmTargetContent, confirmArgs),
      () => signedOut.mutation(api.cms.language.confirmTargetContent, confirmArgs)
    )
    await ownerClient.mutation(api.cms.language.confirmTargetContent, confirmArgs)
    row = (await pages(ownerClient)).find((candidate) => candidate.pageId === homeId)
    if (!row) throw new Error("F09 Home row disappeared after confirmation")
    const prepareArgs = {
      transitionId: state.transition._id,
      pageId: homeId,
      expectedPageGeneration: row.generation,
    }
    await denyBoth(
      () => control(ownerClient),
      () => unrelated.mutation(api.cms.language.prepareTargetPage, prepareArgs),
      () => signedOut.mutation(api.cms.language.prepareTargetPage, prepareArgs)
    )
    await ownerClient.mutation(api.cms.language.prepareTargetPage, prepareArgs)

    for (const other of await pages(ownerClient)) {
      if (other.pageId === homeId || other.status === "ready") continue
      await ownerClient.mutation(api.cms.language.setPageDisposition, {
        transitionId: state.transition._id,
        pageId: other.pageId,
        disposition: "withdraw",
        expectedPageGeneration: other.generation,
      })
    }
    state = await ownerClient.query(api.cms.language.getLanguageState, {})
    const previewArgs = {
      transitionId: state.transition!._id,
      expectedPreparedSetVersion: state.transition!.preparedSetVersion,
      expectedCarryDecisionDigest: state.transition!.carryDecisionDigest ?? undefined,
    }
    await denyBoth(
      () => control(ownerClient),
      () => unrelated.mutation(api.cms.language.confirmTransitionPreview, previewArgs),
      () => signedOut.mutation(api.cms.language.confirmTransitionPreview, previewArgs)
    )
    await ownerClient.mutation(api.cms.language.confirmTransitionPreview, previewArgs)
    state = await ownerClient.query(api.cms.language.getLanguageState, {})
    await ownerClient.mutation(api.cms.language.validateLanguageTransition, {
      transitionId: state.transition!._id,
      expectedGeneration: state.transition!.generation,
    })
    for (let attempt = 0; attempt < 80; attempt += 1) {
      state = await ownerClient.query(api.cms.language.getLanguageState, {})
      if (state.transition?.phase === "ready") break
      await ownerClient.mutation(api.cms.language.continueLanguageTransition, {
        transitionId: state.transition!._id,
        expectedGeneration: state.transition!.generation,
      })
    }
    state = await ownerClient.query(api.cms.language.getLanguageState, {})
    const readySettings = await ownerClient.query(api.cms.settings.getSettings, {})
    if (!readySettings || !state.transition?.readinessVersion || state.version === null) {
      throw new Error("F09 activation tokens are incomplete")
    }
    const activateArgs = {
      transitionId: state.transition._id,
      expectedGeneration: state.transition.generation,
      expectedAuthorityVersion: state.version,
      expectedSettingsUpdatedAt: readySettings.updatedAt,
      expectedReadinessVersion: state.transition.readinessVersion,
    }
    await denyBoth(
      () => control(ownerClient),
      () => unrelated.mutation(api.cms.language.activateLanguageTransition, activateArgs),
      () => signedOut.mutation(api.cms.language.activateLanguageTransition, activateArgs)
    )
    await ownerClient.mutation(api.cms.language.activateLanguageTransition, activateArgs)
    expect(await ownerClient.query(api.cms.language.getLanguageState, {})).toMatchObject({
      kind: "current",
      currentLocale: "en",
      transition: null,
    })

    await startReplacement(owner, "en", "fr")
    state = await waitForPreparing(ownerClient)
    const blocked = (await pages(ownerClient)).find((candidate) =>
      candidate.pageId === homeId && candidate.blockerCode === "TARGET_LOCALE_HAS_RETAINED_CONTENT"
    )
    if (!blocked || !state.transition) throw new Error("Retained French target did not block")
    const cancelArgs = {
      transitionId: state.transition._id,
      expectedGeneration: state.transition.generation,
      discardTargetDrafts: false,
    }
    await denyBoth(
      () => control(ownerClient),
      () => unrelated.mutation(api.cms.language.cancelLanguageTransition, cancelArgs),
      () => signedOut.mutation(api.cms.language.cancelLanguageTransition, cancelArgs)
    )
    await ownerClient.mutation(api.cms.language.cancelLanguageTransition, cancelArgs)
    for (let attempt = 0; attempt < 80; attempt += 1) {
      state = await ownerClient.query(api.cms.language.getLanguageState, {})
      if (!state.transition) break
      await ownerClient.mutation(api.cms.language.continueLanguageTransition, {
        transitionId: state.transition._id,
        expectedGeneration: state.transition.generation,
      })
    }
    const remedy = await ownerClient.query(api.cms.language.getRetainedTargetDraftRemedy, { pageId: homeId })
    expect(remedy).not.toBeNull()
    await owner.goto(required("FR6_E2E_F09_HOME_EDITOR"))
    const remedyText = await pageTranslator(owner)
    const remedyAction = remedyText("editor.page.retainedTargetRemedy.action", {
      locale: getLocaleDisplayName("fr"),
    })
    // The banner button opens a confirm dialog whose confirm button has the same name.
    await owner.getByRole("button", { name: remedyAction, exact: true }).click()
    await owner.getByRole("button", { name: remedyAction, exact: true }).click()
    await expect(
      owner.getByText(
        remedyText("editor.page.retainedTargetRemedy.deleted", { locale: getLocaleDisplayName("fr") }),
        { exact: true }
      )
    ).toBeVisible()
    expect(await ownerClient.query(api.cms.language.getRetainedTargetDraftRemedy, { pageId: homeId })).toBeNull()

    await startReplacement(owner, "en", "fr")
    state = await waitForPreparing(ownerClient)
    expect((await pages(ownerClient)).some((candidate) => candidate.blockerCode === "TARGET_LOCALE_HAS_RETAINED_CONTENT")).toBe(false)
    const beforeCancel = controlSnapshot(await control(ownerClient))
    await ownerClient.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId: state.transition!._id,
      expectedGeneration: state.transition!.generation,
      discardTargetDrafts: false,
    })
    expect(controlSnapshot(await control(ownerClient))).not.toBe(beforeCancel)
    for (let attempt = 0; attempt < 80; attempt += 1) {
      state = await ownerClient.query(api.cms.language.getLanguageState, {})
      if (!state.transition) break
      await ownerClient.mutation(api.cms.language.continueLanguageTransition, {
        transitionId: state.transition._id,
        expectedGeneration: state.transition.generation,
      })
    }
    expect(await ownerClient.query(api.cms.language.getLanguageState, {})).toMatchObject({
      kind: "current",
      currentLocale: "en",
      transition: null,
    })
  } finally {
    await owner.context().close()
    await unrelatedContext.close()
  }
})
