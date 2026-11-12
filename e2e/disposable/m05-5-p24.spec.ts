import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import type { ConvexHttpClient } from "convex/browser"
import {
  clientFor,
  controlSnapshot,
  expectConvexDenialWithoutChange,
  getLocaleDisplayName,
  ownerPage,
  pageTranslator,
  requireDisposableStage,
  required,
} from "../support"

type TransitionPage = Awaited<ReturnType<typeof transitionPages>>[number]

function pageIdFromEditor(editor: string): Id<"pages"> {
  const match = /\/admin\/pages\/([^/?#]+)/.exec(editor)
  if (!match?.[1]) throw new Error(`Invalid Page editor path: ${editor}`)
  return decodeURIComponent(match[1]) as Id<"pages">
}

async function startReplacement(page: Page, source: string, target: string) {
  await page.goto("/admin/settings/languages")
  await page
    .getByRole("combobox", { name: (await pageTranslator(page))("settings.languages.newLanguage") })
    .selectOption(target)
  await page.getByLabel((await pageTranslator(page))("settings.languages.modes.replace_content.title")).click()
  await page.getByRole("button", { name: (await pageTranslator(page))("settings.languages.start"), exact: true }).click()
  const heading = (await pageTranslator(page))(
    "settings.languages.progressHeading",
    { source: getLocaleDisplayName(source), target: getLocaleDisplayName(target) }
  )
  await expect(
    page.getByRole("heading", { name: heading, exact: true })
  ).toBeVisible()
}

async function transitionPages(client: ConvexHttpClient) {
  const state = await client.query(api.cms.language.getLanguageState, {})
  const transition = state.transition
  if (!transition) throw new Error("No open F09 transition")
  const rows: Array<
    (typeof api.cms.language.listLanguageTransitionPages)["_returnType"]["page"][number]
  > = []
  let cursor: string | null = null
  do {
    const result: (typeof api.cms.language.listLanguageTransitionPages)["_returnType"] =
      await client.query(api.cms.language.listLanguageTransitionPages, {
        transitionId: transition._id,
        paginationOpts: { cursor, numItems: 10 },
      })
    rows.push(...result.page)
    cursor = result.isDone ? null : result.continueCursor
  } while (cursor !== null)
  return rows
}

async function continueTransition(client: ConvexHttpClient) {
  const state = await client.query(api.cms.language.getLanguageState, {})
  if (!state.transition) throw new Error("No transition to continue")
  await client.mutation(api.cms.language.continueLanguageTransition, {
    transitionId: state.transition._id,
    expectedGeneration: state.transition.generation,
  })
}

async function waitForPreparing(client: ConvexHttpClient) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await client.query(api.cms.language.getLanguageState, {})
    if (
      state.transition?.phase === "preparing" ||
      state.transition?.phase === "ready"
    )
      return state.transition
    await continueTransition(client)
  }
  throw new Error("F09 transition did not reach preparation")
}

async function pageRow(client: ConvexHttpClient, pageId: Id<"pages">) {
  const row = (await transitionPages(client)).find(
    (candidate) => candidate.pageId === pageId
  )
  if (!row) throw new Error(`Transition row missing for ${pageId}`)
  return row
}

async function setDisposition(
  client: ConvexHttpClient,
  row: TransitionPage,
  disposition: "target" | "withdraw"
) {
  if (row.disposition === disposition) return row
  const state = await client.query(api.cms.language.getLanguageState, {})
  if (!state.transition) throw new Error("No transition for disposition")
  await client.mutation(api.cms.language.setPageDisposition, {
    transitionId: state.transition._id,
    pageId: row.pageId,
    disposition,
    expectedPageGeneration: row.generation,
  })
  return pageRow(client, row.pageId)
}

function retainedBasis(row: TransitionPage): "retained_snapshot" | "draft" {
  if (row.retainedTarget?.selection) return "retained_snapshot"
  if (row.retainedTarget?.workingDraft) return "draft"
  throw new Error(`Retained target ${row.pageId} has no reviewable content`)
}

async function decideRetainedTarget(
  client: ConvexHttpClient,
  row: TransitionPage,
  disposition: "target" | "withdraw"
) {
  const retained = row.retainedTarget
  if (!retained)
    throw new Error(
      `Transition row ${row.pageId} has no retained target review`
    )
  const state = await client.query(api.cms.language.getLanguageState, {})
  if (!state.transition)
    throw new Error("No transition for retained target decision")
  await client.mutation(api.cms.language.setPageDisposition, {
    transitionId: state.transition._id,
    pageId: row.pageId,
    disposition,
    expectedPageGeneration: row.generation,
    retainedTargetReview: {
      digest: retained.reviewDigest,
      basis: retainedBasis(row),
    },
  })
  return pageRow(client, row.pageId)
}

