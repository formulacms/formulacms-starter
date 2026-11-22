/// <reference types="vite/client" />

import { blockProfile } from "@/test-utils/block-profile"
import {
  finishMediaUsageBackfill,
  trashMediaDirectly,
} from "@/test-utils/media-usage-backfill"
import migrationsTest from "@convex-dev/migrations/test"
import { ConvexError, type Value } from "convex/values"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import type { Block } from "./lib/blocks"
import { MEDIA_KEYED_TABLES, MEDIA_STRING_KEYED } from "./lib/media/purge"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "media-purge-owner",
  tokenIdentifier: "media-purge-owner",
}
const PROFILE = ["hero-with-image", "rich-text-body"]

type Site = Awaited<ReturnType<typeof setup>>

async function setup() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  migrationsTest.register(t)
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", blocks: [] } },
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Media purge",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId: homeId,
      updatedAt: Date.now(),
    })
  )
  return { t, owner }
}

/** A real stored file. A distinct name gives a distinct URL. */
async function media(f: Site, name: string) {
  return f.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob([name], { type: "image/png" })
    )
    const url = `https://files.example.test/${name}`
    const mediaId = await ctx.db.insert("media", {
      filename: name,
      storageId,
      url,
      size: 10,
      mimeType: "image/png",
      width: 100,
      height: 50,
      uploadedAt: Date.now(),
    })
    return { mediaId, storageId, url }
  })
}
type Stored = Awaited<ReturnType<typeof media>>

const heroBlock = (m: Stored): Block =>
  ({
    id: "hero",
    type: "hero-with-image",
    enabled: true,
    primary: {
      eyebrow: "E",
      eyebrowLink: { type: "none" },
      title: "Hero",
      description: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
      image: {
        storageId: m.storageId,
        url: m.url,
        width: 100,
        height: 50,
        alt: "Hero",
      },
    },
    items: [],
  }) as Block

/** A rich-text body that shows the image the way the editor inserts it. */
const richBlock = (src: string): Block =>
  ({
    id: "body",
    type: "rich-text-body",
    enabled: true,
    primary: {
      body: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
          { type: "image", attrs: { src, alt: "x" } },
        ],
      }),
    },
  }) as Block

async function newPage(f: Site, slug: string, blocks: Block[]) {
  return f.owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    content: { en: { title: slug, blocks } },
  })
}

