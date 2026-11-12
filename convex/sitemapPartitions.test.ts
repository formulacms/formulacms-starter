/// <reference types="vite/client" />

import { sliceProfile, createInstalledDefaultSlice } from "@/test-utils/slice-profile"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { SUPPORTED_LOCALES } from "../lib/i18n/config"
import { readSitemapRange } from "./cms/pages"
import type { SitemapChild } from "./cms/pages"
import {
  SITEMAP_MANIFEST_RETENTION_MS,
  SITEMAP_PARTITION_CEILING,
  SITEMAP_PARTITION_TARGET,
  closeSitemapPartition,
  requestSitemapManifestBuildInTransaction,
  sitemapPartitionReaders,
  stepSitemapManifestBuildInTransaction,
  type SitemapPartitionReaders,
} from "./cms/publication"
import { insertLanguageLifecycleIntent } from "./lib/language/lifecycle"

import {
  digestLocalePublicationCandidate,
  reconstructLocalePublicationCandidate,
  serializeLocalePublicationCandidate,
} from "./lib/publishing/localeCandidate"
import schema from "./schema"

// M05 C5a (FR1b): publication-owned sitemap partitions. Proofs P13b, P19d and
// P22 of the M05 contract ("Sitemap partitions", "Worker transaction
// ceilings").

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "c5a-owner",
  tokenIdentifier: "https://convex.test|c5a-owner",
}
const FIXED_NOW = Date.UTC(2026, 8, 23, 12, 0, 0)
const LOCALES = [...SUPPORTED_LOCALES] as string[]

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

async function drain(t: T) {
  // A build takes one scheduled step per partition.
  await t.finishAllScheduledFunctions(vi.runAllTimers, 2_000)
}

async function publishArgs(t: T, pageId: Id<"pages">, locale: string) {
  return t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!
    const shared = (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    const page = (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!
    return {
      pageId,
      locale,
      expectedDraftGeneration: state.draftGeneration,
      expectedSharedDraftGeneration: shared.generation,
      expectedPublicGeneration: state.publicGeneration,
      expectedLifecycleGeneration: page.lifecycleGeneration,
      expectedReleaseGeneration: state.releaseGeneration,
    }
  })
}

/** About `kib` KiB of FAQ text: the P22 profile's realistic page body. */
function bulkSlices(kib: number) {
  if (kib === 0) return []
  const faq = createInstalledDefaultSlice("faq-simple") as {
    items: Array<Record<string, unknown>>
  }
  faq.items = Array.from({ length: 12 }, (_, index) => ({
    question: `Q${index} ${"x".repeat(Math.floor((kib * 1024) / 12))}`,
    answer: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
  }))
  return [faq]
}

async function createPage(
  owner: Caller,
  slug: string,
  locales: readonly string[],
  parentId?: Id<"pages">,
  kib = 0
) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    ...(parentId === undefined ? {} : { parentId }),
    content: Object.fromEntries(
      locales.map((locale) => [
        locale,
        { title: `${slug} ${locale}`, slices: bulkSlices(kib) as never },
      ])
    ),
  })
}

async function publish(site: Site, pageId: Id<"pages">, locale: string) {
  await site.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArgs(site.t, pageId, locale)
  )
}

type Site = {
  t: T
  owner: Caller
  homeId: Id<"pages">
  locales: string[]
}

/**
 * Version 0 with snapshot authority and no language-authority row (F09 rows
 * 5 and 37): `locales` enabled from the settings row. The home is published in
 * the default locale only.
 */
async function snapshotSite(locales: readonly string[]): Promise<Site> {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await createPage(owner, "home", locales)
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "C5a site",
      siteUrl: "",
      defaultLocale: locales[0]!,
      enabledLocales: [...locales],
      homePageId: homeId,
      updatedAt: FIXED_NOW,
    })
  )
  const site = { t, owner, homeId, locales: [...locales] }
  await publish(site, homeId, locales[0]!)
  await drain(t)
  return site
}

/** Publishes `slug` in `locales` through the real command path. */
async function publishedPage(
  site: Site,
  slug: string,
  locales: readonly string[],
  parentId?: Id<"pages">,
  kib = 0
): Promise<Id<"pages">> {
  const pageId = await createPage(site.owner, slug, site.locales, parentId, kib)
  for (const locale of locales) await publish(site, pageId, locale)
  await drain(site.t)
  return pageId
}

/**
 * Clones a published template into `count` Pages whose aggregates pass the
 * same verification as the template's: the candidate payload is rewritten
 * for the new Page id and slug and its digest recomputed, then release,
 * snapshot and locale state are re-linked. The pilot envelope caps the
 * command path at 499 Pages, so P13b's scale needs direct construction.
 */
async function cloneVerifiedPages(
  site: Site,
  templateId: Id<"pages">,
  slug: string,
  locales: readonly string[],
  count: number
): Promise<Id<"pages">[]> {
  return site.t.run(async (ctx) => {
    const strip = <R extends { _id: unknown; _creationTime: number }>(
      row: R
    ): Omit<R, "_id" | "_creationTime"> => {
      const { _id, _creationTime, ...rest } = row
      void _id
      void _creationTime
      return rest
    }
    const page = (await ctx.db.get(templateId))!
    const pageState = (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", templateId))
      .unique())!
    const templates: Array<{
      state: Doc<"pageLocalePublicationStates">
      snapshot: Doc<"pagePublishedSnapshots">
      candidate: Doc<"pageLocalePublicationCandidates">
      release: Doc<"pageLocalePublicationReleases">
    }> = []
    for (const locale of locales) {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", templateId).eq("locale", locale)
        )
        .unique())!
      const snapshot = (await ctx.db.get(state.currentSnapshotId!))!
      templates.push({
        state,
        snapshot,
        candidate: (await ctx.db.get(snapshot.candidateId))!,
        release: (await ctx.db.get(snapshot.releaseId))!,
      })
    }
    const ids: Id<"pages">[] = []
    for (let index = 0; index < count; index += 1) {
      const cloneSlug = `${slug}-c${index}`
      const pageId = await ctx.db.insert("pages", {
        ...strip(page),
        slug: cloneSlug,
      } as never)
      ids.push(pageId)
      await ctx.db.insert("pagePublicationPageStates", {
        ...strip(pageState),
        pageId,
      })
      const rewrite = (value: string) =>
        value
          .replaceAll(String(templateId), String(pageId))
          .replaceAll(slug, cloneSlug)
      for (const { state, snapshot, candidate, release } of templates) {
        const payloadJson = rewrite(candidate.payloadJson)
        const digest = await digestLocalePublicationCandidate(payloadJson)
        const candidateId = await ctx.db.insert(
          "pageLocalePublicationCandidates",
          {
            ...strip(candidate),
            pageId,
            payloadJson,
            payloadBytes: new TextEncoder().encode(payloadJson).byteLength,
            digest,
          }
        )
        const { publishedSnapshotId, ...releaseRow } = strip(release)
        void publishedSnapshotId
        const releaseId = await ctx.db.insert("pageLocalePublicationReleases", {
          ...releaseRow,
          pageId,
          candidateId,
        })
        const snapshotId = await ctx.db.insert("pagePublishedSnapshots", {
          ...strip(snapshot),
          pageId,
          candidateId,
          releaseId,
          candidateDigest: digest,
        })
        await ctx.db.patch(releaseId, { publishedSnapshotId: snapshotId })
        await ctx.db.insert("pageLocalePublicationStates", {
          ...strip(state),
          pageId,
          currentSnapshotId: snapshotId,
          draftBaseSnapshotId: snapshotId,
          currentPath: rewrite(state.currentPath!),
        })
      }
    }
    return ids
  })
}