async function adoptRetainedTargetThroughUi(
  page: Page,
  client: ConvexHttpClient,
  row: TransitionPage
) {
  const retained = row.retainedTarget
  if (!retained)
    throw new Error(
      `Transition row ${row.pageId} has no retained target review`
    )
  const label = row.sourcePath ?? row.sourceSlug
  if (!label) throw new Error(`Transition row ${row.pageId} has no UI label`)
  await page.goto("/admin/settings/languages")
  const card = page.getByTestId("language-transition-page").filter({
    has: page.getByText(label, { exact: true }),
  })
  await expect(card).toHaveCount(1)
  await card
    .getByRole("button", {
      name: retained.selection
        ? (await pageTranslator(page))("settings.languages.page.retained.usePublished")
        : (await pageTranslator(page))("settings.languages.page.retained.prepareDraft"),
    })
    .click()
  await expect
    .poll(async () => {
      const current = await pageRow(client, row.pageId)
      return (
        current.disposition === "target" &&
        current.retainedTarget?.decisionCurrent
      )
    })
    .toBe(true)
  return pageRow(client, row.pageId)
}

async function prepareTarget(client: ConvexHttpClient, input: TransitionPage) {
  let row = input.retainedTarget
    ? input.disposition === "target" && input.retainedTarget.decisionCurrent
      ? input
      : await decideRetainedTarget(client, input, "target")
    : await setDisposition(client, input, "target")
  const state = await client.query(api.cms.language.getLanguageState, {})
  if (!state.transition) throw new Error("No transition for target preparation")
  if (
    row.retainedTarget?.decisionBasis === "retained_snapshot" &&
    row.retainedTarget.decisionCurrent
  ) {
    const prepared = await client.mutation(api.cms.language.prepareTargetPage, {
      transitionId: state.transition._id,
      pageId: row.pageId,
      expectedPageGeneration: row.generation,
    })
    row = await pageRow(client, row.pageId)
    expect(row.generation).toBe(prepared.generation)
    expect(row.status).toBe("ready")
    return row
  }
  if (
    row.targetDraftGeneration === null ||
    row.sharedDraftGeneration === null ||
    row.lifecycleGeneration === null
  ) {
    throw new Error(
      `P24 target fixture ${row.pageId} has no retained target/shared draft`
    )
  }
  const confirmed = await client.mutation(
    api.cms.language.confirmTargetContent,
    {
      transitionId: state.transition._id,
      pageId: row.pageId,
      expectedTargetDraftGeneration: row.targetDraftGeneration,
      expectedSharedDraftGeneration: row.sharedDraftGeneration,
      expectedPageGeneration: row.generation,
    }
  )
  row = await pageRow(client, row.pageId)
  expect(row.generation).toBe(confirmed.generation)
  const prepared = await client.mutation(api.cms.language.prepareTargetPage, {
    transitionId: state.transition._id,
    pageId: row.pageId,
    expectedPageGeneration: row.generation,
  })
  row = await pageRow(client, row.pageId)
  expect(row.generation).toBe(prepared.generation)
  expect(row.status).toBe("ready")
  return row
}

async function decisions(client: ConvexHttpClient) {
  const state = await client.query(api.cms.language.getLanguageState, {})
  if (!state.transition) throw new Error("No transition for carry decisions")
  const rows: Array<{ fromPath: string; outcome: string }> = []
  let cursor: string | null = null
  do {
    const result: (typeof api.cms.language.listLanguageCarryDecisions)["_returnType"] =
      await client.query(api.cms.language.listLanguageCarryDecisions, {
        transitionId: state.transition._id,
        paginationOpts: { cursor, numItems: 2 },
        filter: "all" as const,
      })
    rows.push(...result.page)
    cursor = result.isDone ? null : result.continueCursor
  } while (cursor !== null)
  return rows
}

async function waitForOutcome(
  client: ConvexHttpClient,
  path: string,
  outcome: string
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rows = await decisions(client)
    if (rows.some((row) => row.fromPath === path && row.outcome === outcome))
      return rows
    await continueTransition(client)
  }
  throw new Error(`No ${outcome} carry decision for ${path}`)
}