async function gens(f: Site, pageId: Id<"pages">) {
  return f.t.run(async (ctx) => ({
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

async function saveBlocks(f: Site, pageId: Id<"pages">, blocks: Block[]) {
  const g = await gens(f, pageId)
  return f.owner.mutation(api.cms.publication.saveEditorDraft, {
    pageId,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
    localized: {
      locale: "en",
      slug: (await f.t.run((ctx) => ctx.db.get("pages", pageId)))!.slug,
      expectedGeneration: g.locale.draftGeneration,
      draft: { pageType: "landing-page", localized: { title: "T" }, blocks },
    },
  })
}

async function publish(f: Site, pageId: Id<"pages">) {
  const g = await gens(f, pageId)
  return f.owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: g.locale.draftGeneration,
    expectedSharedDraftGeneration: g.shared.generation,
    expectedPublicGeneration: g.locale.publicGeneration,
    expectedReleaseGeneration: g.locale.releaseGeneration,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
  })
}

type Result = {
  id: Id<"media">
  status: "purged" | "refused"
  reason?: string
  code?: string
  detail?: {
    count: number
    uses: Array<{
      kind: string
      name: string
      where?: string
      inTrash?: boolean
    }>
    olderVersionsOnly: boolean
  }
}

/** Trash the file (directly: a used file cannot be trashed), finish the backfill, purge. */
async function purge(
  f: Site,
  ids: Id<"media">[],
  opts: { trash?: boolean } = {}
) {
  if (opts.trash !== false)
    for (const id of ids) await trashMediaDirectly(f.t, id)
  await finishMediaUsageBackfill(f.t)
  return (await f.owner.mutation(api.cms.media.purgeTrashedMedia, {
    ids,
  })) as Result[]
}

const exists = (f: Site, id: Id<"media">) =>
  f.t.run(async (ctx) => (await ctx.db.get("media", id)) !== null)
const fileExists = (f: Site, id: Id<"_storage">) =>
  f.t.run(async (ctx) => (await ctx.storage.get(id)) !== null)

async function richRows(f: Site, mediaId: Id<"media">) {
  const rows = await f.t.run((ctx) =>
    ctx.db
      .query("pagePublicationMediaReferences")
      .withIndex("by_mediaId_and_sourceKind", (q) => q.eq("mediaId", mediaId))
      .collect()
  )
  return rows.filter((row) => row.referenceKind === "rich-text-image")
}

const stable = (rows: Awaited<ReturnType<typeof richRows>>) =>
  rows
    .map((row) => {
      const { _id, _creationTime, createdAt, updatedAt, ...rest } = row
      void _id
      void _creationTime
      void createdAt
      void updatedAt
      return JSON.stringify(rest, Object.keys(rest).sort())
    })
    .sort()

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("schema closure", () => {
  test("every table with a media or storage id is classified", () => {
    const found = new Set<string>()
    const walk = (node: unknown, table: string) => {
      if (!node || typeof node !== "object") return
      const json = node as Record<string, unknown>
      if (
        json.type === "id" &&
        (json.tableName === "media" || json.tableName === "_storage")
      ) {
        found.add(table)
        return
      }
      for (const child of Object.values(json)) walk(child, table)
    }
    for (const [name, table] of Object.entries(schema.tables))
      walk(
        (table as unknown as { validator: { json: unknown } }).validator.json,
        name
      )
    expect([...found].filter((name) => !(name in MEDIA_KEYED_TABLES))).toEqual(
      []
    )
    // A classified table that no longer holds an id is a stale entry.
    expect(
      Object.keys(MEDIA_KEYED_TABLES).filter((name) => !found.has(name))
    ).toEqual([])
    for (const [name, info] of Object.entries(MEDIA_KEYED_TABLES))
      expect(info.reason, name).not.toEqual("")
    for (const entry of MEDIA_STRING_KEYED) {
      expect(entry.where).not.toEqual("")
      expect(entry.safe).not.toEqual("")
    }
    expect(MEDIA_STRING_KEYED.length).toBeGreaterThanOrEqual(4)
  })
})

describe("listTrashed", () => {
  test("pages newest deletion first and leaves live files out", async () => {
    const f = await setup()
    const [a, b, c, live] = [
      await media(f, "a.png"),
      await media(f, "b.png"),
      await media(f, "c.png"),
      await media(f, "live.png"),
    ]
    void live
    await f.t.run(async (ctx) => {
      await ctx.db.patch("media", a.mediaId, { deletedAt: 100 })
      await ctx.db.patch("media", b.mediaId, { deletedAt: 300 })
      await ctx.db.patch("media", c.mediaId, { deletedAt: 200 })
    })
    const first = await f.owner.query(api.cms.media.listTrashed, {
      paginationOpts: { numItems: 2, cursor: null },
    })
    expect(first.page.map((m) => m.filename)).toEqual(["b.png", "c.png"])
    expect(first.page[0]).toMatchObject({
      deletedAt: 300,
      url: b.url,
      width: 100,
      height: 50,
    })
    expect(first.isDone).toBe(false)
    const second = await f.owner.query(api.cms.media.listTrashed, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    })
    expect(second.page.map((m) => m.filename)).toEqual(["a.png"])
  })
})

describe("purge refusals", () => {
  test("a file that is not in Trash is refused and kept", async () => {
    const f = await setup()
    const m = await media(f, "live.png")
    const [r] = await purge(f, [m.mediaId], { trash: false })
    expect(r).toMatchObject({ status: "refused", reason: "not_trashed" })
    expect(await exists(f, m.mediaId)).toBe(true)
  })

  test(
    "a draft that shows the image refuses and names the page",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "draft.png")
      await newPage(f, "draft-page", [heroBlock(m)])
      const [r] = await purge(f, [m.mediaId])
      expect(r).toMatchObject({
        status: "refused",
        reason: "in_use",
        detail: {
          uses: [{ kind: "page", name: "draft-page", where: "draft" }],
        },
      })
      expect(await exists(f, m.mediaId)).toBe(true)
      expect(await fileExists(f, m.storageId)).toBe(true)
    }
  )

  test(
    "a published page refuses; editing the image away leaves only the older version, which still refuses",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "published.png")
      const pageId = await newPage(f, "pub-page", [heroBlock(m)])
      await publish(f, pageId)
      let [r] = await purge(f, [m.mediaId])
      expect(r?.detail?.uses.some((u) => u.where === "published")).toBe(true)
      await saveBlocks(f, pageId, [])
      await publish(f, pageId)
      ;[r] = await purge(f, [m.mediaId], { trash: false })
      // The first publish is an older version now (F08 clause 15).
      expect(r).toMatchObject({
        status: "refused",
        reason: "in_use",
        detail: { olderVersionsOnly: true },
      })
      expect(r?.detail?.uses[0]).toMatchObject({
        kind: "page",
        name: "pub-page",
        where: "older_version",
      })
      expect(await exists(f, m.mediaId)).toBe(true)
    }
  )

  test(
    "Move to Trash still allows a file only an older version shows",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "old.png")
      const pageId = await newPage(f, "old-page", [heroBlock(m)])
      await publish(f, pageId)
      await saveBlocks(f, pageId, [])
      await publish(f, pageId)
      await f.owner.mutation(api.cms.media.softDelete, { id: m.mediaId })
      expect(
        (await f.t.run((ctx) => ctx.db.get("media", m.mediaId)))?.deletedAt
      ).toEqual(expect.any(Number))
    }
  )

  test(
    "a rich-text image in a draft and in a published page refuses, and Move to Trash refuses too",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "rich.png")
      const pageId = await newPage(f, "rich-page", [richBlock(m.url)])
      await expect(
        f.owner.mutation(api.cms.media.softDelete, { id: m.mediaId })
      ).rejects.toThrow("MEDIA_SOFT_DELETE_REFERENCED")
      const draftRows = await richRows(f, m.mediaId)
      expect(draftRows).toEqual([
        expect.objectContaining({
          sourceKind: "locale_draft",
          sourcePath: "content.en.blocks[0].primary.body",
        }),
      ])
      let [r] = await purge(f, [m.mediaId])
      expect(r?.detail?.uses[0]).toMatchObject({
        name: "rich-page",
        where: "draft",
      })
      await publish(f, pageId)
      // Publishing clears the working draft; the older version and the
      // current projection carry the image.
      expect(
        (await richRows(f, m.mediaId)).map((row) => row.sourceKind).sort()
      ).toEqual(["candidate", "current_public"])
      await saveBlocks(f, pageId, [])
      ;[r] = await purge(f, [m.mediaId], { trash: false })
      expect(r?.detail?.uses.map((u) => u.where)).toEqual([
        "published",
        "older_version",
      ])
      expect(await exists(f, m.mediaId)).toBe(true)
    }
  )

  test("a live menu and a trashed menu both refuse", async () => {
    const f = await setup()
    const live = await media(f, "menu-live.png")
    const gone = await media(f, "menu-trashed.png")
    const nav = (m: Stored, id: string) => [
      {
        id,
        label: { en: id },
        panel: {
          columns: 2 as const,
          sections: [
            {
              id: "f",
              kind: "featured" as const,
              heading: { en: "F" },
              image: { storageId: m.storageId, url: m.url, alt: { en: "" } },
            },
          ],
        },
      },
    ]
    await f.t.run(async (ctx) => {
      await ctx.db.insert("menus", {
        slug: "primary",
        nav: nav(live, "a") as never,
        updatedAt: 1,
      })
      await ctx.db.insert("menus", {
        slug: "footer",
        nav: nav(gone, "b") as never,
        updatedAt: 1,
        deletedAt: 2,
      })
    })
    const results = await purge(f, [live.mediaId, gone.mediaId])
    expect(results[0]?.detail?.uses).toEqual([
      { kind: "menu", name: "primary" },
    ])
    expect(results[1]?.detail?.uses).toEqual([
      { kind: "menu", name: "footer", inTrash: true },
    ])
    expect(await exists(f, live.mediaId)).toBe(true)
    expect(await exists(f, gone.mediaId)).toBe(true)
    // Move to Trash refuses on a menu image too, and names the menu.
    const other = await media(f, "menu-live.png".replace("live", "again"))
    void other
    const data = await f.owner
      .mutation(api.cms.media.softDelete, { id: live.mediaId })
      .catch((error: ConvexError<Value>) => error.data)
    expect(data).toMatchObject({
      code: "MEDIA_SOFT_DELETE_REFERENCED",
      menus: ["primary"],
    })
  })

  test("the logo counts through its storage twin alone", async () => {
    const f = await setup()
    const m = await media(f, "logo.png")
    await f.t.run(async (ctx) => {
      const site = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", site._id, {
        logoStorageId: m.storageId,
      })
    })
    await expect(
      f.owner.mutation(api.cms.media.softDelete, { id: m.mediaId })
    ).rejects.toThrow("MEDIA_SOFT_DELETE_REFERENCED")
    const [r] = await purge(f, [m.mediaId])
    expect(r).toMatchObject({
      status: "refused",
      reason: "in_use",
      detail: { uses: [{ kind: "setting", name: "logo" }] },
    })
  })

  test("a legacy page reference blocks while its page is not deleted", async () => {
    const f = await setup()
    const m = await media(f, "legacy.png")
    const pageId = await newPage(f, "legacy-page", [])
    await f.t.run((ctx) =>
      ctx.db.insert("mediaReferences", {
        mediaId: m.mediaId,
        storageId: m.storageId,
        pageId,
        path: "cardImageMediaId",
        source: "card-image",
        updatedAt: 1,
      })
    )
    const [r] = await purge(f, [m.mediaId])
    expect(r).toMatchObject({ status: "refused", reason: "in_use" })
    await f.t.run((ctx) => ctx.db.patch("pages", pageId, { deletedAt: 5 }))
    const [after] = await purge(f, [m.mediaId], { trash: false })
    expect(after?.status).toBe("purged")
  })
})