async function insertBarePage(
  ctx: MutationCtx,
  slug: string
): Promise<Id<"pages">> {
  const now = Date.now()
  return ctx.db.insert("pages", {
    slug,
    pageType: "page",
    status: "published",
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    content: { en: { title: slug, slices: [] } },
  })
}

async function insertBareState(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  locale: string
): Promise<Id<"pageLocalePublicationStates">> {
  return ctx.db.insert("pageLocalePublicationStates", {
    pageId,
    locale,
    draftGeneration: 0,
    publicGeneration: 1,
    releaseGeneration: 0,
    hasCurrentSnapshot: true,
    updatedAt: Date.now(),
  })
}

describe("M05 C5a seam: sitemapPartitionReaders.after", () => {
  test("returns the next same-locale row, excludes the boundary row, and returns null past the end", async () => {
    const t = convexTest(schema, modules)
    const times = await t.run(async (ctx) => {
      const created: number[] = []
      for (let index = 0; index < 3; index += 1) {
        const pageId = await insertBarePage(ctx, `seam-${index}`)
        const stateId = await insertBareState(ctx, pageId, "en")
        // A row in another locale must never be returned for `en`.
        await insertBareState(ctx, pageId, "fr")
        created.push((await ctx.db.get(stateId))!._creationTime)
      }
      return created
    })
    expect(new Set(times).size).toBe(3)

    const probed = await t.run(async (ctx) => {
      const readers = sitemapPartitionReaders(ctx, "en", null)
      return {
        next: await readers.after(times[0]!),
        boundary: await readers.after(times[1]!),
        pastEnd: await readers.after(times[2]!),
      }
    })
    expect(probed.next).toBe(times[1])
    expect(probed.boundary).toBe(times[2])
    expect(probed.pastEnd).toBeNull()
  })
})

/** Marks the current `locale` snapshot `noIndex`, as a published draft would. */
async function publishNoIndex(site: Site, pageId: Id<"pages">, locale: string) {
  await site.t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!
    const snapshot = (await ctx.db.get(state.currentSnapshotId!))!
    const candidate = (await ctx.db.get(snapshot.candidateId))!
    const payload = (await reconstructLocalePublicationCandidate(candidate))!
    const system = payload.shared.system as { seo?: Record<string, unknown> }
    system.seo = { ...(system.seo ?? {}), noIndex: true }
    const { payloadJson, payloadBytes } =
      serializeLocalePublicationCandidate(payload)
    const digest = await digestLocalePublicationCandidate(payloadJson)
    await ctx.db.patch(candidate._id, { payloadJson, payloadBytes, digest })
    await ctx.db.patch(snapshot._id, { candidateDigest: digest })
  })
}

/** Current-snapshot state rows that no verified aggregate backs. */
async function insertBareRows(t: T, locale: string, count: number) {
  return t.run(async (ctx) => {
    const ids: Id<"pageLocalePublicationStates">[] = []
    for (let index = 0; index < count; index += 1) {
      const pageId = await insertBarePage(ctx, `bare-${locale}-${index}`)
      ids.push(await insertBareState(ctx, pageId, locale))
    }
    return ids
  })
}

/** F09-bootstrapped site: authority v1, snapshot publication, `en` only. */
async function bootstrappedSite(extraLocales: readonly string[] = []) {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "C5a",
    timezone: "UTC",
    defaultLocale: "en",
  })
  if (extraLocales.length > 0) {
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, {
        enabledLocales: ["en", ...extraLocales],
      })
    })
  }
  await drain(t)
  return { t, owner }
}

async function languageVersion(t: T): Promise<number> {
  return t.run(
    async (ctx) =>
      (await ctx.db.query("siteLanguageAuthority").first())?.version ?? 0
  )
}

async function manifests(t: T) {
  return t.run((ctx) =>
    ctx.db
      .query("siteSitemapManifests")
      .withIndex("by_manifestVersion")
      .collect()
  )
}

async function partitionsOf(t: T, manifestVersion: number) {
  return t.run((ctx) =>
    ctx.db
      .query("siteSitemapPartitions")
      .withIndex("by_manifestVersion_and_locale_and_ordinal", (q) =>
        q.eq("manifestVersion", manifestVersion)
      )
      .collect()
  )
}

async function requestBuild(t: T, rebuild = false) {
  return t.run((ctx) =>
    requestSitemapManifestBuildInTransaction(ctx, { rebuild })
  )
}

/** Each current row of `locale`, by the partition ranges that contain it. */
async function coverage(t: T, manifestVersion: number, locale: string) {
  const partitions = (await partitionsOf(t, manifestVersion))
    .filter((partition) => partition.locale === locale)
    .sort((a, b) => a.ordinal - b.ordinal)
  return t.run(async (ctx) => {
    const seen = new Map<string, number>()
    for (const partition of partitions) {
      const rows = await readSitemapRange(
        ctx,
        locale,
        partition.lowCreationTime,
        partition.highCreationTime,
        10_000
      )
      for (const row of rows) seen.set(row._id, (seen.get(row._id) ?? 0) + 1)
    }
    const all = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
        q.eq("hasCurrentSnapshot", true).eq("locale", locale)
      )
      .collect()
    return {
      rows: all.length,
      covered: [...seen.values()].filter((count) => count === 1).length,
      duplicated: [...seen.values()].filter((count) => count > 1).length,
      missing: all.filter((row) => !seen.has(row._id)).length,
      chained: partitions.every(
        (partition, index) =>
          (index === 0
            ? partition.lowCreationTime === null
            : partition.lowCreationTime ===
              partitions[index - 1]!.highCreationTime) &&
          (index === partitions.length - 1) ===
            (partition.highCreationTime === null)
      ),
      ordinals: partitions.map((partition) => partition.ordinal),
    }
  })
}

