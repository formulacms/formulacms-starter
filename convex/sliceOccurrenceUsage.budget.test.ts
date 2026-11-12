import { createSampleSlice } from "@/convex/lib/slices/sample"
/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { writeFile } from "node:fs/promises"
import { getConvexSize } from "convex/values"
import migrationsTest from "@convex-dev/migrations/test"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { convexTest } from "../convexTestWithExplicitAdmin"

import { readSlicePresentationCatalog } from "./lib/slices/presentations"
import {
  saveLocaleDraft,
  publishLocale,
  restoreSnapshotAsDraft,
} from "./cms/publication"

// Convex-test uses this same registered-handler hook internally. Published
// declarations strip @internal properties, so isolate the test-only assertion.
function registeredHandler<
  Reference extends import("convex/server").FunctionReference<
    "mutation" | "query",
    "public" | "internal"
  >,
>(
  registered: object,
  reference: Reference
): (
  ctx: import("./_generated/server").MutationCtx,
  args: import("convex/server").FunctionArgs<Reference>
) => Promise<import("convex/server").FunctionReturnType<Reference>> {
  void reference
  return (
    registered as unknown as {
      _handler: (
        ctx: import("./_generated/server").MutationCtx,
        args: import("convex/server").FunctionArgs<Reference>
      ) => Promise<import("convex/server").FunctionReturnType<Reference>>
    }
  )._handler
}
const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "occurrence-budget-owner",
  tokenIdentifier: "https://convex.test|occurrence-budget-owner",
}
const phase = process.env.FORMULACMS_OCCURRENCE_BUDGET_PHASE ?? "head"
const WORDS =
  "A useful service guide gives people clear choices and practical examples in their own language before publication".split(
    " "
  )