describe("purge", () => {
  test("deletes the stored file and the row; a refused file never blocks the others", async () => {
    const f = await setup()
    const free = await media(f, "free.png")
    const used = await media(f, "used.png")
    await f.t.run(async (ctx) => {
      const site = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", site._id, {
        faviconMediaId: used.mediaId,
      })
    })
    const results = await purge(f, [free.mediaId, used.mediaId])
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["purged", undefined],
      ["refused", "in_use"],
    ])
    expect(await exists(f, free.mediaId)).toBe(false)
    expect(await fileExists(f, free.storageId)).toBe(false)
    expect(await exists(f, used.mediaId)).toBe(true)
    expect(await fileExists(f, used.storageId)).toBe(true)
  })

  test("a row whose stored object is already gone still purges", async () => {
    const f = await setup()
    const m = await media(f, "orphan.png")
    await f.t.run((ctx) => ctx.storage.delete(m.storageId))
    const [r] = await purge(f, [m.mediaId])
    expect(r?.status).toBe("purged")
    expect(await exists(f, m.mediaId)).toBe(false)
  })

  test("more than 50 files in one request is refused", async () => {
    const f = await setup()
    const ids = Array.from({ length: 51 }, () => "x" as unknown as Id<"media">)
    await expect(
      f.owner.mutation(api.cms.media.purgeTrashedMedia, { ids })
    ).rejects.toThrow()
    const real = await media(f, "m.png")
    const many = Array.from({ length: 51 }, () => real.mediaId)
    await expect(
      f.owner.mutation(api.cms.media.purgeTrashedMedia, { ids: many })
    ).rejects.toThrow("MEDIA_PURGE_BATCH_TOO_LARGE")
  })
})