async function child(
  t: T,
  args: {
    languageVersion: number
    manifestVersion: number
    locale: string
    ordinal: number
  }
): Promise<SitemapChild> {
  return t.query(api.cms.pages.getSitemapChild, args)
}

/** In-memory `_creationTime` keyspace (S11): supplies tied values. */
function suppliedReaders(times: readonly number[]) {
  const calls: Array<{ kind: "fromLow" | "after"; limit?: number }> = []
  const sorted = [...times].sort((a, b) => a - b)
  const at = (low: number | null): SitemapPartitionReaders => ({
    fromLow: async (limit) => {
      calls.push({ kind: "fromLow", limit })
      return sorted
        .filter((time) => low === null || time >= low)
        .slice(0, limit)
    },
    after: async (value) => {
      calls.push({ kind: "after" })
      return sorted.find((time) => time > value) ?? null
    },
  })
  return { at, calls }
}

/** Closes partitions over `times` until the keyspace ends. */
async function partitionAll(times: readonly number[]) {
  const { at } = suppliedReaders(times)
  const closed: Array<{
    low: number | null
    high: number | null
    oversized: boolean
    ranges: number
  }> = []
  let low: number | null = null
  for (let guard = 0; guard < 10_000; guard += 1) {
    const close = await closeSitemapPartition(
      at(low),
      SITEMAP_PARTITION_TARGET,
      SITEMAP_PARTITION_CEILING
    )
    closed.push({
      low,
      high: close.highCreationTime,
      oversized: close.oversized,
      ranges: close.ranges,
    })
    if (close.highCreationTime === null) return closed
    low = close.highCreationTime
  }
  throw new Error("partitioning did not terminate")
}

const TARGET = SITEMAP_PARTITION_TARGET
const CEILING = SITEMAP_PARTITION_CEILING

describe("M05 P22 sitemap partitions: partition closing (S11 supplied values)", () => {
  test("the ceiling constants are the measured contract values", () => {
    expect(CEILING).toBe(13)
    expect(TARGET).toBe(Math.floor(CEILING / 4))
    expect(TARGET).toBeGreaterThanOrEqual(1)
  })

  test("an ordinary partition with no tie costs one range and closes at the TARGET + 1st row", async () => {
    const { at, calls } = suppliedReaders([10, 20, 30, 40, 50, 60])
    expect(await closeSitemapPartition(at(null), TARGET, CEILING)).toEqual({
      highCreationTime: [10, 20, 30, 40, 50, 60][TARGET],
      rowsAtBuild: TARGET,
      oversized: false,
      ranges: 1,
    })
    expect(calls).toEqual([{ kind: "fromLow", limit: TARGET + 1 }])
  })

  test("a tie at the closing row moves the bound to that value, so the whole group lands in the next partition", async () => {
    const times = [10, ...Array<number>(TARGET + 2).fill(20), 30]
    const { at } = suppliedReaders(times)
    expect(await closeSitemapPartition(at(null), TARGET, CEILING)).toEqual({
      highCreationTime: 20,
      rowsAtBuild: 1,
      oversized: false,
      ranges: 1,
    })
  })

  test("a tie group larger than CEILING is oversized in exactly three ranges, however large, and never enumerated", async () => {
    for (const groupSize of [CEILING + 1, 10 * CEILING, 1_000_000]) {
      const calls: Array<{ kind: string; limit?: number }> = []
      // The group is larger than any batch: every read returns it in full.
      const readers: SitemapPartitionReaders = {
        fromLow: async (limit) => {
          calls.push({ kind: "fromLow", limit })
          return Array<number>(Math.min(limit, groupSize)).fill(500)
        },
        after: async () => {
          calls.push({ kind: "after" })
          return 900
        },
      }
      expect(await closeSitemapPartition(readers, TARGET, CEILING)).toEqual({
        highCreationTime: 900,
        rowsAtBuild: CEILING,
        oversized: true,
        ranges: 3,
      })
      expect(calls).toEqual([
        { kind: "fromLow", limit: TARGET + 1 },
        { kind: "fromLow", limit: CEILING },
        { kind: "after" },
      ])
    }
  })

  test("a tie group at the end of a locale is oversized with no upper bound, or closes unbounded below CEILING", async () => {
    const oversized = suppliedReaders(Array<number>(CEILING + 3).fill(7))
    expect(
      await closeSitemapPartition(oversized.at(null), TARGET, CEILING)
    ).toEqual({
      highCreationTime: null,
      rowsAtBuild: CEILING,
      oversized: true,
      ranges: 3,
    })
    const small = suppliedReaders(Array<number>(TARGET + 2).fill(7))
    expect(
      await closeSitemapPartition(small.at(null), TARGET, CEILING)
    ).toEqual({
      highCreationTime: null,
      rowsAtBuild: TARGET + 2,
      oversized: false,
      ranges: 2,
    })
    const bounded = suppliedReaders([
      ...Array<number>(TARGET + 2).fill(7),
      8,
      9,
    ])
    expect(
      await closeSitemapPartition(bounded.at(null), TARGET, CEILING)
    ).toEqual({
      highCreationTime: 8,
      rowsAtBuild: TARGET + 2,
      oversized: false,
      ranges: 2,
    })
  })

  test("partitioning keyspaces with ties at every boundary neither omits nor duplicates a row", async () => {
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    const keyspaces: number[][] = [
      [],
      [5],
      Array<number>(CEILING + 5).fill(3),
      [1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 5, 5, 5, 5, 5, 5, 6],
    ]
    for (let index = 0; index < 40; index += 1) {
      const times: number[] = []
      let time = 0
      const length = Math.floor(random() * 120)
      while (times.length < length) {
        time += random() < 0.4 ? 0 : 1
        const group = random() < 0.05 ? CEILING + 1 : 1
        for (let copy = 0; copy < group; copy += 1) times.push(time)
      }
      keyspaces.push(times)
    }
    for (const times of keyspaces) {
      const closed = await partitionAll(times)
      expect(closed[0]!.low).toBeNull()
      expect(closed.at(-1)!.high).toBeNull()
      for (let index = 1; index < closed.length; index += 1) {
        expect(closed[index]!.low).toBe(closed[index - 1]!.high)
      }
      for (const time of times) {
        const containing = closed.filter(
          ({ low, high }) =>
            (low === null || time >= low) && (high === null || time < high)
        )
        expect(containing).toHaveLength(1)
      }
      for (const partition of closed) {
        expect(partition.ranges).toBeLessThanOrEqual(
          partition.oversized ? 3 : 2
        )
        const rows = times.filter(
          (time) =>
            (partition.low === null || time >= partition.low) &&
            (partition.high === null || time < partition.high)
        )
        // Only a single tie group of at least CEILING rows is oversized.
        if (partition.oversized) {
          expect(new Set(rows).size).toBe(1)
          expect(rows.length).toBeGreaterThanOrEqual(CEILING)
        } else {
          expect(rows.length).toBeLessThan(CEILING)
        }
      }
    }
  })
})