const articleText = Array.from(
  { length: 2520 },
  (_, i) => WORDS[i % WORDS.length]
).join(" ")
function slices(round = 0) {
  const sample = createSampleSlice("hero-with-image")
  return [
    {
      ...sample,
      id: `hero-${round}`,
      presentationIdV1: "centered",
      items: sample.items.map((item, i) => ({
        ...item,
        itemId: `budget-button-${i}`,
      })),
    },
    {
      id: `article-${round}`,
      type: "rich-text-body" as const,
      enabled: true,
      primary: {
        body: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: articleText }],
            },
          ],
        }),
      },
    },
  ]
}
async function fixture() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  migrationsTest.register(t)
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "Budget",
    timezone: "UTC",
    defaultLocale: "en",
  })
  const initial = await owner.query(
    api.cms.multilingual.getMultilingualState,
    {}
  )
  await owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: initial.moduleConfigurationVersion,
    changes: [{ moduleId: "multilingual", enabled: true }],
  })
  const preview = await owner.query(api.cms.multilingual.previewAdoption, {})
  if (!preview.canAdopt) throw new Error(preview.blockerCode)
  const { canAdopt, defaultLocale, enabledLocales, ...adoption } = preview
  void canAdopt
  void defaultLocale
  void enabledLocales
  await owner.mutation(
    api.cms.multilingual.adoptMultilingualAuthority,
    adoption
  )
  const enabled = await owner.query(
    api.cms.multilingual.getMultilingualState,
    {}
  )
  await owner.mutation(api.cms.multilingual.addLanguage, {
    locale: "fr",
    expectedAuthorityVersion: enabled.version!,
    expectedModuleConfigurationVersion: enabled.moduleConfigurationVersion,
  })
  const revision = (await readSlicePresentationCatalog()).revision
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    slug: "budget",
    status: "draft",
    title: "Budget",
    expectedPresentationCatalogRevision: revision,
    content: {
      en: { title: "Budget", slices: slices() },
      fr: { title: "Budget français", slices: slices() },
    },
  })
  // Other Pages are unrelated to the mutation. Project every body read to the
  // cap, so an accidental global walk is still charged even for empty fixtures.
  await t.run(async (ctx) => {
    for (let i = 0; i < 498; i++)
      await ctx.db.insert("pages", {
        pageType: "landing-page",
        slug: `unrelated-${i}`,
        status: "draft",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: OWNER.tokenIdentifier,
        content: {
          en: { title: "Unrelated", slices: [] },
          fr: { title: "Sans rapport", slices: [] },
        },
      })
  })
  async function generations() {
    return t.run(async (ctx) => ({
      locale: (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique())!,
      page: (await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!,
      shared: (await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!,
    }))
  }
  async function saveArgs(round = 0) {
    const g = await generations()
    return {
      pageId,
      locale: "en",
      expectedDraftGeneration: g.locale.draftGeneration,
      expectedLifecycleGeneration: g.page.lifecycleGeneration,
      expectedPresentationCatalogRevision: revision,
      slug: "budget",
      draft: {
        pageType: "landing-page" as const,
        localized: { title: "Budget" },
        slices: slices(round),
      },
    }
  }
  async function publishArgs() {
    const g = await generations()
    return {
      pageId,
      locale: "en",
      expectedDraftGeneration: g.locale.draftGeneration,
      expectedSharedDraftGeneration: g.shared.generation,
      expectedPublicGeneration: g.locale.publicGeneration,
      expectedReleaseGeneration: g.locale.releaseGeneration,
      expectedLifecycleGeneration: g.page.lifecycleGeneration,
    }
  }
  return { t, owner, pageId, generations, saveArgs, publishArgs }
}

type Db = import("./_generated/server").MutationCtx["db"]
type BudgetReceipt = {
  documentsRead: number
  approximateBytesRead: number
  documentsWritten: number
  approximateBytesWritten: number
  indexRanges: number
  readTables: string[]
  contentReadEvents: { table: string; measuredBytes: number }[]
  contentWriteEvents: { table: string; measuredBytes: number }[]
}
function measuredDb(db: Db, failCounterWrite = false) {
  const receipt: BudgetReceipt = {
    documentsRead: 0,
    approximateBytesRead: 0,
    documentsWritten: 0,
    approximateBytesWritten: 0,
    indexRanges: 0,
    readTables: [],
    contentReadEvents: [],
    contentWriteEvents: [],
  }
  const contentTables = new Set([
    "pages",
    "pageStaging",
    "pageLocaleDrafts",
    "pageSharedDrafts",
    "pageLocalePublicationCandidates",
    "pagePublishedSnapshots",
  ])
  const cached = new Map<string, Record<string, unknown>>()
  const tableNames = Object.keys(
    schema.tables
  ) as (keyof typeof schema.tables)[]
  function tableFor(id: unknown) {
    if (typeof id !== "string") return "unknown"
    return tableNames.find((name) => db.normalizeId(name, id)) ?? "unknown"
  }
  const bytes = (value: unknown) =>
    getConvexSize(value as import("convex/values").Value)
  function read(value: unknown, table: string) {
    receipt.readTables.push(table)
    if (Array.isArray(value)) {
      for (const row of value) read(row, table)
      return
    }
    if (value && typeof value === "object" && "page" in value) {
      read((value as { page: unknown }).page, table)
      return
    }
    receipt.documentsRead++
    if (value && typeof value === "object") {
      const doc = value as Record<string, unknown>
      const size = bytes(doc)
      receipt.approximateBytesRead += size
      if (contentTables.has(table))
        receipt.contentReadEvents.push({ table, measuredBytes: size })
      if (typeof doc._id === "string") cached.set(doc._id, { ...doc })
    }
  }
  function queryBuilder(builder: object, table: string): object {
    return new Proxy(builder, {
      get(target, property, receiver) {
        const original: unknown = Reflect.get(target, property, receiver)
        if (typeof original !== "function") return original
        if (property === Symbol.asyncIterator)
          return () => {
            const iterator = Reflect.apply(
              original,
              target,
              []
            ) as AsyncIterator<unknown>
            return {
              async next() {
                const result = await iterator.next()
                if (!result.done) read(result.value, table)
                return result
              },
              ...(iterator.return
                ? { return: iterator.return.bind(iterator) }
                : {}),
              ...(iterator.throw
                ? { throw: iterator.throw.bind(iterator) }
                : {}),
            }
          }
        if (
          ["first", "unique", "take", "collect", "paginate"].includes(
            String(property)
          )
        )
          return async (...args: unknown[]) => {
            const result: unknown = await Reflect.apply(original, target, args)
            read(result, table)
            return result
          }
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(original, target, args)
          return result && typeof result === "object"
            ? queryBuilder(result, table)
            : result
        }
      },
    })
  }
  const writer = new Proxy(db, {
    get(target, property, receiver) {
      const original: unknown = Reflect.get(target, property, receiver)
      if (typeof original !== "function") return original
      if (property === "query")
        return (...args: unknown[]) => {
          receipt.indexRanges++
          return queryBuilder(
            Reflect.apply(original, target, args),
            String(args[0])
          )
        }
      if (property === "get")
        return async (...args: unknown[]) => {
          receipt.indexRanges++
          const result: unknown = await Reflect.apply(original, target, args)
          read(result, args.length > 1 ? String(args[0]) : tableFor(args[0]))
          return result
        }
      if (["insert", "patch", "replace", "delete"].includes(String(property)))
        return async (...args: unknown[]) => {
          const explicit =
            args.length === 3 ||
            property === "insert" ||
            (property === "delete" && args.length === 2)
          const id =
            property === "insert" ? undefined : String(args[explicit ? 1 : 0])
          const table = explicit ? String(args[0]) : tableFor(id)
          if (failCounterWrite && table === "sliceOccurrenceCounts")
            throw new Error("injected-counter-write-failure")
          const result: unknown = await Reflect.apply(original, target, args)
          const key = id ?? String(result)
          const patch =
            property === "delete"
              ? undefined
              : (args.at(-1) as Record<string, unknown>)
          let value =
            property === "patch" ? { ...cached.get(key), ...patch } : patch
          if (value)
            value = Object.fromEntries(
              Object.entries(value).filter(([, item]) => item !== undefined)
            )
          receipt.documentsWritten++
          const size = bytes(value ?? cached.get(key) ?? key)
          receipt.approximateBytesWritten += size
          if (contentTables.has(table))
            receipt.contentWriteEvents.push({ table, measuredBytes: size })
          if (value)
            cached.set(key, {
              ...value,
              _id: key,
              _creationTime: cached.get(key)?._creationTime ?? 0,
            })
          if (property === "delete") cached.delete(key)
          return result
        }
      return original.bind(target)
    },
  })
  return { writer, receipt }
}