async function waitForDecisionChange(
  client: ConvexHttpClient,
  previousDigest: string,
  path: string,
  outcome: string
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await client.query(api.cms.language.getLanguageState, {})
    const rows = await decisions(client)
    if (
      state.transition?.carryDecisionDigest &&
      state.transition.carryDecisionDigest !== previousDigest &&
      rows.some((row) => row.fromPath === path && row.outcome === outcome)
    )
      return { state, rows }
    await continueTransition(client)
  }
  throw new Error(`Carry decision did not change to ${outcome} for ${path}`)
}

async function waitForSourceVersionAndStableDigest(
  client: ConvexHttpClient,
  previousSourceVersion: number,
  expectedDigest: string
) {
  let continuedAfterSourceMove = false
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await client.query(api.cms.language.getLanguageState, {})
    if (
      state.transition &&
      state.transition.sourcePublicSetVersion > previousSourceVersion &&
      state.transition.carryDecisionDigest === expectedDigest &&
      continuedAfterSourceMove
    )
      return state
    if (
      state.transition &&
      state.transition.sourcePublicSetVersion > previousSourceVersion
    ) {
      continuedAfterSourceMove = true
    }
    await continueTransition(client)
  }
  throw new Error(
    "Retired carry decision did not remain stable after source withdrawal"
  )
}