describe("M05 P22 sitemap partitions: build, publication and children", () => {
  test("a fresh install above CEILING with no language operation converges from version 0 through the nightly sweep", async () => {
    const { t } = await bootstrappedSite()
    await insertBareRows(t, "en", CEILING + 5)
    const version = await languageVersion(t)
    expect(version).toBe(1)
    expect(await manifests(t)).toEqual([])
    expect(
      await t.query(api.cms.pages.getSitemapIndex, { languageVersion: version })
    ).toEqual({
      manifestVersion: 0,
      locales: [{ locale: "en", partitions: 1 }],
    })
    expect(
      await child(t, {
        languageVersion: version,
        manifestVersion: 0,
        locale: "en",
        ordinal: 0,
      })
    ).toEqual({ status: "unavailable", reason: "overflow" })

    await t.mutation(internal.cms.publication.sweepSitemapManifests, {})
    await drain(t)

    const [manifest] = await manifests(t)
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      languageVersion: version,
      status: "ready",
    })
    const covered = await coverage(t, 1, "en")
    expect(covered).toMatchObject({
      missing: 0,
      duplicated: 0,
      chained: true,
    })
    expect(covered.covered).toBe(covered.rows)
    const index = await t.query(api.cms.pages.getSitemapIndex, {
      languageVersion: version,
    })
    expect(index).toEqual({
      manifestVersion: 1,
      locales: [{ locale: "en", partitions: covered.ordinals.length }],
    })
    // Version 0 stops serving once a ready manifest exists.
    expect(
      await child(t, {
        languageVersion: version,
        manifestVersion: 0,
        locale: "en",
        ordinal: 0,
      })
    ).toEqual({ status: "not_found" })
    for (const ordinal of covered.ordinals) {
      expect(
        await child(t, {
          languageVersion: version,
          manifestVersion: 1,
          locale: "en",
          ordinal,
        })
      ).toMatchObject({ status: "ok" })
    }
  })

  test("rows inserted, and an old row re-published, after the build stay in exactly one partition", async () => {
    const { t } = await bootstrappedSite()
    const ids = await insertBareRows(t, "en", 3 * TARGET + 1)
    await requestBuild(t)
    await drain(t)
    const before = await coverage(t, 1, "en")
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[1]!, { hasCurrentSnapshot: false })
    })
    await insertBareRows(t, "en", 2)
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[1]!, { hasCurrentSnapshot: true })
    })
    const after = await coverage(t, 1, "en")
    expect(after.ordinals).toEqual(before.ordinals)
    expect(after).toMatchObject({ missing: 0, duplicated: 0, chained: true })
    expect(after.rows).toBe(before.rows + 2)
    expect(after.covered).toBe(after.rows)
  })

  test("15 locales each close their own chained partitions", sliceProfile([]), async () => {
    const site = await snapshotSite(LOCALES)
    for (const locale of LOCALES)
      await insertBareRows(site.t, locale, TARGET + 2)
    await requestBuild(site.t)
    await drain(site.t)
    expect((await manifests(site.t))[0]).toMatchObject({ status: "ready" })
    for (const locale of LOCALES) {
      const covered = await coverage(site.t, 1, locale)
      expect(covered).toMatchObject({
        missing: 0,
        duplicated: 0,
        chained: true,
      })
      expect(covered.covered).toBe(covered.rows)
    }
    const index = await site.t.query(api.cms.pages.getSitemapIndex, {
      languageVersion: 0,
    })
    expect(index.manifestVersion).toBe(1)
    expect(index.locales.map((entry) => entry.locale)).toEqual(LOCALES)
  })

  test("an oversized partition is persisted, serves 503 alone, keeps the chain, and the nightly sweep rebuilds it", async () => {
    const { t } = await bootstrappedSite()
    await insertBareRows(t, "en", TARGET + 3)
    const version = await languageVersion(t)
    const real = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
            q.eq("hasCurrentSnapshot", true).eq("locale", "en")
          )
          .collect()
      ).map((row) => row._creationTime)
    )
    // The first real value is reported as a tie group larger than CEILING;
    // the rest of the keyspace is real (S11).
    const tie = real[0]!
    const tied = [...Array<number>(CEILING + 1).fill(tie), ...real.slice(1)]
    await requestBuild(t)
    for (let step = 0; step < 10; step += 1) {
      const outcome = await t.run((ctx) =>
        stepSitemapManifestBuildInTransaction(ctx, 1, (_ctx, _locale, low) =>
          suppliedReaders(tied).at(low)
        )
      )
      if (outcome === "published") break
    }
    const partitions = await partitionsOf(t, 1)
    expect(partitions[0]).toMatchObject({
      ordinal: 0,
      lowCreationTime: null,
      highCreationTime: real[1],
      oversized: true,
    })
    expect(partitions[1]!.lowCreationTime).toBe(real[1])
    expect((await manifests(t))[0]).toMatchObject({ status: "ready" })
    expect(
      await child(t, {
        languageVersion: version,
        manifestVersion: 1,
        locale: "en",
        ordinal: 0,
      })
    ).toEqual({ status: "unavailable", reason: "oversized" })
    for (const partition of partitions.slice(1)) {
      expect(
        await child(t, {
          languageVersion: version,
          manifestVersion: 1,
          locale: "en",
          ordinal: partition.ordinal,
        })
      ).toMatchObject({ status: "ok" })
    }

    // Drop the steps scheduled by the injected build, then sweep.
    await drain(t)
    await t.mutation(internal.cms.publication.sweepSitemapManifests, {})
    await drain(t)
    const after = await manifests(t)
    expect(
      after.map(({ manifestVersion, status }) => [manifestVersion, status])
    ).toEqual([
      [1, "superseded"],
      [2, "ready"],
    ])
    const rebuilt = await partitionsOf(t, 2)
    expect(rebuilt.some((partition) => partition.oversized)).toBe(false)
  })

  test("a superseded manifest keeps serving until its retention ends, then its children are 404", async () => {
    const { t } = await bootstrappedSite()
    await insertBareRows(t, "en", TARGET + 1)
    const version = await languageVersion(t)
    await requestBuild(t)
    await drain(t)
    const listed = await t.query(api.cms.pages.getSitemapIndex, {
      languageVersion: version,
    })
    expect(listed.manifestVersion).toBe(1)
    await requestBuild(t, true)
    await drain(t)
    expect(
      (await manifests(t)).map(({ manifestVersion, status }) => [
        manifestVersion,
        status,
      ])
    ).toEqual([
      [1, "superseded"],
      [2, "ready"],
    ])
    // The crawler still holds the old index.
    expect(
      await child(t, {
        languageVersion: version,
        manifestVersion: 1,
        locale: "en",
        ordinal: 0,
      })
    ).toMatchObject({ status: "ok" })
    await t.mutation(internal.cms.publication.sweepSitemapManifests, {
      phase: "collect",
    })
    await drain(t)
    expect((await manifests(t)).map((row) => row.manifestVersion)).toEqual([
      1, 2,
    ])
    vi.advanceTimersByTime(SITEMAP_MANIFEST_RETENTION_MS + 1)
    await t.mutation(internal.cms.publication.sweepSitemapManifests, {
      phase: "collect",
    })
    await drain(t)
    expect((await manifests(t)).map((row) => row.manifestVersion)).toEqual([2])
    expect(await partitionsOf(t, 1)).toEqual([])
    expect(
      await child(t, {
        languageVersion: version,
        manifestVersion: 1,
        locale: "en",
        ordinal: 0,
      })
    ).toEqual({ status: "not_found" })
  })

  test("two concurrent build requests allocate one manifest version", async () => {
    const { t } = await bootstrappedSite()
    const results = await Promise.all([
      t.mutation(internal.cms.publication.requestSitemapManifestBuild, {}),
      t.mutation(internal.cms.publication.requestSitemapManifestBuild, {}),
    ])
    expect(results.toSorted()).toEqual([1, null])
    expect((await manifests(t)).map((row) => row.manifestVersion)).toEqual([1])
  })

  test("a language-version change mid-build abandons the build; the index serves version 0 until the new version builds", async () => {
    const { t } = await bootstrappedSite()
    await insertBareRows(t, "en", 2 * TARGET + 1)
    const version = await languageVersion(t)
    await requestBuild(t)
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { version: version + 1 })
    })
    await drain(t)
    expect((await manifests(t))[0]).toMatchObject({
      manifestVersion: 1,
      languageVersion: version,
      status: "abandoned",
    })
    expect(
      await t.query(api.cms.pages.getSitemapIndex, {
        languageVersion: version + 1,
      })
    ).toEqual({
      manifestVersion: 0,
      locales: [{ locale: "en", partitions: 1 }],
    })
    await t.mutation(internal.cms.publication.sweepSitemapManifests, {})
    await drain(t)
    expect(
      (await manifests(t)).map(
        ({ manifestVersion, languageVersion, status }) => [
          manifestVersion,
          languageVersion,
          status,
        ]
      )
    ).toEqual([[2, version + 1, "ready"]])
  })

  test("version 0, removed locales, unknown manifests and ordinals are 404; a stale language version is refused, never 404", async () => {
    const { t } = await bootstrappedSite()
    await insertBareRows(t, "en", 2)
    const version = await languageVersion(t)
    const at = (manifestVersion: number, locale: string, ordinal: number) =>
      child(t, { languageVersion: version, manifestVersion, locale, ordinal })
    expect(await at(0, "en", 0)).toMatchObject({ status: "ok" })
    expect(await at(0, "en", 1)).toEqual({ status: "not_found" })
    expect(await at(0, "fr", 0)).toEqual({ status: "not_found" })
    expect(await at(7, "en", 0)).toEqual({ status: "not_found" })
    await requestBuild(t)
    await drain(t)
    expect(await at(0, "en", 0)).toEqual({ status: "not_found" })
    expect(await at(1, "en", 0)).toMatchObject({ status: "ok" })
    expect(await at(1, "en", 5)).toEqual({ status: "not_found" })
    expect(await at(1, "fr", 0)).toEqual({ status: "not_found" })
    await expect(
      child(t, {
        languageVersion: version + 1,
        manifestVersion: 1,
        locale: "en",
        ordinal: 0,
      })
    ).rejects.toThrow("SITE_LANGUAGE_VERSION_CHANGED")
    await expect(
      t.query(api.cms.pages.getSitemapIndex, { languageVersion: version + 1 })
    ).rejects.toThrow("SITE_LANGUAGE_VERSION_CHANGED")
  })

  test("a ready manifest missing an enabled locale fails the index loudly instead of omitting it", async () => {
    const { t } = await bootstrappedSite()
    await insertBareRows(t, "en", 2)
    const version = await languageVersion(t)
    await requestBuild(t)
    await drain(t)
    await t.run(async (ctx) => {
      for (const partition of await ctx.db
        .query("siteSitemapPartitions")
        .collect()) {
        await ctx.db.delete(partition._id)
      }
    })
    await expect(
      t.query(api.cms.pages.getSitemapIndex, { languageVersion: version })
    ).rejects.toThrow("SITEMAP_MANIFEST_INCOMPLETE")
  })

  test("a child answers overflow above CEILING and serves exactly CEILING rows", async () => {
    const { t } = await bootstrappedSite()
    const version = await languageVersion(t)
    await insertBareRows(t, "en", CEILING - 1)
    const at = () =>
      child(t, {
        languageVersion: version,
        manifestVersion: 0,
        locale: "en",
        ordinal: 0,
      })
    // Bare rows have no verified aggregate, so they read but emit nothing.
    expect(await at()).toEqual({ status: "ok", entries: [] })
    await insertBareRows(t, "en", 1)
    expect(await at()).toEqual({ status: "ok", entries: [] })
    await insertBareRows(t, "en", 1)
    expect(await at()).toEqual({ status: "unavailable", reason: "overflow" })
  })
})