describe("usage backfill gate", () => {
  test("nothing is deleted until the backfill has finished; the first call starts it", async () => {
    const f = await setup()
    const m = await media(f, "gate.png")
    await trashMediaDirectly(f.t, m.mediaId)
    const first = (await f.owner.mutation(api.cms.media.purgeTrashedMedia, {
      ids: [m.mediaId],
    })) as Result[]
    expect(first[0]).toMatchObject({
      status: "refused",
      reason: "index_pending",
      code: "MEDIA_USAGE_INDEX_PENDING",
    })
    expect(await exists(f, m.mediaId)).toBe(true)
    // The real path: scheduled migration steps drain, then the purge goes through.
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    const second = (await f.owner.mutation(api.cms.media.purgeTrashedMedia, {
      ids: [m.mediaId],
    })) as Result[]
    expect(second[0]?.status).toBe("purged")
  })
})

describe("backfill cron", () => {
  test("starts the backfill once, then does nothing", async () => {
    const f = await setup()
    const run = () =>
      f.t.mutation(
        internal.lib.media.richTextBackfill.startRichTextImageBackfillIfNeeded,
        {}
      )
    expect(await run()).toBe("started")
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await run()).toBe("done")
    expect(await run()).toBe("done")
    const m = await media(f, "cron.png")
    await trashMediaDirectly(f.t, m.mediaId)
    const [r] = (await f.owner.mutation(api.cms.media.purgeTrashedMedia, {
      ids: [m.mediaId],
    })) as Result[]
    expect(r?.status).toBe("purged")
  })
})