function projected(receipt: BudgetReceipt) {
  const cap = 512 * 1024
  return {
    label: "projected" as const,
    documentsRead: receipt.documentsRead,
    documentsWritten: receipt.documentsWritten,
    indexRanges: receipt.indexRanges,
    approximateBytesRead:
      receipt.approximateBytesRead +
      receipt.contentReadEvents.reduce(
        (sum, event) => sum + Math.max(0, cap - event.measuredBytes),
        0
      ),
    approximateBytesWritten:
      receipt.approximateBytesWritten +
      receipt.contentWriteEvents.reduce(
        (sum, event) => sum + Math.max(0, cap - event.measuredBytes),
        0
      ),
  }
}
function checked(receipt: BudgetReceipt) {
  const measured = {
    label: "measured" as const,
    ...receipt,
    readTables: [...new Set(receipt.readTables)].sort(),
  }
  const projection = projected(receipt)
  console.info(
    "BUDGET",
    JSON.stringify({ phase, measured, projected: projection })
  )
  for (const value of [measured, projection]) {
    expect(value.documentsRead).toBeLessThanOrEqual(16000)
    expect(value.documentsWritten).toBeLessThanOrEqual(8000)
    expect(value.indexRanges).toBeLessThanOrEqual(2048)
    expect(value.approximateBytesRead).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(value.approximateBytesWritten).toBeLessThanOrEqual(8 * 1024 * 1024)
  }
  return { measured, projected: projection }
}

