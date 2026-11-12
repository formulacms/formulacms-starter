/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"

// FR2.0 rev1 §3.2: the starter ships the legacy migration seam as `false`.
// Each negative call below runs against that shipped value and without an
// identity, so the refusal proves the guard runs before auth, reads or writes.
vi.mock("./lib/publishing/legacyMigration", () => ({
  LEGACY_SNAPSHOT_MIGRATION_INSTALLED: false,
}))

const modules = import.meta.glob("./**/*.ts")
const REFUSAL = "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED"

async function setup() {
  const t = convexTest(schema, modules)
  const pageId = await t.run((ctx) =>
    ctx.db.insert("pages", {
      slug: "legacy",
      pageType: "page",
      status: "draft",
      content: {},
      createdAt: 1,
      updatedAt: 1,
    })
  )
  const cutover = () =>
    t.run((ctx) => ctx.db.query("pagePublicationCutover").take(10))
  return { t, pageId, before: await cutover(), cutover }
}

const run = { migrationRunId: "run-1", expectedRevision: 1 }

describe("legacy Published Snapshot migration is not installed", () => {
  test("initializeLegacySnapshotAuthority refuses", async () => {
    const { t, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.initializeLegacySnapshotAuthority, {})
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("normalizeLegacyHomeIdentity refuses", async () => {
    const { t, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.normalizeLegacyHomeIdentity, {
        expectedSettingsUpdatedAt: 1,
      })
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("beginSnapshotMigration refuses", async () => {
    const { t, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.beginSnapshotMigration, run)
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("scanSnapshotMigrationSources refuses", async () => {
    const { t, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.scanSnapshotMigrationSources, run)
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("prepareSnapshotMigrationPage refuses", async () => {
    const { t, pageId, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.prepareSnapshotMigrationPage, {
        migrationRunId: "run-1",
        pageId,
      })
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("finalizeSnapshotMigration refuses", async () => {
    const { t, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.finalizeSnapshotMigration, run)
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("activateSnapshotAuthority refuses", async () => {
    const { t, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.activateSnapshotAuthority, {
        ...run,
        expectedClosureDigest: "digest",
      })
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("abortSnapshotMigrationPage refuses", async () => {
    const { t, pageId, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.abortSnapshotMigrationPage, {
        migrationRunId: "run-1",
        pageId,
      })
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })

  test("finishSnapshotMigrationAbort refuses", async () => {
    const { t, before, cutover } = await setup()
    await expect(
      t.mutation(api.cms.publication.finishSnapshotMigrationAbort, run)
    ).rejects.toThrow(REFUSAL)
    expect(await cutover()).toEqual(before)
  })
})