describe("rich-text image tracking", () => {
  test(
    "an external image never blocks publishing and writes no row",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const pageId = await newPage(f, "external", [
        richBlock("https://elsewhere.example.test/photo.png"),
      ])
      await expect(publish(f, pageId)).resolves.toBeDefined()
      const rows = await f.t.run((ctx) =>
        ctx.db.query("pagePublicationMediaReferences").collect()
      )
      expect(rows).toEqual([])
    }
  )

  test(
    "the backfill inserts exactly the rows publication writes, once",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "backfill.png")
      const pageId = await newPage(f, "backfill-page", [richBlock(m.url)])
      const forget = async (rows: Awaited<ReturnType<typeof richRows>>) =>
        f.t.run(async (ctx) => {
          for (const row of rows)
            await ctx.db.delete("pagePublicationMediaReferences", row._id)
        })
      // Working draft: written by the draft save, restored by the backfill.
      const draft = await richRows(f, m.mediaId)
      expect(draft.map((row) => row.sourceKind)).toEqual(["locale_draft"])
      await forget(draft)
      await finishMediaUsageBackfill(f.t)
      expect(stable(await richRows(f, m.mediaId))).toEqual(stable(draft))
      // Candidate and current projection after publishing.
      await publish(f, pageId)
      const written = await richRows(f, m.mediaId)
      expect(written.map((row) => row.sourceKind).sort()).toEqual([
        "candidate",
        "current_public",
      ])
      await forget(written)
      expect(await richRows(f, m.mediaId)).toEqual([])
      await f.t.run(async (ctx) => {
        const { components, internal } = await import("./_generated/api")
        const { runToCompletion } = await import("@convex-dev/migrations")
        for (const ref of [
          internal.lib.media.richTextBackfill.backfillRichTextImagesCandidates,
          internal.lib.media.richTextBackfill.backfillRichTextImagesSnapshots,
        ])
          await runToCompletion(
            ctx as unknown as Parameters<typeof runToCompletion>[0],
            components.migrations,
            ref,
            { cursor: null }
          )
      })
      expect(stable(await richRows(f, m.mediaId))).toEqual(stable(written))
      // A forced second run inserts nothing.
      const before = await richRows(f, m.mediaId)
      await f.t.run(async (ctx) => {
        const { components, internal } = await import("./_generated/api")
        const { runToCompletion } = await import("@convex-dev/migrations")
        for (const ref of [
          internal.lib.media.richTextBackfill.backfillRichTextImagesDrafts,
          internal.lib.media.richTextBackfill.backfillRichTextImagesCandidates,
          internal.lib.media.richTextBackfill.backfillRichTextImagesSnapshots,
        ])
          await runToCompletion(
            ctx as unknown as Parameters<typeof runToCompletion>[0],
            components.migrations,
            ref,
            { cursor: null }
          )
      })
      expect((await richRows(f, m.mediaId)).map((r) => r._id).sort()).toEqual(
        before.map((r) => r._id).sort()
      )
    }
  )

  test(
    "the backfill adds no current-public row for a withdrawn locale",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "withdrawn.png")
      const pageId = await newPage(f, "withdrawn-page", [richBlock(m.url)])
      const published = await publish(f, pageId)
      const g = await gens(f, pageId)
      await f.owner.mutation(api.cms.publication.withdrawLocale, {
        pageId,
        locale: "en",
        expectedSnapshotId: published.snapshotId,
        expectedPublicGeneration: g.locale.publicGeneration,
        expectedLifecycleGeneration: g.page.lifecycleGeneration,
      })
      const before = await richRows(f, m.mediaId)
      expect(before.map((row) => row.sourceKind)).toEqual(["candidate"])
      await f.t.run(async (ctx) => {
        for (const row of before)
          await ctx.db.delete("pagePublicationMediaReferences", row._id)
      })
      await finishMediaUsageBackfill(f.t)
      expect(stable(await richRows(f, m.mediaId))).toEqual(stable(before))
    }
  )

  test(
    "a purge after the backfill refuses a published rich-text image that predates tracking",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "predates.png")
      const pageId = await newPage(f, "predates-page", [richBlock(m.url)])
      await publish(f, pageId)
      await saveBlocks(f, pageId, [])
      await f.t.run(async (ctx) => {
        for (const row of await ctx.db
          .query("pagePublicationMediaReferences")
          .collect())
          await ctx.db.delete("pagePublicationMediaReferences", row._id)
      })
      // Without rows nothing is known; the backfill restores what is recoverable.
      const [r] = await purge(f, [m.mediaId])
      expect(r).toMatchObject({ status: "refused", reason: "in_use" })
      expect(r?.detail?.olderVersionsOnly).toBe(false)
    }
  )
})