describe("real occurrence consumer transaction budgets", () => {
  test("same wrapper measures real save/publish/Restore, with explicit 512KiB projection", { ...sliceProfile(["hero-with-image","rich-text-body"]), timeout: 60_000 }, async () => {
    const f = await fixture()
    const saveMeasurement = measuredDb
    const report: Record<string, unknown> = {
      phase,
      labels: {
        measured:
          "ctx.db operation counts; native getConvexSize bytes, excluding provider index/storage overhead",
        projected:
          "same docs/ranges, each content-bearing read/write rounded up to512KiB; accounting rows kept at measured size",
      },
      projectionFormula:
        "bytesProjected = bytesMeasured + SUM(max(0, 524288 - measuredBytes(event))) over content-bearing document events; docs and ranges unchanged",
      input: {
        mode: "M05 EN/FR",
        pages: 500,
        pageIdentities: 500,
        slicesPerLocalizedPage: 2,
        articleWords: articleText.split(/\s+/).length,
        unrelatedPages: 498,
        unrelatedPageBodies: "empty; any read is still projected to512KiB",
        configuredBackfillBatchSize: 1,
      },
      limits: {
        bytesRead: 16 * 1024 * 1024,
        bytesWritten: 16 * 1024 * 1024,
        documentsRead: 32000,
        documentsWritten: 16000,
        indexRanges: 4096,
      },
      stopFraction: 0.5,
    }
    const saveInput = await f.saveArgs()
    let saveReceipt!: BudgetReceipt
    await f.owner.mutation(async (ctx) => {
      const probe = saveMeasurement(ctx.db)
      saveReceipt = probe.receipt
      return registeredHandler(
        saveLocaleDraft,
        api.cms.publication.saveLocaleDraft
      )({ ...ctx, db: probe.writer }, saveInput)
    })
    report.save = checked(saveReceipt)
    const publishInput = await f.publishArgs()
    let publishReceipt!: BudgetReceipt
    const published = await f.owner.mutation(async (ctx) => {
      const probe = measuredDb(ctx.db)
      publishReceipt = probe.receipt
      return registeredHandler(
        publishLocale,
        api.cms.publication.publishLocale
      )({ ...ctx, db: probe.writer }, publishInput)
    })
    report.publish = checked(publishReceipt)
    const g = await f.generations()
    const restoreInput = {
      pageId: f.pageId,
      locale: "en",
      snapshotId: published.snapshotId,
      expectedDraftGeneration: g.locale.draftGeneration,
      expectedSharedDraftGeneration: g.shared.generation,
      expectedLifecycleGeneration: g.page.lifecycleGeneration,
      expectedPublicGeneration: g.locale.publicGeneration,
      expectedReleaseGeneration: g.locale.releaseGeneration,
    }
    let restoreReceipt!: BudgetReceipt
    await f.owner.mutation(async (ctx) => {
      const probe = measuredDb(ctx.db)
      restoreReceipt = probe.receipt
      return registeredHandler(
        restoreSnapshotAsDraft,
        api.cms.publication.restoreSnapshotAsDraft
      )({ ...ctx, db: probe.writer }, restoreInput)
    })
    report.Restore = checked(restoreReceipt)
    if (phase === "head") {
      const { beginSliceOccurrenceMaintenance } =
        await import("./lib/publishing/staging")
      const { backfillSliceOccurrenceCandidates } =
        await import("./lib/publishing/staging")
      // A canonical pre-index dataset: remove only derived fixture rows.
      await f.t.run(async (ctx) => {
        for (const table of [
          "sliceOccurrenceSourceMembers",
          "sliceOccurrenceSources",
          "sliceOccurrenceUsage",
          "sliceOccurrenceCounts",
          "sliceOccurrenceCountState",
        ] as const)
          for (const row of await ctx.db.query(table).collect())
            await ctx.db.delete(row._id)
      })
      await f.owner.mutation((ctx) =>
        beginSliceOccurrenceMaintenance(ctx, "backfill", true)
      )
      let batchReceipt!: BudgetReceipt
      await f.owner.mutation(async (ctx) => {
        const probe = measuredDb(ctx.db)
        batchReceipt = probe.receipt
        return registeredHandler(
          backfillSliceOccurrenceCandidates,
          internal.lib.publishing.staging.backfillSliceOccurrenceCandidates
        )(
          { ...ctx, db: probe.writer },
          { cursor: null, batchSize: 1, dryRun: false, oneBatchOnly: true }
        )
      })
      report.backfillBatch = {
        baseComparator: "not present at base; absolute cost only",
        configuredBatchSize: 1,
        ...checked(batchReceipt),
      }
    } else
      report.backfillBatch = {
        label: "not applicable",
        reason: "new HEAD worker; no historical runner executed",
      }
    const destination = process.env.FORMULACMS_OCCURRENCE_BUDGET_REPORT
    if (destination)
      await writeFile(destination, JSON.stringify(report, null, 2) + "\n")
    expect(articleText.split(/\s+/)).toHaveLength(2520)
  })

  test(
    "count query for three presentations reads the same documents after1and50rounds", { ...sliceProfile(["hero-with-image","rich-text-body"]), timeout: 60_000 },
    async () => {
      const f = await fixture()
      const { getSlicePresentationUsageSummary } =
        await import("./cms/sliceLibrary")
      await f.t.run((ctx) =>
        ctx.db.insert("sliceOccurrenceCounts", {
          type: "hero-with-image",
          presentationId: "split",
          count: 0,
          invalidSources: 0,
          epoch: 1,
          version: 0,
        })
      )
      const receipts: Record<string, unknown> = {}
      const sizes: BudgetReceipt[] = []
      for (let round = 1; round <= 50; round++) {
        await f.owner.mutation(
          api.cms.publication.saveLocaleDraft,
          await f.saveArgs(round)
        )
        await f.owner.mutation(
          api.cms.publication.publishLocale,
          await f.publishArgs()
        )
        if (round === 1 || round === 50) {
          let receipt!: BudgetReceipt
          const value = await f.owner.mutation(async (ctx) => {
            const probe = measuredDb(ctx.db)
            receipt = probe.receipt
            return registeredHandler(
              getSlicePresentationUsageSummary,
              api.cms.sliceLibrary.getSlicePresentationUsageSummary
            )(
              { ...ctx, db: probe.writer },
              {
                type: "hero-with-image",
                presentationIds: ["default", "centered", "split"],
              }
            )
          })
          expect(value).toEqual({
            status: "ready",
            counts: { default: 0, centered: round + 1, split: 0 },
          })
          expect(receipt.documentsRead).toBeLessThanOrEqual(67)
          expect(receipt.approximateBytesRead).toBeLessThanOrEqual(
            0.26 * 1024 * 1024
          )
          expect(
            receipt.readTables.every((table) =>
              [
                "cmsOwner",
                "sliceOccurrenceCountState",
                "sliceOccurrenceCounts",
              ].includes(table)
            )
          ).toBe(true)
          sizes.push(receipt)
          receipts[`round${round}`] = { ...checked(receipt), value }
        }
      }
      expect(sizes[1].documentsRead).toBe(sizes[0].documentsRead)
      expect(sizes[1].approximateBytesRead).toBe(sizes[0].approximateBytesRead)
      expect(sizes[1].indexRanges).toBe(sizes[0].indexRanges)
      const destination = process.env.FORMULACMS_OCCURRENCE_COUNT_BUDGET_REPORT
      if (destination)
        await writeFile(
          destination,
          JSON.stringify(
            {
              phase,
              pages: 500,
              locales: ["en", "fr"],
              maximumPublicationRounds: 50,
              queriedPresentations: ["default", "centered", "split"],
              ...receipts,
            },
            null,
            2
          ) + "\n"
        )
    }
  )
  test(
    "a counter write failure rolls the real save and accounting back together", sliceProfile(["hero-with-image","rich-text-body"]),
    async () => {
      const f = await fixture()
      const tables = [
        "pageLocaleDrafts",
        "pagePublicationSliceReferences",
        "sliceOccurrenceUsage",
        "sliceOccurrenceSources",
        "sliceOccurrenceSourceMembers",
        "sliceOccurrenceCounts",
      ] as const
      const snapshot = () =>
        f.t.run(async (ctx) =>
          Promise.all(tables.map((table) => ctx.db.query(table).collect()))
        )
      const before = await snapshot()
      const input = await f.saveArgs(7)
      await expect(
        f.owner.mutation(async (ctx) => {
          const probe = measuredDb(ctx.db, true)
          return registeredHandler(
            saveLocaleDraft,
            api.cms.publication.saveLocaleDraft
          )({ ...ctx, db: probe.writer }, input)
        })
      ).rejects.toThrow("injected-counter-write-failure")
      expect(await snapshot()).toEqual(before)
    }
  )
})