describe("M05 P19d lifecycle intents: sitemap", () => {
  beforeEach(() => {
    vi.stubEnv("REVALIDATE_SECRET", "test-revalidation-secret")
    vi.stubEnv("SITE_URL", "https://site.example.com")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    )
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const drainIntents = async (t: T) => {
    await t.action(
      internal.cms.languageLifecycle.drainLanguageLifecycleIntents,
      {}
    )
    await drain(t)
  }

  test("the sitemap_manifest advance stays within the drain row: it schedules the request instead of running it", async () => {
    const { t } = await bootstrappedSite()
    const version = await languageVersion(t)
    const intentId = await t.run(async (ctx) => {
      await insertLanguageLifecycleIntent(ctx, {
        operationId: `adopt:v${version}`,
        operationKind: "adopt",
        locales: ["en"],
        capturedAuthorityVersion: version,
      })
      const intent = (await ctx.db
        .query("siteLanguageLifecycleIntents")
        .unique())!
      await ctx.db.patch(intent._id, {
        status: "running",
        attempts: 1,
        phase: "sitemap_manifest",
        origin: "https://site.example.com",
      })
      return intent._id
    })
    const measured = await t.run(async (ctx) => {
      const before = await ctx.meta.getTransactionMetrics()
      const advanced = await ctx.runMutation(
        internal.cms.languageLifecycle.advanceLanguageLifecycleIntent,
        {
          intentId,
          attempts: 1,
          fromPhase: "sitemap_manifest",
          fromCursor: null,
          origin: "https://site.example.com",
          nextPhase: "complete",
          nextCursor: null,
        }
      )
      const after = await ctx.meta.getTransactionMetrics()
      const delta = (key: keyof typeof after) =>
        after[key].used - before[key].used
      return {
        advanced,
        databaseQueries: delta("databaseQueries"),
        documentsRead: delta("documentsRead"),
        documentsWritten: delta("documentsWritten"),
        functionsScheduled: delta("functionsScheduled"),
      }
    })
    // Contract drain row: ≤ 3 queries, ≤ 11 documents read, ≤ 2 written.
    expect(measured).toEqual({
      advanced: true,
      databaseQueries: 1,
      documentsRead: 2,
      documentsWritten: 1,
      functionsScheduled: 1,
    })
    expect(await manifests(t)).toEqual([])
    await drain(t)
    expect(
      (await manifests(t)).map(({ manifestVersion, status }) => [
        manifestVersion,
        status,
      ])
    ).toEqual([[1, "ready"]])
  })

  test("sitemap_manifest requests exactly one build per language version; a module toggle requests none", async () => {
    const { t } = await bootstrappedSite()
    const version = await languageVersion(t)
    await t.run((ctx) =>
      insertLanguageLifecycleIntent(ctx, {
        operationId: "module_toggle:c9",
        operationKind: "module_toggle",
        locales: ["en"],
        capturedAuthorityVersion: version,
      })
    )
    await drainIntents(t)
    expect(await manifests(t)).toEqual([])

    for (const operationId of [`adopt:v${version}`, `reveal:v${version}`]) {
      await t.run((ctx) =>
        insertLanguageLifecycleIntent(ctx, {
          operationId,
          operationKind: operationId.startsWith("adopt") ? "adopt" : "reveal",
          locales: ["en"],
          capturedAuthorityVersion: version,
        })
      )
      await drainIntents(t)
    }
    const intents = await t.run((ctx) =>
      ctx.db.query("siteLanguageLifecycleIntents").collect()
    )
    expect(
      intents.map(({ operationId, status, phase }) => [
        operationId,
        status,
        phase,
      ])
    ).toEqual([
      ["module_toggle:c9", "delivered", "complete"],
      [`adopt:v${version}`, "delivered", "complete"],
      [`reveal:v${version}`, "delivered", "complete"],
    ])
    expect(
      (await manifests(t)).map(
        ({ manifestVersion, languageVersion, status }) => [
          manifestVersion,
          languageVersion,
          status,
        ]
      )
    ).toEqual([[1, version, "ready"]])

    // A later language version gets its own single build.
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { version: version + 1 })
      await insertLanguageLifecycleIntent(ctx, {
        operationId: `add:v${version + 1}`,
        operationKind: "add",
        locales: ["en"],
        capturedAuthorityVersion: version + 1,
      })
    })
    await drainIntents(t)
    expect(
      (await manifests(t)).map(
        ({ manifestVersion, languageVersion, status }) => [
          manifestVersion,
          languageVersion,
          status,
        ]
      )
    ).toEqual([
      [1, version, "superseded"],
      [2, version + 1, "ready"],
    ])
  })
})