describe("review round 1 fixes", () => {
  test("two rows sharing one stored file: the file goes with the last row only", async () => {
    const f = await setup()
    const a = await media(f, "shared.png")
    // A second row for the same stored object (two `media.create` calls).
    const bId = await f.t.run((ctx) =>
      ctx.db.insert("media", {
        filename: "shared-copy.png",
        storageId: a.storageId,
        url: a.url,
        size: 10,
        mimeType: "image/png",
        uploadedAt: Date.now(),
      })
    )
    const [first] = await purge(f, [a.mediaId])
    expect(first?.status).toBe("purged")
    expect(await exists(f, bId)).toBe(true)
    expect(await fileExists(f, a.storageId)).toBe(true)
    // Through the single-file entry too, and now the file goes.
    await trashMediaDirectly(f.t, bId)
    await f.owner.mutation(api.cms.media.remove, { id: bId })
    expect(await fileExists(f, a.storageId)).toBe(false)
  })

  test(
    "an image named by its stored file alone resolves when two rows share it",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const a = await media(f, "alias.png")
      await f.t.run((ctx) =>
        ctx.db.insert("media", {
          filename: "alias-copy.png",
          storageId: a.storageId,
          url: a.url,
          size: 10,
          mimeType: "image/png",
          uploadedAt: Date.now(),
        })
      )
      const block = heroBlock(a) as unknown as {
        primary: { image: Record<string, unknown> }
      }
      delete block.primary.image.url
      await expect(
        newPage(f, "alias-page", [block as unknown as Block])
      ).resolves.toBeTruthy()
    }
  )

  test("permanent delete is refused outside snapshot authority, before any write", async () => {
    const t = convexTest({ schema, modules, ownerIdentity: OWNER })
    migrationsTest.register(t)
    const owner = t.withIdentity(OWNER)
    const f = { t, owner } as unknown as Site
    const m = await media(f, "legacy.png")
    await trashMediaDirectly(t, m.mediaId)
    for (const call of [
      () =>
        owner.mutation(api.cms.media.purgeTrashedMedia, { ids: [m.mediaId] }),
      () => owner.mutation(api.cms.media.remove, { id: m.mediaId }),
    ])
      await expect(call()).rejects.toThrow("MEDIA_PURGE_NOT_AVAILABLE")
    expect(await exists(f, m.mediaId)).toBe(true)
    expect(await fileExists(f, m.storageId)).toBe(true)
    // The backfill was not started by the refused call.
    expect(
      await t.run((ctx) => ctx.db.query("purgedMediaUrls").collect())
    ).toEqual([])
  })

  test(
    "a deleted library image cannot come back through retained content; external images still work",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const gone = await media(f, "gone.png")
      const pageId = await newPage(f, "retained", [])
      const [r] = await purge(f, [gone.mediaId])
      expect(r?.status).toBe("purged")
      // A kept copy (such as retained AI output) still carries the old URL.
      await expect(
        saveBlocks(f, pageId, [richBlock(gone.url)])
      ).rejects.toThrow("PUBLICATION_MEDIA_REFERENCE_MISSING")
      // A genuinely external image is still fine, to save and to publish.
      await saveBlocks(f, pageId, [richBlock("https://elsewhere.test/pic.png")])
      await expect(publish(f, pageId)).resolves.toBeTruthy()
      // A library image whose stored file is missing is refused on save.
      const broken = await media(f, "broken.png")
      await f.t.run((ctx) => ctx.storage.delete(broken.storageId))
      await expect(
        saveBlocks(f, pageId, [richBlock(broken.url)])
      ).rejects.toThrow("PUBLICATION_MEDIA_STORAGE_MISSING")
    }
  )

  test(
    "a source too full for its image rows fails the backfill and purge stays refused",
    blockProfile(PROFILE),
    async () => {
      const f = await setup()
      const m = await media(f, "full.png")
      const filler = await media(f, "filler.png")
      const pageId = await newPage(f, "full-page", [richBlock(m.url)])
      await f.t.run(async (ctx) => {
        const draft = (await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_updatedAt", (q) => q.eq("pageId", pageId))
          .first())!
        // Forget the rich-text row (a source written before tracking) and
        // fill the source to the reference limit with other rows.
        for (const row of await ctx.db
          .query("pagePublicationMediaReferences")
          .collect())
          await ctx.db.delete("pagePublicationMediaReferences", row._id)
        for (let i = 0; i < 512; i += 1)
          await ctx.db.insert("pagePublicationMediaReferences", {
            pageId,
            locale: "en",
            mediaId: filler.mediaId,
            storageId: filler.storageId,
            sourcePath: `filler.${i}`,
            referenceKind: "block-image",
            sourceKind: "locale_draft",
            sourceId: draft._id,
            sourceGeneration: draft.generation,
            createdAt: 1,
            updatedAt: 1,
          })
      })
      const lone = await media(f, "lone.png")
      await trashMediaDirectly(f.t, lone.mediaId)
      await f.owner.mutation(api.cms.media.purgeTrashedMedia, {
        ids: [lone.mediaId],
      })
      await f.t.finishAllScheduledFunctions(vi.runAllTimers)
      const [r] = (await f.owner.mutation(api.cms.media.purgeTrashedMedia, {
        ids: [lone.mediaId],
      })) as Result[]
      expect(r).toMatchObject({
        status: "refused",
        reason: "index_pending",
        code: "MEDIA_USAGE_INDEX_FAILED",
      })
      expect(await exists(f, lone.mediaId)).toBe(true)
    }
  )
})