/**
 * M05 stage 5 — P24. Preconditions: stage 4 left module-off S1 with the
 * pointed round-trip generation, current locale `en`, retained `fr` target
 * drafts, and fixture rows that produce carry, locale/claim/disposition/
 * retired/duplicate drops. The stage starts the UI-reachable F09 `en -> fr`
 * replacement, adopts the retained French fixtures through the owner review
 * controls and API, prepares the stage-6 dependencies, exercises
 * carry-to-drop and drop-to-carry re-decision, proves bare confirmation is
 * stable, forces reconfirmation with a source publication, activates, and
 * probes the carried redirect. It then starts and cancels one second transition
 * to prove the committed operation left no pointed carry corpus. Postcondition:
 * single-language `fr`, module off, no open operation. No fixture is purged.
 * Start state: `after-m05-4-removal-disable`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("M05 stage 5 carries continuity through F09 and reconciles every reachable P24 outcome", async ({
  browser,
  request,
}) => {
  requireDisposableStage("m05", "m05-5-p24")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    const initial = await client.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    expect(initial).toMatchObject({
      lifecycleState: "S1",
      moduleEnabled: false,
      defaultLocale: "en",
      enabledLocales: ["en"],
      openOperation: null,
    })
    expect(
      await client.query(api.cms.language.getLanguageState, {})
    ).toMatchObject({
      kind: "current",
      currentLocale: "en",
      enabledLocales: ["en"],
      transition: null,
    })
    await startReplacement(owner, "en", "fr")
    const transition = await waitForPreparing(client)
    const carryPageId = required("FR6_E2E_P24_PAGE_ID") as Id<"pages">
    const carryPath = required("FR6_E2E_P24_CARRY_PATH")
    const retirePageId = required("FR6_E2E_P24_RETIRE_PAGE_ID") as Id<"pages">
    const retirePath = required("FR6_E2E_P24_RETIRE_PATH")
    const mainPageId = pageIdFromEditor(required("FR6_E2E_M05_PAGE_EDITOR"))
    const relationTargetPageId = pageIdFromEditor(
      required("FR6_E2E_M05_RELATION_TARGET_EDITOR")
    )
    const relationSourcePageId = pageIdFromEditor(
      required("FR6_E2E_M05_RELATION_SOURCE_EDITOR")
    )

    const initialRows = await transitionPages(client)
    expect(initialRows.length).toBeGreaterThan(1)
    const targetPageIds = [
      mainPageId,
      relationTargetPageId,
      relationSourcePageId,
      carryPageId,
      retirePageId,
    ].filter((pageId, index, pageIds) => pageIds.indexOf(pageId) === index)
    for (const pageId of targetPageIds) {
      const initialRow = initialRows.find((row) => row.pageId === pageId)
      if (!initialRow)
        throw new Error(`Required retained target row missing for ${pageId}`)
      const reviewed =
        pageId === mainPageId
          ? await adoptRetainedTargetThroughUi(owner, client, initialRow)
          : initialRow
      await prepareTarget(client, reviewed)
    }
    for (const row of initialRows) {
      if (targetPageIds.includes(row.pageId)) continue
      if (row.retainedTarget)
        await decideRetainedTarget(client, row, "withdraw")
      else await setDisposition(client, row, "withdraw")
    }
    await waitForOutcome(client, carryPath, "carry")
    expect(await waitForOutcome(client, retirePath, "carry")).toContainEqual({
      fromPath: retirePath,
      outcome: "carry",
    })
    for (const [name, outcome] of [
      ["FR6_E2E_P24_DROP_LOCALE_PATH", "drop_locale"],
      ["FR6_E2E_P24_DROP_CLAIMED_PATH", "drop_claimed"],
      ["FR6_E2E_P24_DROP_DISPOSITION_PATH", "drop_disposition"],
      ["FR6_E2E_P24_DROP_DUPLICATE_PATH", "drop_duplicate"],
    ] as const) {
      expect(
        await waitForOutcome(client, required(name), outcome)
      ).toContainEqual({
        fromPath: required(name),
        outcome,
      })
    }

    let state = await client.query(api.cms.language.getLanguageState, {})
    if (!state.transition?.carryDecisionDigest)
      throw new Error("P24 retirement digest is missing")
    const beforeRetirementDigest = state.transition.carryDecisionDigest
    await owner.goto(required("FR6_E2E_P24_RETIRE_PAGE_EDITOR"))
    await owner
      .getByRole("tab", { name: required("FR6_E2E_M05_EN_TAB") })
      .click()
    await owner
      .getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true })
      .click()
    await expect(
      owner.getByText((await pageTranslator(owner))("editor.pageSave.published"), { exact: true })
    ).toBeVisible()
    const retired = await waitForDecisionChange(
      client,
      beforeRetirementDigest,
      retirePath,
      "drop_retired"
    )
    const retiredDigest = retired.state.transition!.carryDecisionDigest!
    const retiredSourceVersion =
      retired.state.transition!.sourcePublicSetVersion
    await owner
      .getByRole("button", { name: (await pageTranslator(owner))("editor.page.moreActions") })
      .click()
    await owner
      .getByRole("menuitem", { name: (await pageTranslator(owner))("editor.page.unpublish") })
      .click()
    await owner
      .getByRole("alertdialog")
      .getByRole("button", {
        name: (await pageTranslator(owner))("pages.list.unpublish.confirm"),
        exact: true,
      })
      .click()
    await expect(
      owner.getByText((await pageTranslator(owner))("editor.pageSave.unpublished"), { exact: true })
    ).toBeVisible()
    await waitForSourceVersionAndStableDigest(
      client,
      retiredSourceVersion,
      retiredDigest
    )
    expect(await decisions(client)).toContainEqual({
      fromPath: retirePath,
      outcome: "drop_retired",
    })

    state = await client.query(api.cms.language.getLanguageState, {})
    if (!state.transition?.carryDecisionDigest)
      throw new Error("P24 carry digest is missing")
    const decisionBeforeConfirm = controlSnapshot(await decisions(client))
    await client.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId: state.transition._id,
      expectedPreparedSetVersion: state.transition.preparedSetVersion,
      expectedCarryDecisionDigest: state.transition.carryDecisionDigest,
    })
    state = await client.query(api.cms.language.getLanguageState, {})
    expect(controlSnapshot(await decisions(client))).toBe(decisionBeforeConfirm)
    expect(state.transition?.previewConfirmedCarryDecisionDigest).toBe(
      state.transition?.carryDecisionDigest
    )

    const confirmedDispositionDigest = state.transition!.carryDecisionDigest!
    let carryRow = await pageRow(client, carryPageId)
    carryRow = await setDisposition(client, carryRow, "withdraw")
    state = (
      await waitForDecisionChange(
        client,
        confirmedDispositionDigest,
        carryPath,
        "drop_disposition"
      )
    ).state
    const dropped = await request.get(carryPath, {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect([200, 404]).toContain(dropped.status())
    expect(dropped.headers().location).toBeUndefined()
    await expectConvexDenialWithoutChange(
      () => client.query(api.cms.language.getLanguageState, {}),
      () =>
        client.mutation(api.cms.language.validateLanguageTransition, {
          transitionId: state.transition!._id,
          expectedGeneration: state.transition!.generation,
        }),
      "LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED"
    )
    const droppedDigest = state.transition!.carryDecisionDigest!
    await prepareTarget(client, carryRow)
    state = (
      await waitForDecisionChange(client, droppedDigest, carryPath, "carry")
    ).state
    await client.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId: state.transition!._id,
      expectedPreparedSetVersion: state.transition!.preparedSetVersion,
      expectedCarryDecisionDigest:
        state.transition!.carryDecisionDigest ?? undefined,
    })

    state = await client.query(api.cms.language.getLanguageState, {})
    const confirmedPreparedVersion = state.transition!.preparedSetVersion
    const confirmedDigest = state.transition!.carryDecisionDigest
    await owner.goto(required("FR6_E2E_P24_PAGE_EDITOR"))
    await owner
      .getByRole("tab", { name: required("FR6_E2E_M05_EN_TAB") })
      .click()
    await owner
      .getByLabel((await pageTranslator(owner))("editor.page.pageTitle"))
      .fill(`FR6 P24 source ${Date.now()}`)
    await owner
      .getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true })
      .click()
    await owner
      .getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true })
      .click()
    await expect(
      owner.getByText((await pageTranslator(owner))("editor.pageSave.published"), { exact: true })
    ).toBeVisible()
    state = (
      await waitForDecisionChange(client, confirmedDigest!, carryPath, "carry")
    ).state
    expect(state.transition?.preparedSetVersion).toBe(confirmedPreparedVersion)
    expect(state.transition?.carryDecisionDigest).not.toBe(confirmedDigest)
    await expectConvexDenialWithoutChange(
      () => client.query(api.cms.language.getLanguageState, {}),
      () =>
        client.mutation(api.cms.language.validateLanguageTransition, {
          transitionId: state.transition!._id,
          expectedGeneration: state.transition!.generation,
        }),
      "LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED"
    )

    state = await client.query(api.cms.language.getLanguageState, {})
    await client.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId: state.transition!._id,
      expectedPreparedSetVersion: state.transition!.preparedSetVersion,
      expectedCarryDecisionDigest:
        state.transition!.carryDecisionDigest ?? undefined,
    })
    state = await client.query(api.cms.language.getLanguageState, {})
    await client.mutation(api.cms.language.validateLanguageTransition, {
      transitionId: state.transition!._id,
      expectedGeneration: state.transition!.generation,
    })
    for (let attempt = 0; attempt < 80; attempt += 1) {
      state = await client.query(api.cms.language.getLanguageState, {})
      if (state.transition?.phase === "ready") break
      await continueTransition(client)
    }
    state = await client.query(api.cms.language.getLanguageState, {})
    expect(state.transition?.phase).toBe("ready")
    const settings = await client.query(api.cms.settings.getSettings, {})
    if (
      !settings ||
      !state.transition?.readinessVersion ||
      state.version === null
    ) {
      throw new Error("P24 activation tokens are incomplete")
    }
    await client.mutation(api.cms.language.activateLanguageTransition, {
      transitionId: state.transition._id,
      expectedGeneration: state.transition.generation,
      expectedAuthorityVersion: state.version,
      expectedSettingsUpdatedAt: settings.updatedAt,
      expectedReadinessVersion: state.transition.readinessVersion,
    })
    state = await client.query(api.cms.language.getLanguageState, {})
    expect(state).toMatchObject({
      kind: "current",
      currentLocale: "fr",
      transition: null,
    })
    const carried = await request.get(carryPath, {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(carried.status()).toBe(307)
    expect(carried.headers().location).toBe(
      required("FR6_E2E_P24_CARRY_DESTINATION")
    )

    const currentSettings = await client.query(api.cms.settings.getSettings, {})
    if (!currentSettings || state.version === null)
      throw new Error("No settings for pointer-clear probe")
    const pointerProbeId = await client.mutation(
      api.cms.language.startLanguageTransition,
      {
        mode: "replace_content",
        sourceLocale: "fr",
        targetLocale: "en",
        expectedSettingsUpdatedAt: currentSettings.updatedAt,
        expectedAuthorityVersion: state.version,
      }
    )
    await waitForPreparing(client)
    expect(
      await client.query(api.cms.language.listLanguageCarryDecisions, {
        transitionId: pointerProbeId,
        paginationOpts: { cursor: null, numItems: 10 },
        filter: "all",
      })
    ).toMatchObject({ page: [], isDone: true })
    state = await client.query(api.cms.language.getLanguageState, {})
    await client.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId: pointerProbeId,
      expectedGeneration: state.transition!.generation,
      discardTargetDrafts: false,
    })
    for (let attempt = 0; attempt < 80; attempt += 1) {
      state = await client.query(api.cms.language.getLanguageState, {})
      if (!state.transition) break
      await continueTransition(client)
    }
    expect(
      (await client.query(api.cms.language.getLanguageState, {})).transition
    ).toBeNull()
    expect(transition._id).not.toBe(pointerProbeId)
  } finally {
    await owner.context().close()
  }
})