/**
 * Every child of the current index, rendered, by locale. `sample` limits a
 * locale to the listed ordinals (P13b's large locale; see its proof method).
 */
async function renderedSitemap(
  t: T,
  languageVersion: number,
  sample: Record<string, (partitions: number) => number[]> = {}
) {
  const index = await t.query(api.cms.pages.getSitemapIndex, {
    languageVersion,
  })
  const byLocale: Record<
    string,
    Extract<SitemapChild, { status: "ok" }>["entries"]
  > = {}
  for (const { locale, partitions } of index.locales) {
    byLocale[locale] = []
    const ordinals =
      sample[locale]?.(partitions) ??
      Array.from({ length: partitions }, (_, ordinal) => ordinal)
    for (const ordinal of ordinals) {
      const result = await child(t, {
        languageVersion,
        manifestVersion: index.manifestVersion,
        locale,
        ordinal,
      })
      if (result.status !== "ok") {
        throw new Error(`${locale}/${ordinal}: ${JSON.stringify(result)}`)
      }
      byLocale[locale]!.push(...result.entries)
    }
  }
  return { index, byLocale }
}

describe("M05 P13b SEO sitemap", () => {
  test("15 locales, more than 500 published Pages in a locale and a noIndex locale: nothing omitted, and only SEO alternates are listed", { ...sliceProfile([]), timeout: 300_000 }, async () => {
    const site = await snapshotSite(LOCALES)
    const template = await publishedPage(site, "tmplpage", LOCALES)
    const quiet = await publishedPage(site, "quiet", LOCALES)
    await publishNoIndex(site, quiet, "ja")
    // The removed reader capped each locale at 500 rows. `fr` holds 503.
    const clones = 501
    await cloneVerifiedPages(site, template, "tmplpage", ["fr"], clones)
    await requestBuild(site.t)
    await drain(site.t)

    // Every `fr` row lies in exactly one partition of the ready manifest.
    const frCoverage = await coverage(site.t, 1, "fr")
    expect(frCoverage).toMatchObject({
      rows: clones + 2,
      missing: 0,
      duplicated: 0,
      chained: true,
    })
    expect(frCoverage.covered).toBe(clones + 2)

    // Proof method (execution log FR1b, interpretation 13): every child of
    // the other 14 locales is rendered; `fr` renders its first, middle and
    // last three children, each checked against exactly its partition's rows.
    const partitionCount = frCoverage.ordinals.length
    const sampled = [
      0,
      1,
      2,
      Math.floor(partitionCount / 2) - 1,
      Math.floor(partitionCount / 2),
      Math.floor(partitionCount / 2) + 1,
      partitionCount - 3,
      partitionCount - 2,
      partitionCount - 1,
    ]
    const { index, byLocale } = await renderedSitemap(site.t, 0, {
      fr: () => sampled,
    })
    expect(index.manifestVersion).toBe(1)
    expect(index.locales.map((entry) => entry.locale)).toEqual(LOCALES)
    expect(index.locales.find((entry) => entry.locale === "fr")).toEqual({
      locale: "fr",
      partitions: partitionCount,
    })
    const frPartitions = (await partitionsOf(site.t, 1)).filter(
      (partition) => partition.locale === "fr"
    )
    for (const ordinal of sampled) {
      const partition = frPartitions.find((row) => row.ordinal === ordinal)!
      const expected = await site.t.run(async (ctx) =>
        (
          await readSitemapRange(
            ctx,
            "fr",
            partition.lowCreationTime,
            partition.highCreationTime,
            CEILING + 1
          )
        ).map((row) => `/fr${row.currentPath}`)
      )
      const rendered = await child(site.t, {
        languageVersion: 0,
        manifestVersion: 1,
        locale: "fr",
        ordinal,
      })
      expect(rendered.status).toBe("ok")
      expect(
        rendered.status === "ok"
          ? rendered.entries.map((entry) => entry.url).sort()
          : []
      ).toEqual(expected.sort())
    }

    const urls = (locale: string) =>
      byLocale[locale]!.map((entry) => entry.url).sort()
    expect(urls("en")).toEqual(["/", "/quiet", "/tmplpage"])
    // The `noIndex` locale is absent from the sitemap and from every other
    // locale's alternates, while the Page's other locales stay listed.
    expect(urls("ja")).toEqual(["/ja/tmplpage"])
    for (const locale of LOCALES.filter(
      (l) => !["en", "fr", "ja"].includes(l)
    )) {
      expect(urls(locale)).toEqual([`/${locale}/quiet`, `/${locale}/tmplpage`])
    }
    const entry = (locale: string, url: string) =>
      byLocale[locale]!.find((candidate) => candidate.url === url)!
    const localesOf = (value: { alternates: Array<{ locale: string }> }) =>
      value.alternates.map((alternate) => alternate.locale)
    expect(localesOf(entry("en", "/tmplpage"))).toEqual(LOCALES)
    expect(entry("en", "/tmplpage").alternates).toContainEqual({
      locale: "pt-br",
      url: "/pt-br/tmplpage",
    })
    expect(localesOf(entry("ko", "/ko/quiet"))).toEqual(
      LOCALES.filter((locale) => locale !== "ja")
    )
    // A Page published in one locale lists only itself.
    const lastClone = byLocale.fr!.find(
      (candidate) => candidate.url === "/fr/tmplpage-c500"
    )
    expect(lastClone?.alternates).toEqual([
      { locale: "fr", url: "/fr/tmplpage-c500" },
    ])
    expect(entry("en", "/").alternates).toEqual([{ locale: "en", url: "/" }])
    expect(entry("en", "/").priority).toBe(1)
    // No URL appears twice anywhere in the rendered sitemap.
    const all = Object.values(byLocale).flatMap((entries) =>
      entries.map((value) => value.url)
    )
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("M05 C5 reachable sitemap alternates", () => {
  test("a withdrawn same-locale ancestor removes the child's alternate and own sitemap URL", sliceProfile([]), async () => {
    const site = await snapshotSite(["en", "fr"])
    const parentId = await publishedPage(site, "company", ["en", "fr"])
    const childId = await publishedPage(site, "team", ["en", "fr"], parentId)
    await site.t.run(async (ctx) => {
      const parent = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", parentId).eq("locale", "fr")
        )
        .unique())!
      await ctx.db.patch(parent._id, {
        hasCurrentSnapshot: false,
        currentSnapshotId: undefined,
        currentPath: undefined,
        currentPublishedAt: undefined,
      })
    })

    const result = await site.t.run(async (ctx) => {
      const { renderSitemapRows } = await import("./cms/pages")
      const rows = await Promise.all(
        ["en", "fr"].map((locale) =>
          ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_pageId_and_locale", (q) =>
              q.eq("pageId", childId).eq("locale", locale)
            )
            .unique()
        )
      )
      const cfg = {
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        homePageId: site.homeId,
      }
      return {
        en: await renderSitemapRows(ctx, [rows[0]!], "en", cfg),
        fr: await renderSitemapRows(ctx, [rows[1]!], "fr", cfg),
      }
    })
    expect(result.en).toEqual([
      {
        url: "/company/team",
        lastModified: expect.any(Number),
        priority: 0.5,
        alternates: [{ locale: "en", url: "/company/team" }],
      },
    ])
    expect(result.fr).toEqual([])
  })
})

describe("M05 P22 transaction metrics", () => {
  const METRICS = [
    "databaseQueries",
    "documentsRead",
    "documentsWritten",
    "functionsScheduled",
    "bytesRead",
    "bytesWritten",
    "scheduledFunctionArgsBytes",
  ] as const
  type Used = Record<(typeof METRICS)[number], number>
  const used = async (ctx: MutationCtx): Promise<Used> => {
    const metrics = await ctx.meta.getTransactionMetrics()
    return Object.fromEntries(
      METRICS.map((key) => [key, metrics[key].used])
    ) as Used
  }
  const RESERVE = {
    databaseQueries: 4096 / 2,
    documentsRead: 32_000 / 2,
    bytesRead: 8 * 1024 * 1024,
  }
  const BUILDER_CEILINGS: Used = {
    databaseQueries: 6,
    documentsRead: TARGET + CEILING + 5,
    documentsWritten: 2,
    functionsScheduled: 1,
    bytesRead: 4 * 1024 * 1024,
    bytesWritten: 1024 * 1024,
    scheduledFunctionArgsBytes: 64 * 1024,
  }
  const expectBuilderWithinCeilings = (branch: string, values: Used) => {
    for (const metric of METRICS) {
      expect(values[metric], `${branch}: ${metric}`).toBeLessThanOrEqual(
        BUILDER_CEILINGS[metric]
      )
    }
  }

  test("builder steps stay within the ceiling row, with a tie resolved in at most three ranges", async () => {
    const { t } = await bootstrappedSite()
    await insertBareRows(t, "en", CEILING + 1)
    await requestBuild(t)
    // Ordinary step on real rows: one range.
    const ordinary = await t.run(async (ctx) => {
      const outcome = await stepSitemapManifestBuildInTransaction(ctx, 1)
      return { outcome, ...(await used(ctx)) }
    })
    expect(ordinary).toMatchObject({ outcome: "closed" })
    // Manifest, authority and one range; the manifest patch re-reads it.
    expect(ordinary.databaseQueries).toBe(3)
    expect(ordinary.documentsRead).toBe(1 + 1 + (TARGET + 1) + 1)
    expect(ordinary.documentsWritten).toBeLessThanOrEqual(2)
    expect(ordinary.functionsScheduled).toBe(1)
    expectBuilderWithinCeilings("ordinary", ordinary)

    // S11 supplies equal timestamps because convex-test cannot store them.
    // Each supplied reader still executes its corresponding real range read,
    // so the transaction metrics include the fixture's row and byte costs.
    // This does not assert that the stored rows themselves have tied times.
    const tieEnd = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
          q.eq("hasCurrentSnapshot", true).eq("locale", "en")
        )
        .take(CEILING + 1)
      expect(rows).toHaveLength(CEILING + 1)
      return rows[CEILING - 1]!._creationTime
    })
    // Worst cases: mid-locale (probe finds a row) and end of locale
    // (probe empty, settings read for the next locale).
    for (const probe of [900, null] as const) {
      let ranges = 0
      const measured = await t.run(async (ctx) => {
        const outcome = await stepSitemapManifestBuildInTransaction(
          ctx,
          1,
          () => ({
            fromLow: async (limit) => {
              ranges += 1
              const rows = await ctx.db
                .query("pageLocalePublicationStates")
                .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
                  q.eq("hasCurrentSnapshot", true).eq("locale", "en")
                )
                .take(limit)
              return rows.map(() => 500)
            },
            after: async () => {
              ranges += 1
              const rows = await ctx.db
                .query("pageLocalePublicationStates")
                .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
                  q
                    .eq("hasCurrentSnapshot", true)
                    .eq("locale", "en")
                    .gt(
                      "_creationTime",
                      probe === null ? Number.MAX_SAFE_INTEGER : tieEnd
                    )
                )
                .take(1)
              return rows.length === 0 ? null : probe
            },
          })
        )
        return { outcome, ...(await used(ctx)) }
      })
      expect(measured.outcome).toBe("closed")
      expect(ranges).toBe(3)
      // The accepted FR1.review row includes the manifest, authority,
      // settings at a locale end, and up to three real range queries.
      expect(measured.documentsRead).toBe(TARGET + CEILING + 5)
      expect(measured.databaseQueries).toBe(probe === null ? 6 : 5)
      expect(measured.documentsWritten).toBeLessThanOrEqual(2)
      expect(measured.functionsScheduled).toBe(1)
      expectBuilderWithinCeilings(`tie probe ${probe}`, measured)
    }

    // Publication: supersede the ready manifest and publish in one step.
    await t.run(async (ctx) => {
      const manifest = (await ctx.db.query("siteSitemapManifests").unique())!
      await ctx.db.patch(manifest._id, {
        buildLocale: undefined,
        buildLowCreationTime: undefined,
        buildOrdinal: undefined,
      })
    })
    const publication = await t.run(async (ctx) => {
      const outcome = await stepSitemapManifestBuildInTransaction(ctx, 1)
      return { outcome, ...(await used(ctx)) }
    })
    expect(publication).toMatchObject({ outcome: "published" })
    expect(publication.documentsWritten).toBeLessThanOrEqual(2)
    expect(publication.functionsScheduled).toBe(0)
    expectBuilderWithinCeilings("publication", publication)
  })

  test("a child of CEILING + 1 rows under the P22 profile stays within the M23 reserve; a heavier one answers 503 before the hard limit", { ...sliceProfile(["faq-simple"]), timeout: 300_000 }, async () => {
    const site = await snapshotSite(LOCALES)
    const build = async (slug: string, kib: number) => {
      const top = await publishedPage(
        site,
        `${slug}top`,
        LOCALES,
        undefined,
        kib
      )
      const one = await publishedPage(site, `${slug}one`, LOCALES, top, kib)
      return publishedPage(site, `${slug}two`, LOCALES, one, kib)
    }
    const profile = await build("prof", 22)
    // `fr` rows: the three templates plus depth-2 clones, CEILING + 1 in all.
    await cloneVerifiedPages(site, profile, "proftwo", LOCALES, CEILING - 2)
    const measured = await site.t.run(async (ctx) => {
      const { renderSitemapRows } = await import("./cms/pages")
      const rows = await readSitemapRange(ctx, "fr", null, null, CEILING + 2)
      const cfg = {
        defaultLocale: "en",
        enabledLocales: LOCALES,
        homePageId: site.homeId,
      }
      const entries = await renderSitemapRows(ctx, rows, "fr", cfg)
      return {
        rows: rows.length,
        entries: entries === "read_budget" ? entries : entries.length,
        ...(await used(ctx)),
      }
    })
    expect(measured.rows).toBe(CEILING + 1)
    expect(measured.entries).toBe(CEILING + 1)
    expect(measured.databaseQueries).toBeLessThanOrEqual(
      RESERVE.databaseQueries
    )
    expect(measured.documentsRead).toBeLessThanOrEqual(RESERVE.documentsRead)
    expect(measured.bytesRead).toBeLessThanOrEqual(RESERVE.bytesRead)
    // The served child sees CEILING + 1 rows as an overflow.
    expect(
      await child(site.t, {
        languageVersion: 0,
        manifestVersion: 0,
        locale: "fr",
        ordinal: 0,
      })
    ).toEqual({ status: "unavailable", reason: "overflow" })

    // Above the profile: 64 KiB pages exhaust the reserve before CEILING rows.
    const heavy = await snapshotSite(LOCALES)
    const heavyTop = await publishedPage(heavy, "heavy", LOCALES, undefined, 64)
    await cloneVerifiedPages(heavy, heavyTop, "heavy", LOCALES, CEILING - 1)
    expect(
      await child(heavy.t, {
        languageVersion: 0,
        manifestVersion: 0,
        locale: "fr",
        ordinal: 0,
      })
    ).toEqual({ status: "unavailable", reason: "read_budget" })
  })
})
