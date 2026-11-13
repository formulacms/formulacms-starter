/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import { sliceProfile } from "../test-utils/slice-profile"
import {
  checkPageAddress,
  allocatePageAddress,
  readLiveAddressRows,
} from "./lib/publishing/snapshots"
import { futurePageAddress } from "./lib/contentTypes/routing"
import type { Id } from "./_generated/dataModel"

vi.mock("./lib/contentTypes/starterSelection", () => ({
  STARTER_CONTENT_TYPES: [
    "page",
    "landing-page",
    "post",
    "author",
    "testimonial",
    "job",
  ],
}))

const modules = import.meta.glob("./**/*.ts")
const identity = {
  subject: "address-owner",
  tokenIdentifier: "https://convex.test|address-owner",
}
async function fixture() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: identity,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(identity)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const create = (slug: string, parentId?: Id<"pages">) =>
    owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug,
      title: slug,
      parentId,
      content: { en: { title: slug, slices: [] } },
    })
  const home = await create("home")
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Addresses",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId: home,
      updatedAt: 1,
    })
  )
  const clocks = async (id: Id<"pages">) =>
    (await owner.query(api.cms.pages.getForEdit, { id }))!.publication!
  const publish = async (pageId: Id<"pages">, locale = "en") => {
    const p = await clocks(pageId),
      l = p.locales.find((l) => l.locale === locale)!
    return owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale,
      expectedLifecycleGeneration: p.lifecycleGeneration,
      expectedSharedDraftGeneration: p.sharedDraftGeneration,
      expectedDraftGeneration: l.draftGeneration,
      expectedPublicGeneration: l.publicGeneration,
      expectedReleaseGeneration: l.releaseGeneration,
    })
  }
  const save = async (
    pageId: Id<"pages">,
    slug: string,
    extra: {
      parentId?: Id<"pages">
      clearParent?: boolean
      addressIntent?: "typed" | "generated"
      title?: string
    } = {}
  ) => {
    const p = await clocks(pageId),
      l = p.locales.find((l) => l.locale === "en")!
    return owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: p.lifecycleGeneration,
      localized: {
        locale: "en",
        slug,
        addressIntent: extra.addressIntent,
        expectedGeneration: l.draftGeneration,
        draft: {
          pageType: "page",
          localized: { title: extra.title ?? slug },
          slices: [],
        },
      },
      ...(extra.parentId || extra.clearParent
        ? {
            shared: {
              expectedGeneration: p.sharedDraftGeneration,
              parentId: extra.parentId,
              clearParent: extra.clearParent,
            },
          }
        : {}),
    })
  }
  return { t, owner, create, publish, save, clocks, home }
}

describe("review round1 address identity regressions", () => {
  test.each(["retained-current", "former"] as const)(
    "trash restore respects a draft holder of the %s address after its own identifier changes",
    async (kind) => {
      const f = await fixture(),
        a = await f.create("old")
      await f.publish(a)
      if (kind === "former") {
        await f.save(a, "middle")
        await f.publish(a)
      }
      await f.save(a, "new")
      await f.owner.mutation(api.cms.publication.softDeletePage, {
        pageId: a,
        expectedLifecycleGeneration: 1,
      })
      const holder = await f.create("old")
      const restored = await f.owner.mutation(
        api.cms.publication.restoreSoftDeletedPage,
        {
          pageId: a,
          expectedLifecycleGeneration: 2,
        }
      )
      if (kind === "retained-current") {
        expect(restored.addressNotices?.[0]).toMatchObject({
          oldPath: "/old",
          newPath: "/new",
          check: { holder: { pageId: holder } },
        })
        expect((await f.clocks(a)).locales[0]?.state).toBe("draft")
      } else {
        const route = await f.t.run((ctx) =>
          ctx.db
            .query("pageHistoricalLocaleRoutes")
            .withIndex("by_locale_and_fromPath", (q) =>
              q.eq("locale", "en").eq("fromPath", "/old")
            )
            .unique()
        )
        expect(route?.releasedAt).toEqual(expect.any(Number))
      }
      await expect(f.publish(holder)).resolves.toBeDefined()
      expect(
        await f.t.query(api.cms.pages.resolveLocalizedPathQuery, {
          locale: "en",
          path: "/old",
          languageVersion: 0,
        })
      ).toBe(holder)
    }
  )
  test.each([
    {
      name: "migration identifier disagreement",
      locale: "en",
      pageType: "page",
      slug: "legacy",
      wanted: "/legacy",
      nested: false,
      home: false,
    },
    {
      name: "nested French locale-relative address",
      locale: "fr",
      pageType: "page",
      slug: "fiche",
      wanted: "/parent/fiche",
      nested: true,
      home: false,
    },
    {
      name: "content-type prefix",
      locale: "en",
      pageType: "author",
      slug: "alice",
      wanted: "/authors/alice",
      nested: false,
      home: false,
    },
    {
      name: "root home control",
      locale: "en",
      pageType: "page",
      slug: "home",
      wanted: "/",
      nested: false,
      home: true,
    },
  ] as const)(
    "computed then explicit paths share only the matching bucket: $name",
    async (input) => {
      const f = await fixture()
      await f.t.run(async (ctx) => {
        const site = await ctx.db.query("siteSettings").unique()
        await ctx.db.patch("siteSettings", site!._id, {
          enabledLocales: ["en", "fr"],
        })
      })
      const parentId = input.nested
        ? await f.owner.mutation(api.cms.pages.create, {
            pageType: "page",
            status: "draft",
            slug: "parent",
            title: "Parent",
            content: {
              en: { title: "Parent", slices: [] },
              fr: { title: "Parent", slices: [] },
            },
          })
        : undefined
      if (parentId) await f.publish(parentId, input.locale)
      const holder = input.home
        ? f.home
        : await f.owner.mutation(api.cms.pages.create, {
            pageType: input.pageType,
            status: "draft",
            slug: input.slug,
            title: input.slug,
            parentId,
            content: { [input.locale]: { title: input.slug, slices: [] } },
          })
      await f.t.run(async (ctx) => {
        const cache = new Map<string, Promise<unknown>>()
        const args = {
          pageId: input.home ? f.home : undefined,
          pageType: input.pageType,
          locale: input.locale,
          slug: "different-draft",
          parentId,
          homePageId: f.home,
          cache,
        }
        expect((await checkPageAddress(ctx, args)).kind).toBe("free")
        const explicit = await checkPageAddress(ctx, {
          ...args,
          path: input.wanted,
        })
        expect(explicit).toMatchObject(
          input.home
            ? { kind: "free", path: "/" }
            : { kind: "taken", path: input.wanted, holder: { pageId: holder } }
        )
        const computedPath = await futurePageAddress(ctx, args)
        const computedSlugs =
          computedPath === "/"
            ? [args.slug]
            : [...computedPath!.matchAll(/\//g)].map((match) =>
                computedPath!.slice(match.index + 1)
              )
        expect(
          [...cache.keys()].filter((key) => key.startsWith("drafts:")).sort()
        ).toEqual(
          [...new Set([...computedSlugs, ...(input.home ? [] : [input.slug])])]
            .map((slug) => `drafts:${input.locale}:${slug}`)
            .sort()
        )
        const query = vi.spyOn(ctx.db, "query")
        const get = vi.spyOn(ctx.db, "get")
        try {
          await checkPageAddress(ctx, args)
          await checkPageAddress(ctx, { ...args, path: input.wanted })
          expect(query).not.toHaveBeenCalled()
          expect(get).not.toHaveBeenCalled()
        } finally {
          query.mockRestore()
          get.mockRestore()
        }
      })
    }
  )
  test.each(["en", "fr"] as const)(
    "History restore in %s keeps identifier and parent without a notice for the other language's conflict",
    async (locale) => {
      const other = locale === "en" ? "fr" : "en",
        f = await fixture()
      await f.t.run(async (ctx) => {
        const site = await ctx.db.query("siteSettings").unique()
        await ctx.db.patch("siteSettings", site!._id, {
          enabledLocales: ["en", "fr"],
        })
      })
      const create = (slug: string, parentId?: Id<"pages">) =>
        f.owner.mutation(api.cms.pages.create, {
          pageType: "page",
          status: "draft",
          slug,
          title: slug,
          parentId,
          content: {
            en: { title: slug, slices: [] },
            fr: { title: slug, slices: [] },
          },
        })
      const p = await create("p"),
        q = await create("q")
      for (const id of [p, q])
        for (const language of ["en", "fr"]) await f.publish(id, language)
      const a = await create("historical", p)
      async function save(
        slug: string,
        language: string,
        parentId?: Id<"pages">
      ) {
        const clocks = await f.clocks(a),
          state = clocks.locales.find((row) => row.locale === language)!
        await f.owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: a,
          expectedLifecycleGeneration: clocks.lifecycleGeneration,
          localized: {
            locale: language,
            slug,
            expectedGeneration: state.draftGeneration,
            draft: { pageType: "page", localized: { title: slug }, slices: [] },
          },
          ...(parentId
            ? {
                shared: {
                  expectedGeneration: clocks.sharedDraftGeneration,
                  parentId,
                },
              }
            : {}),
        })
      }
      await save("fiche", other)
      const old = await f.publish(a, locale)
      await save("kept", locale, q)
      const holder = await create("fiche", p)
      await f.publish(holder, other)
      const clocks = await f.clocks(a),
        state = clocks.locales.find((row) => row.locale === locale)!
      const result = await f.owner.mutation(
        api.cms.publication.restoreSnapshotAsDraft,
        {
          pageId: a,
          locale,
          snapshotId: old.snapshotId,
          expectedDraftGeneration: state.draftGeneration,
          expectedSharedDraftGeneration: clocks.sharedDraftGeneration,
          expectedLifecycleGeneration: clocks.lifecycleGeneration,
          expectedPublicGeneration: state.publicGeneration,
          expectedReleaseGeneration: state.releaseGeneration,
        }
      )
      expect(result).not.toHaveProperty("addressNotices")
      const actual = await f.t.run(async (ctx) => ({
        shared: await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", a))
          .unique(),
        draft: await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", a).eq("locale", locale)
          )
          .unique(),
      }))
      expect(actual.shared?.system.parentId).toBe(q)
      expect(actual.draft?.slug).toBe("kept")
    }
  )
})

describe("round4 durable allocation provenance", () => {
  const cases = (["editor", "locale"] as const).flatMap((writer) =>
    (["en", "fr"] as const).flatMap((locale) =>
      (
        [
          "typed unchanged",
          "generated unchanged",
          "omitted unchanged",
          "changed identifier",
          "changed away and back",
          "mismatched allocation",
        ] as const
      ).map((mode) => ({ writer, locale, mode }))
    )
  )
  async function allocatedFixture() {
    const f = await fixture()
    await f.t.run(async (ctx) => {
      const site = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch("siteSettings", site._id, {
        enabledLocales: ["en", "fr"],
      })
    })
    const create = (slug: string, parentId?: Id<"pages">) =>
      f.owner.mutation(api.cms.pages.create, {
        pageType: "page",
        status: "draft",
        slug,
        parentId,
        title: "Contact",
        content: {
          en: { title: "Contact", slices: [] },
          fr: { title: "Contact", slices: [] },
        },
      })
    const holder = await create("contact"),
      id = await create("contact")
    const rows = () =>
      f.t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", id))
          .take(3)
      )
    const save = async (
      writer: "editor" | "locale",
      locale: string,
      slug: string,
      addressIntent?: "typed" | "generated",
      parentId?: Id<"pages">
    ) => {
      const clocks = await f.clocks(id),
        state = clocks.locales.find((l) => l.locale === locale)!
      const draft = {
        pageType: "page" as const,
        localized: { title: "Contact", metaDescription: "Content-only update" },
        slices: [],
      }
      return writer === "locale"
        ? f.owner.mutation(api.cms.publication.saveLocaleDraft, {
            pageId: id,
            locale,
            slug,
            addressIntent,
            draft,
            expectedDraftGeneration: state.draftGeneration,
            expectedLifecycleGeneration: clocks.lifecycleGeneration,
          })
        : f.owner.mutation(api.cms.publication.saveEditorDraft, {
            pageId: id,
            expectedLifecycleGeneration: clocks.lifecycleGeneration,
            localized: {
              locale,
              slug,
              addressIntent,
              draft,
              expectedGeneration: state.draftGeneration,
            },
            ...(parentId
              ? {
                  shared: {
                    parentId,
                    expectedGeneration: clocks.sharedDraftGeneration,
                  },
                }
              : {}),
          })
    }
    const reloaded = async (locale: string, slug: string, kept: boolean) => {
      const edit = await f.owner.query(api.cms.pages.getForEdit, { id })
      expect(edit?.page._id).toBe(id)
      const row = (await rows()).find((d) => d.locale === locale)!
      expect(row.slug).toBe(slug)
      const availability = await f.owner.query(
        api.cms.publication.addressAvailability,
        { pageId: id, locale }
      )
      const allocation = availability.entries.find(
        (e) => e.locale === locale
      )?.allocation
      if (kept) {
        expect(row.addressAllocation).toEqual({
          wantedSlug: "contact",
          allocatedSlug: "contact-2",
        })
        expect(allocation).toMatchObject({
          wantedSlug: "contact",
          allocatedSlug: "contact-2",
        })
      } else {
        expect(row.addressAllocation).toBeUndefined()
        expect(allocation).toBeUndefined()
      }
      return allocation
    }
    return { ...f, id, holder, create, rows, write: save, reloaded }
  }
  test.each(cases)(
    "$writer $locale $mode",
    async ({ writer, locale, mode }) => {
      const f = await allocatedFixture(),
        other = locale === "en" ? "fr" : "en"
      const untouched = (await f.rows()).find((d) => d.locale === other)
      if (mode === "mismatched allocation") {
        const row = (await f.rows()).find((d) => d.locale === locale)!
        await f.t.run((ctx) =>
          ctx.db.patch("pageLocaleDrafts", row._id, {
            addressAllocation: {
              wantedSlug: "contact",
              allocatedSlug: "stale-2",
            },
          })
        )
      }
      const changed =
        mode === "changed identifier" || mode === "changed away and back"
      const slug = changed ? "support" : "contact-2"
      const intent =
        mode === "generated unchanged"
          ? "generated"
          : mode === "omitted unchanged"
            ? undefined
            : "typed"
      await f.write(writer, locale, slug, intent)
      await f.reloaded(
        locale,
        slug,
        !changed && mode !== "mismatched allocation"
      )
      if (mode === "changed away and back") {
        await f.write(writer, locale, "contact-2", "typed")
        await f.reloaded(locale, "contact-2", false)
      }
      expect((await f.rows()).find((d) => d.locale === other)).toEqual(
        untouched
      )
      await f.reloaded(other, "contact-2", true)
    }
  )
  test.each(["en", "fr"] as const)(
    "target %s forced typed preserves unchanged allocation",
    async (locale) => {
      const f = await allocatedFixture(),
        source = locale === "en" ? "fr" : "en"
      await f.t.run(async (ctx) => {
        const site = (await ctx.db.query("siteSettings").unique())!
        await ctx.db.patch("siteSettings", site._id, {
          defaultLocale: source,
          enabledLocales: [source],
        })
        const owner = (await ctx.db
          .query("cmsOwner")
          .withIndex("by_key", (q) => q.eq("key", "owner"))
          .unique())!
        const transition = await ctx.db.insert("siteLanguageTransitions", {
          mode: "replace_content",
          sourceLocale: source,
          targetLocale: locale,
          phase: "preparing",
          generation: 1,
          startAuthorityVersion: 1,
          startSettingsUpdatedAt: 1,
          shortPath: false,
          sourcePublicSetVersion: 0,
          preparedSetVersion: 0,
          pageCount: 1,
          targetCount: 1,
          withdrawCount: 0,
          redirectCount: 0,
          unresolvedCount: 0,
          blockedCount: 0,
          targetDrafts: "retained",
          attribution: {
            kind: "owner",
            ownerId: owner._id,
            authId: owner.authId,
            tokenIdentifier: owner.tokenIdentifier,
          },
          createdAt: 1,
          updatedAt: 1,
        })
        await ctx.db.insert("siteLanguageAuthority", {
          key: "site-language-v1",
          currentLocale: source,
          version: 1,
          activeTransitionId: transition,
          updatedAt: 1,
        })
      })
      const before = (await f.rows()).find((d) => d.locale === source)
      await f.write("locale", locale, "contact-2", "generated")
      await f.reloaded(locale, "contact-2", true)
      expect((await f.rows()).find((d) => d.locale === source)).toEqual(before)
      await f.reloaded(source, "contact-2", true)
    }
  )
  test.each(
    (["en", "fr"] as const).flatMap((locale) =>
      [false, true].map((collision) => ({ locale, collision }))
    )
  )(
    "parent change $locale collision=$collision retains existing refusal and clear rules",
    async ({ locale, collision }) => {
      const f = await allocatedFixture(),
        parent = await f.create("folder")
      await f.publish(parent, "en")
      await f.publish(parent, "fr")
      if (collision) await f.create("contact-2", parent)
      const before = await f.rows()
      if (collision) {
        await expect(
          f.write("editor", locale, "contact-2", "typed", parent)
        ).rejects.toThrow("PAGE_PARENT_ADDRESS_TAKEN")
        expect(await f.rows()).toEqual(before)
      } else await f.write("editor", locale, "contact-2", "typed", parent)
      await f.reloaded(locale, "contact-2", collision)
      await f.reloaded(locale === "en" ? "fr" : "en", "contact-2", true)
    }
  )
})

describe("unique page address: transactional policies", () => {
  test("number create, retain allocation provenance, refuse typed, generate linked", async () => {
    const f = await fixture(),
      first = await f.create("contact"),
      second = await f.create("contact")
    const projected = await f.owner.query(api.cms.pages.getForEdit, {
      id: second,
    })
    expect(projected?.page.slug).toBe("contact-2")
    const notice = await f.owner.query(
      api.cms.publication.addressAvailability,
      { pageId: second, locale: "en" }
    )
    expect(notice.entries[0]?.allocation).toMatchObject({
      wantedSlug: "contact",
      allocatedSlug: "contact-2",
      check: { holder: { pageId: first } },
    })
    await expect(f.save(second, "contact")).rejects.toThrow(
      "PAGE_ADDRESS_TAKEN"
    )
    await f.save(second, "contact", { addressIntent: "generated" })
    expect(
      (await f.owner.query(api.cms.pages.getForEdit, { id: second }))?.page.slug
    ).toBe("contact-2")
    await f.save(second, "support", { addressIntent: "typed" })
    expect(
      (
        await f.owner.query(api.cms.publication.addressAvailability, {
          pageId: second,
          locale: "en",
        })
      ).entries[0]?.allocation
    ).toBeUndefined()
  })
  test("live and saved draft paths both block, own paths never conflict", async () => {
    const f = await fixture(),
      a = await f.create("old")
    await f.publish(a)
    await f.save(a, "next")
    expect(
      (
        await f.owner.query(api.cms.pages.getForEdit, {
          id: await f.create("old"),
        })
      )?.page.slug
    ).toBe("old-2")
    expect(
      (
        await f.owner.query(api.cms.pages.getForEdit, {
          id: await f.create("next"),
        })
      )?.page.slug
    ).toBe("next-2")
    await f.save(a, "old")
  })
  test("same identifier is allowed under different published parents; shared move refuses atomically", async () => {
    const f = await fixture(),
      p = await f.create("p"),
      q = await f.create("q")
    await f.publish(p)
    await f.publish(q)
    await f.create("contact", p)
    const b = await f.create("contact", q)
    const before = await f.owner.query(api.cms.pages.getForEdit, { id: b })
    await expect(
      f.save(b, "contact", { parentId: p, title: "not saved" })
    ).rejects.toThrow("PAGE_PARENT_ADDRESS_TAKEN")
    expect(await f.owner.query(api.cms.pages.getForEdit, { id: b })).toEqual(
      before
    )
  })
  test("legacy duplicate does not block unrelated content save but Publish refuses", async () => {
    const f = await fixture(),
      a = await f.create("a"),
      b = await f.create("b")
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", b).eq("locale", "en")
        )
        .unique()
      await ctx.db.patch("pageLocaleDrafts", row!._id, { slug: "a" })
    })
    await f.save(b, "a", { title: "title-only edit" })
    await expect(f.publish(b)).rejects.toThrow("PUBLISHED_LOCALE_ROUTE_TAKEN")
    expect(
      (await f.owner.query(api.cms.pages.getForEdit, { id: a }))?.page.slug
    ).toBe("a")
  })
  test("archives hold, trash frees, conflicting restore is unpublished and numbered", async () => {
    const f = await fixture(),
      a = await f.create("events")
    await f.publish(a)
    await f.owner.mutation(api.cms.publication.archivePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    const b = await f.create("events")
    expect(
      (await f.owner.query(api.cms.pages.getForEdit, { id: b }))?.page.slug
    ).toBe("events-2")
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: a,
      expectedLifecycleGeneration: 2,
    })
    const c = await f.create("events")
    await f.publish(c)
    expect(
      await f.t.query(api.cms.pages.resolveLocalizedPathQuery, {
        locale: "en",
        path: "/events",
        languageVersion: 0,
      })
    ).toBe(c)
    const restored = await f.owner.mutation(
      api.cms.publication.restoreSoftDeletedPage,
      { pageId: a, expectedLifecycleGeneration: 3 }
    )
    expect(restored.addressNotices?.[0]).toMatchObject({
      oldPath: "/events",
      newPath: "/events-3",
    })
    expect((await f.clocks(a)).locales[0]?.state).toBe("draft")
  })
  test("archived holder reports the verified French frozen title without a locale draft", async () => {
    const f = await fixture()
    await f.t.run(async (ctx) => {
      const site = await ctx.db.query("siteSettings").unique()
      await ctx.db.patch("siteSettings", site!._id, {
        enabledLocales: ["en", "fr"],
      })
    })
    const a = await f.owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug: "localized-holder",
      title: "English title",
      content: {
        en: { title: "English title", slices: [] },
        fr: { title: "Titre français conservé", slices: [] },
      },
    })
    await f.publish(a, "fr")
    await f.owner.mutation(api.cms.publication.archivePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    const check = await f.t.run((ctx) =>
      checkPageAddress(ctx, {
        pageType: "page",
        locale: "fr",
        slug: "localized-holder",
      })
    )
    expect(check).toMatchObject({
      kind: "archived",
      holder: { pageId: a, title: "Titre français conservé" },
    })
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", a).eq("locale", "fr")
          )
          .take(2)
      )
    ).toEqual([])
  })
  test("parent republish checks published direct children before any selection", async () => {
    const f = await fixture(),
      p = await f.create("products")
    await f.publish(p)
    const child = await f.create("cards", p)
    await f.publish(child)
    // A legacy route holder represents an already live cross-type/path conflict.
    const holder = await f.create("holder")
    await f.publish(holder)
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", holder).eq("locale", "en")
        )
        .unique()
      await ctx.db.patch("pageLocalePublicationStates", row!._id, {
        currentPath: "/shop/cards",
      })
    })
    await f.save(p, "shop")
    const before = await f.clocks(p)
    await expect(f.publish(p)).rejects.toThrow("PUBLISHED_CHILD_ROUTE_TAKEN")
    expect(await f.clocks(p)).toEqual(before)
  })
  test("query authenticates before returning holder details", async () => {
    const f = await fixture(),
      a = await f.create("a")
    await expect(
      f.t.query(api.cms.publication.addressAvailability, {
        pageId: a,
        locale: "en",
        slug: "home",
      })
    ).rejects.toThrow("UNAUTHENTICATED")
  })
  test.each(["admin", "setup", "sign-in", "api", "authors", "jobs", "fr"])(
    "reserved first segment %s numbers on create and refuses typed",
    async (slug) => {
      const f = await fixture(),
        a = await f.create(slug)
      expect(
        (await f.owner.query(api.cms.pages.getForEdit, { id: a }))?.page.slug
      ).toBe(`${slug}-2`)
      await expect(f.save(a, slug)).rejects.toThrow(
        slug === "fr"
          ? "LANGUAGE_LOCALE_PREFIX_RESERVED"
          : "PAGE_ADDRESS_SYSTEM_RESERVED"
      )
    }
  )
  test("100-row bucket/route caps fail closed, including filtered trash", async () => {
    const f = await fixture(),
      a = await f.create("taken")
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", a).eq("locale", "en")
        )
        .unique()
      for (let i = 0; i < 100; i++) {
        const { _id, _creationTime, ...copy } = row!
        void _id
        void _creationTime
        await ctx.db.insert("pageLocaleDrafts", copy)
      }
    })
    await expect(f.create("taken")).rejects.toThrow("PAGE_ADDRESS_LOOKUP_LIMIT")
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 101; i++)
        await ctx.db.insert("pageLocalePublicationStates", {
          pageId: a,
          locale: "en",
          currentPath: "/overflow",
          draftGeneration: 1,
          publicGeneration: 0,
          releaseGeneration: 0,
          hasCurrentSnapshot: false,
          updatedAt: 1,
        })
      expect(await readLiveAddressRows(ctx, "en", "/overflow")).toBeNull()
    })
  })
  test("numbering exhausts at -50, does not loop", async () => {
    const f = await fixture()
    for (let i = 1; i <= 50; i++) await f.create(i === 1 ? "x" : `x-${i}`)
    await expect(
      f.t.run((ctx) =>
        allocatePageAddress(ctx, { pageType: "page", locale: "en", slug: "x" })
      )
    ).rejects.toThrow("PAGE_ADDRESS_LOOKUP_LIMIT")
  })
  test("all routable types share one comparison; virtual-root types skip ancestry", async () => {
    const f = await fixture(),
      p = await f.create("parent")
    await f.publish(p)
    await f.t.run(async (ctx) => {
      for (const type of ["page", "landing-page", "post"])
        expect(
          await futurePageAddress(ctx, {
            pageType: type,
            locale: "en",
            slug: "same",
            parentId: p,
          })
        ).toBe("/parent/same")
      expect(
        await futurePageAddress(ctx, {
          pageType: "author",
          locale: "en",
          slug: "alice",
          parentId: p,
        })
      ).toBe("/authors/alice")
      expect(
        await futurePageAddress(ctx, {
          pageType: "job",
          locale: "en",
          slug: "writer",
          parentId: p,
        })
      ).toBe("/jobs/writer")
      expect(
        (
          await checkPageAddress(ctx, {
            pageType: "testimonial",
            locale: "en",
            slug: "parent",
          })
        ).path
      ).toBeNull()
    })
  })
  test("stale availability never authorizes a Save after another writer claims it", async () => {
    const f = await fixture(),
      b = await f.create("b")
    expect(
      (
        await f.owner.query(api.cms.publication.addressAvailability, {
          pageId: b,
          locale: "en",
          slug: "new",
        })
      ).entries[0]?.check.kind
    ).toBe("free")
    await f.create("new")
    const before = await f.owner.query(api.cms.pages.getForEdit, { id: b })
    await expect(f.save(b, "new", { title: "unsaved title" })).rejects.toThrow(
      "PAGE_ADDRESS_TAKEN"
    )
    expect(await f.owner.query(api.cms.pages.getForEdit, { id: b })).toEqual(
      before
    )
  })
  test("released former claims stay released; history retains current parent and identifier", async () => {
    const f = await fixture(),
      parent = await f.create("services")
    await f.publish(parent)
    const a = await f.create("contact"),
      first = await f.publish(a)
    await f.save(a, "contact", { parentId: parent })
    await f.publish(a)
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    const other = await f.create("contact")
    await f.publish(other)
    await f.owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
      pageId: a,
      expectedLifecycleGeneration: 2,
    })
    const released = await f.t.run((ctx) =>
      ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) =>
          q.eq("locale", "en").eq("fromPath", "/contact")
        )
        .take(2)
    )
    expect(released.find((row) => row.pageId === a)?.releasedAt).toEqual(
      expect.any(Number)
    )
    const p = await f.clocks(a),
      l = p.locales[0]!
    const result = await f.owner.mutation(
      api.cms.publication.restoreSnapshotAsDraft,
      {
        pageId: a,
        locale: "en",
        snapshotId: first.snapshotId,
        expectedDraftGeneration: l.draftGeneration,
        expectedSharedDraftGeneration: p.sharedDraftGeneration,
        expectedLifecycleGeneration: p.lifecycleGeneration,
        expectedPublicGeneration: l.publicGeneration,
        expectedReleaseGeneration: l.releaseGeneration,
      }
    )
    expect(result.addressNotices?.[0]).toMatchObject({
      oldPath: "/contact",
      newPath: "/services/contact",
    })
    expect(
      (await f.owner.query(api.cms.pages.getForEdit, { id: a }))?.page.parentId
    ).toBe(parent)
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: other,
      expectedLifecycleGeneration: 1,
    })
    expect(
      (
        await f.owner.query(api.cms.pages.getForEdit, {
          id: await f.create("contact"),
        })
      )?.page.slug
    ).toBe("contact")
  })
  test("trash restore unpublishes only the language whose address was reused", async () => {
    const f = await fixture()
    await f.t.run(async (ctx) => {
      const site = await ctx.db.query("siteSettings").unique()
      await ctx.db.patch("siteSettings", site!._id, {
        enabledLocales: ["en", "fr"],
      })
    })
    const a = await f.owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug: "events",
      title: "Events",
      content: {
        en: { title: "Events", slices: [] },
        fr: { title: "Événements", slices: [] },
      },
    })
    await f.publish(a)
    await f.publish(a, "fr")
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    const other = await f.create("events")
    await f.publish(other)
    const before = await f.t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", a).eq("locale", "fr")
        )
        .unique()
    )
    await f.owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
      pageId: a,
      expectedLifecycleGeneration: 2,
    })
    const after = await f.clocks(a)
    expect(after.locales.find((l) => l.locale === "en")?.state).toBe("draft")
    const afterFr = await f.t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", a).eq("locale", "fr")
        )
        .unique()
    )
    expect(afterFr).toEqual(before)
  })
  test("trash restore keeps a language published when only its draft address is reused", async () => {
    const f = await fixture()
    const a = await f.create("events")
    await f.publish(a)
    await f.save(a, "agenda")
    const stateOf = (locale: string) =>
      f.t.run((ctx) =>
        ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", a).eq("locale", locale)
          )
          .unique()
      )
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    const before = (await stateOf("en"))!
    expect(before.hasCurrentSnapshot).toBe(true)
    const other = await f.create("agenda")
    const restored = await f.owner.mutation(
      api.cms.publication.restoreSoftDeletedPage,
      { pageId: a, expectedLifecycleGeneration: 2 }
    )
    expect(
      await f.t.query(api.cms.pages.resolveLocalizedPathQuery, {
        locale: "en",
        path: "/events",
        languageVersion: 0,
      })
    ).toBe(a)
    const after = (await stateOf("en"))!
    expect(after.hasCurrentSnapshot).toBe(true)
    expect(after.currentSnapshotId).toBe(before.currentSnapshotId)
    expect(after.currentPath).toBe(before.currentPath)
    expect(after.publicGeneration).toBe(before.publicGeneration)
    expect(after.draftGeneration).toBeGreaterThan(before.draftGeneration)
    expect(restored.addressNotices).toHaveLength(1)
    expect(restored.addressNotices?.[0]).toMatchObject({
      locale: "en",
      oldPath: "/agenda",
      newPath: "/agenda-2",
      kept: "published",
      check: { holder: { pageId: other } },
    })
    const draft = await f.t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", a).eq("locale", "en")
        )
        .unique()
    )
    expect(draft?.slug).toBe("agenda-2")
  })
  test("archived restore keeps a language whose live address is free", async () => {
    const f = await fixture()
    const a = await f.create("events")
    await f.publish(a)
    await f.save(a, "agenda")
    const stateOf = (locale: string) =>
      f.t.run((ctx) =>
        ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", a).eq("locale", locale)
          )
          .unique()
      )
    await f.owner.mutation(api.cms.publication.archivePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: a,
      expectedLifecycleGeneration: 2,
    })
    const before = (await stateOf("en"))!
    expect(before.hasCurrentSnapshot).toBe(true)
    await f.create("agenda")
    const restored = await f.owner.mutation(
      api.cms.publication.restoreSoftDeletedPage,
      { pageId: a, expectedLifecycleGeneration: 3 }
    )
    const pageState = await f.t.run((ctx) =>
      ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", a))
        .unique()
    )
    expect(pageState?.lifecycleState).toBe("archived")
    expect(restored.addressNotices).toHaveLength(1)
    expect(restored.addressNotices?.[0]).toMatchObject({
      locale: "en",
      oldPath: "/agenda",
      kept: "archived",
    })
    const after = (await stateOf("en"))!
    expect(after.hasCurrentSnapshot).toBe(true)
    expect(after.currentSnapshotId).toBe(before.currentSnapshotId)
    expect(after.currentPath).toBe(before.currentPath)
    expect(after.publicGeneration).toBe(before.publicGeneration)
    const draft = await f.t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", a).eq("locale", "en")
        )
        .unique()
    )
    expect(draft?.slug).toBe("agenda-2")
    const resolveEvents = () =>
      f.t.query(api.cms.pages.resolveLocalizedPathQuery, {
        locale: "en",
        path: "/events",
        languageVersion: 0,
      })
    expect(await resolveEvents()).toBeNull()
    // Unarchive: the kept publication serves the page again.
    await f.owner.mutation(api.cms.publication.restorePage, {
      pageId: a,
      expectedLifecycleGeneration: restored.lifecycleGeneration,
    })
    expect(await resolveEvents()).toBe(a)
  })
  test("archived restore keeps the live address held against other pages until Unarchive", async () => {
    const f = await fixture()
    const a = await f.create("events")
    await f.publish(a)
    await f.save(a, "agenda")
    await f.owner.mutation(api.cms.publication.archivePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: a,
      expectedLifecycleGeneration: 2,
    })
    await f.create("agenda")
    const restored = await f.owner.mutation(
      api.cms.publication.restoreSoftDeletedPage,
      { pageId: a, expectedLifecycleGeneration: 3 }
    )
    // While A is archived and kept, a third page cannot take /events.
    const third = await f.create("events")
    expect(
      (await f.owner.query(api.cms.pages.getForEdit, { id: third }))?.page.slug
    ).toBe("events-2")
    await expect(f.save(third, "events")).rejects.toThrow(
      "PAGE_ADDRESS_ARCHIVED"
    )
    await f.owner.mutation(api.cms.publication.restorePage, {
      pageId: a,
      expectedLifecycleGeneration: restored.lifecycleGeneration,
    })
    expect(
      await f.t.query(api.cms.pages.resolveLocalizedPathQuery, {
        locale: "en",
        path: "/events",
        languageVersion: 0,
      })
    ).toBe(a)
  })
  test("trash restore splits per language: draft-only conflict stays live, live conflict unpublishes", async () => {
    const f = await fixture()
    await f.t.run(async (ctx) => {
      const site = await ctx.db.query("siteSettings").unique()
      await ctx.db.patch("siteSettings", site!._id, {
        enabledLocales: ["en", "fr"],
      })
    })
    const a = await f.owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug: "events",
      title: "Events",
      content: {
        en: { title: "Events", slices: [] },
        fr: { title: "Événements", slices: [] },
      },
    })
    await f.publish(a)
    await f.publish(a, "fr")
    await f.save(a, "agenda")
    const stateOf = (locale: string) =>
      f.t.run((ctx) =>
        ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", a).eq("locale", locale)
          )
          .unique()
      )
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: a,
      expectedLifecycleGeneration: 1,
    })
    const beforeEn = (await stateOf("en"))!
    // The other page: en address /agenda (reuses A's draft address) and
    // fr address /events published (reuses A's live French address).
    const other = await f.owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug: "agenda",
      title: "Agenda",
      content: {
        en: { title: "Agenda", slices: [] },
        fr: { title: "Agenda", slices: [] },
      },
    })
    const op = await f.clocks(other)
    const ofr = op.locales.find((l) => l.locale === "fr")!
    await f.owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId: other,
      expectedLifecycleGeneration: op.lifecycleGeneration,
      localized: {
        locale: "fr",
        slug: "events",
        expectedGeneration: ofr.draftGeneration,
        draft: {
          pageType: "page",
          localized: { title: "Agenda" },
          slices: [],
        },
      },
    })
    await f.publish(other, "fr")
    const restored = await f.owner.mutation(
      api.cms.publication.restoreSoftDeletedPage,
      { pageId: a, expectedLifecycleGeneration: 2 }
    )
    const afterEn = (await stateOf("en"))!
    expect(afterEn.hasCurrentSnapshot).toBe(true)
    expect(afterEn.currentSnapshotId).toBe(beforeEn.currentSnapshotId)
    expect(afterEn.publicGeneration).toBe(beforeEn.publicGeneration)
    const afterFr = (await stateOf("fr"))!
    expect(afterFr.hasCurrentSnapshot).toBe(false)
    const en = restored.addressNotices?.find((n) => n.locale === "en")
    const fr = restored.addressNotices?.find((n) => n.locale === "fr")
    expect(en).toMatchObject({ oldPath: "/agenda", kept: "published" })
    expect(fr).toBeDefined()
    expect(fr).not.toHaveProperty("kept")
  })
  test.each([
    "loose text beside blocks",
    "nested lists and trailing words",
    "Word paragraph with bold text",
    "Google Docs paragraph and link",
    "first paragraph",
    "last paragraph",
    "nonbreaking space: A\u00a0B",
    'plain JSON {"page":true} and Markdown **text**',
  ])(
    "round trip preserves every word and mark: %s",
    sliceProfile(["rich-text-body"]),
    async (words) => {
      const f = await fixture(),
        a = await f.create("round-trip")
      async function write(href: string) {
        const p = await f.clocks(a),
          l = p.locales[0]!
        return f.owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: a,
          expectedLifecycleGeneration: p.lifecycleGeneration,
          localized: {
            locale: "en",
            slug: "round-trip",
            expectedGeneration: l.draftGeneration,
            draft: {
              pageType: "page",
              localized: { title: "Round trip" },
              slices: [
                {
                  id: "body-1",
                  type: "rich-text-body",
                  enabled: true,
                  primary: {
                    body: JSON.stringify({
                      type: "doc",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "text",
                              text: words,
                              marks: [
                                { type: "bold" },
                                { type: "link", attrs: { href } },
                              ],
                            },
                          ],
                        },
                        { type: "paragraph" },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        })
      }
      await write("/first")
      const before = (await f.owner.query(api.cms.pages.getForEdit, { id: a }))!
        .page.content
      await write("/first")
      expect(
        (await f.owner.query(api.cms.pages.getForEdit, { id: a }))!.page.content
      ).toEqual(before)
      await write("/changed")
      const after = JSON.stringify(
        (await f.owner.query(api.cms.pages.getForEdit, { id: a }))!.page.content
      )
      expect(after).toContain("/changed")
      expect(after).toContain("bold")
      expect(after).toContain("body-1")
      const localized = (await f.owner.query(api.cms.pages.getForEdit, {
        id: a,
      }))!.page.content!.en!
      if (!("slices" in localized))
        throw new Error("Expected the page slice body")
      const loaded = localized.slices
      const body = JSON.parse(
        (loaded[0] as { primary: { body: string } }).primary.body
      ) as { content: Array<{ content?: Array<{ text: string }> }> }
      expect(
        body.content
          .flatMap((p) => p.content ?? [])
          .map((t) => t.text)
          .join(" ")
      ).toBe(words)
    }
  )
})

type LiteralSplit = {
  slug: string
  parent?: string
  type?: "page" | "post" | "author"
}
type LiteralSplitCase = {
  name: string
  locale: "en" | "fr"
  paths: readonly [string, string]
  shapes: readonly [LiteralSplit, LiteralSplit]
  control?: "home" | "different" | "override"
}
const literalSplitCases: LiteralSplitCase[] = [
  {
    name: "root vs parent",
    locale: "en",
    paths: ["/section/item", "/section/item"],
    shapes: [{ slug: "section/item" }, { slug: "item", parent: "/section" }],
  },
  {
    name: "depth two",
    locale: "en",
    paths: ["/a/b/c", "/a/b/c"],
    shapes: [
      { slug: "b/c", parent: "/a" },
      { slug: "c", parent: "/a/b" },
    ],
  },
  {
    name: "content-type prefix",
    locale: "en",
    paths: ["/authors/x/y", "/authors/x/y"],
    shapes: [
      { slug: "x/y", type: "author" },
      { slug: "x/y", type: "author" },
    ],
  },
  {
    name: "French locale-relative",
    locale: "fr",
    paths: ["/section/fiche", "/section/fiche"],
    shapes: [{ slug: "section/fiche" }, { slug: "fiche", parent: "/section" }],
  },
  {
    name: "leading slash",
    locale: "en",
    paths: ["//item", "//item"],
    shapes: [{ slug: "/item" }, { slug: "item", parent: "/" }],
  },
  {
    name: "trailing slash",
    locale: "en",
    paths: ["/section/item/", "/section/item/"],
    shapes: [{ slug: "section/item/" }, { slug: "item/", parent: "/section" }],
  },
  {
    name: "doubled slash",
    locale: "en",
    paths: ["/a//b/", "/a//b/"],
    shapes: [{ slug: "a//b/" }, { slug: "/b/", parent: "/a" }],
  },
  {
    name: "author composite explicit path",
    locale: "en",
    paths: ["/authors/a/b", "/authors/a/b"],
    shapes: [
      { slug: "a/b", type: "author" },
      { slug: "a/b", type: "author" },
    ],
  },
  {
    name: "parent republish override",
    locale: "en",
    paths: ["/proposed/item", "/proposed/item"],
    shapes: [{ slug: "proposed/item" }, { slug: "item", parent: "/before" }],
    control: "override",
  },
  {
    name: "identifier exceeds parent depth",
    locale: "en",
    paths: [
      "/one/two/three/four/five/six/seven/item",
      "/one/two/three/four/five/six/seven/item",
    ],
    shapes: [
      { slug: "one/two/three/four/five/six/seven/item" },
      { slug: "two/three/four/five/six/seven/item", parent: "/one" },
    ],
  },
  {
    name: "home identity and self",
    locale: "en",
    paths: ["/", "/"],
    shapes: [{ slug: "home" }, { slug: "home/next" }],
    control: "home",
  },
  {
    name: "same suffix different full path",
    locale: "en",
    paths: ["/one/item", "/two/item"],
    shapes: [
      { slug: "item", parent: "/one" },
      { slug: "item", parent: "/two" },
    ],
    control: "different",
  },
]
async function literalSplitFixture(locale: "en" | "fr") {
  const f = await fixture()
  if (locale === "fr")
    await f.t.run(async (ctx) => {
      const settings = await ctx.db.query("siteSettings").unique()
      await ctx.db.patch("siteSettings", settings!._id, {
        enabledLocales: ["en", "fr"],
      })
    })
  const parents = new Map<string, Id<"pages">>()
  async function parent(path?: string): Promise<Id<"pages"> | undefined> {
    if (!path) return undefined
    if (parents.has(path)) return parents.get(path)!
    if (path === "/") {
      await f.publish(f.home, locale)
      parents.set(path, f.home)
      return f.home
    }
    const split = path.lastIndexOf("/")
    const parentId = split > 0 ? await parent(path.slice(0, split)) : undefined
    const id = await f.owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug: path.slice(split + 1),
      title: "Parent",
      parentId,
      content: { [locale]: { title: "Parent", slices: [] } },
    })
    await f.publish(id, locale)
    parents.set(path, id)
    return id
  }
  async function create(shape: LiteralSplit, slug = shape.slug) {
    return f.owner.mutation(api.cms.pages.create, {
      pageType: shape.type ?? "page",
      status: "draft",
      slug,
      title: "Split page",
      ...(shape.type === "author" ? { name: "Split author" } : {}),
      parentId: await parent(shape.parent),
      content: { [locale]: { title: "Split page", slices: [] } },
    })
  }
  async function save(id: Id<"pages">, shape: LiteralSplit, slug = shape.slug) {
    const p = await f.clocks(id),
      state = p.locales.find((row) => row.locale === locale)!
    return f.owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId: id,
      expectedLifecycleGeneration: p.lifecycleGeneration,
      localized: {
        locale,
        slug,
        addressIntent: "typed",
        expectedGeneration: state.draftGeneration,
        draft: {
          pageType: shape.type ?? "page",
          localized: { title: "Split page" },
          slices: [],
        },
      },
    })
  }
  const availability = (id: Id<"pages">, slug: string) =>
    f.owner.query(api.cms.publication.addressAvailability, {
      pageId: id,
      locale,
      slug,
    })
  const state = (id: Id<"pages">) =>
    f.t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", id).eq("locale", locale)
        )
        .unique()
    )
  return {
    ...f,
    parent,
    createShape: create,
    saveShape: save,
    availability,
    localeState: state,
  }
}

describe("review round2 literal address split class", () => {
  test.each(
    literalSplitCases.flatMap((input) =>
      ([0, 1] as const).map((first) => ({ ...input, first }))
    )
  )(
    "$name preserves holder side $first through availability, Save and explicit restore",
    async (input) => {
      const first = input.shapes[input.first],
        secondIndex = input.first === 0 ? 1 : 0,
        second = input.shapes[secondIndex]
      const f = await literalSplitFixture(input.locale)
      if (input.control === "home") {
        await f.create("home")
        expect(
          (await f.availability(f.home, second.slug)).entries[0]?.check
        ).toMatchObject({ kind: "free", path: "/" })
        await f.saveShape(f.home, second)
        await f.t.run(async (ctx) => {
          expect(
            await checkPageAddress(ctx, {
              pageId: f.home,
              pageType: "page",
              locale: input.locale,
              slug: second.slug,
              homePageId: f.home,
              path: "/",
            })
          ).toMatchObject({ kind: "free", path: "/" })
        })
        return
      }
      if (input.control === "override") {
        const parentId = await f.parent(
          input.first === 0 ? "/before" : "/proposed"
        )
        const child = await f.createShape({
          slug: "item",
          parent: input.first === 0 ? "/before" : "/proposed",
        })
        await f.publish(child)
        if (input.first === 0) {
          const holder = await f.createShape(first)
          expect(
            (await f.availability(parentId!, "proposed")).entries[0]?.check.kind
          ).toBe("free")
          await f.saveShape(parentId!, { slug: "proposed" })
          await f.t.run(async (ctx) => {
            expect(
              await checkPageAddress(ctx, {
                pageId: child,
                pageType: "page",
                locale: "en",
                slug: "item",
                parentId,
                parentPathOverride: { pageId: parentId!, path: "/proposed" },
                homePageId: f.home,
              })
            ).toMatchObject({
              kind: "taken",
              path: "/proposed/item",
              holder: { pageId: holder },
            })
          })
          await expect(f.publish(parentId!)).rejects.toThrow(
            "PUBLISHED_CHILD_ROUTE_TAKEN"
          )
          expect((await f.localeState(parentId!))?.currentPath).toBe("/before")
          await f.publish(holder)
        } else {
          const candidate = await f.createShape({ slug: "neutral" })
          expect(
            (await f.availability(candidate, "proposed/item")).entries[0]?.check
          ).toMatchObject({ kind: "taken", holder: { pageId: child } })
          await expect(
            f.saveShape(candidate, { slug: "proposed/item" })
          ).rejects.toThrow("PAGE_ADDRESS_TAKEN")
          await f.publish(parentId!)
          expect((await f.localeState(child))?.currentPath).toBe(
            "/proposed/item"
          )
        }
        return
      }
      await f.parent(first.parent)
      await f.parent(second.parent)
      const wantedPath = input.paths[secondIndex]
      const cache = new Map<string, Promise<unknown>>()
      await f.t.run(async (ctx) => {
        expect(
          (
            await checkPageAddress(ctx, {
              pageType: second.type ?? "page",
              locale: input.locale,
              slug: "unrelated",
              homePageId: f.home,
              path: wantedPath,
              cache,
            })
          ).kind
        ).toBe("free")
      })
      const holder = await f.createShape(first),
        neutral = "neutral-candidate",
        candidate = await f.createShape(second, neutral)
      const collision = input.control !== "different"
      expect(
        (await f.availability(candidate, second.slug)).entries[0]?.check
      ).toMatchObject(
        collision
          ? { kind: "taken", path: wantedPath, holder: { pageId: holder } }
          : { kind: "free", path: wantedPath }
      )
      await f.t.run(async (ctx) => {
        expect(
          await checkPageAddress(ctx, {
            pageId: candidate,
            pageType: second.type ?? "page",
            locale: input.locale,
            slug: "unrelated",
            homePageId: f.home,
            path: wantedPath,
          })
        ).toMatchObject(
          collision
            ? { kind: "taken", holder: { pageId: holder } }
            : { kind: "free" }
        )
      })
      if (collision) {
        await expect(f.saveShape(candidate, second)).rejects.toThrow(
          "PAGE_ADDRESS_TAKEN"
        )
        const draft = await f.t.run((ctx) =>
          ctx.db
            .query("pageLocaleDrafts")
            .withIndex("by_pageId_and_locale", (q) =>
              q.eq("pageId", candidate).eq("locale", input.locale)
            )
            .unique()
        )
        expect(draft?.slug).toBe(neutral)
      } else await f.saveShape(candidate, second)
      await f.publish(holder, input.locale)
      expect((await f.localeState(holder))?.currentPath).toBe(
        input.paths[input.first]
      )
      if (!collision) await f.publish(candidate, input.locale)

      for (const kind of ["retained-current", "former"] as const) {
        const r = await literalSplitFixture(input.locale)
        await r.parent(first.parent)
        await r.parent(second.parent)
        const restored = await r.createShape(second)
        await r.publish(restored, input.locale)
        await r.saveShape(restored, second, "new-draft")
        if (kind === "former") await r.publish(restored, input.locale)
        await r.owner.mutation(api.cms.publication.softDeletePage, {
          pageId: restored,
          expectedLifecycleGeneration: 1,
        })
        const existing = await r.createShape(first)
        const result = await r.owner.mutation(
          api.cms.publication.restoreSoftDeletedPage,
          { pageId: restored, expectedLifecycleGeneration: 2 }
        )
        if (collision && kind === "retained-current") {
          expect(result.addressNotices?.[0]).toMatchObject({
            oldPath: wantedPath,
            check: { holder: { pageId: existing } },
          })
          expect((await r.localeState(restored))?.hasCurrentSnapshot).toBe(
            false
          )
        } else if (kind === "former") {
          const former = await r.t.run((ctx) =>
            ctx.db
              .query("pageHistoricalLocaleRoutes")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", restored).eq("locale", input.locale)
              )
              .unique()
          )
          expect(former?.fromPath).toBe(wantedPath)
          if (collision) expect(former?.releasedAt).toEqual(expect.any(Number))
          else expect(former?.releasedAt).toBeUndefined()
        } else {
          expect(result.addressNotices).toBeUndefined()
          expect((await r.localeState(restored))?.hasCurrentSnapshot).toBe(true)
        }
        await r.publish(existing, input.locale)
        expect((await r.localeState(existing))?.currentPath).toBe(
          input.paths[input.first]
        )
      }
      expect(
        [...cache.keys()].filter((key) => key.startsWith("drafts:")).sort()
      ).toEqual(
        [...wantedPath.matchAll(/\//g)]
          .map(
            (match) =>
              `drafts:${input.locale}:${wantedPath.slice(match.index + 1)}`
          )
          .sort()
      )
    }
  )
})

describe("old reference rows must not block address change or withdraw", () => {
  // Copies one real ancestry row targeting `target`, N times, as `sourceKind`.
  async function inflate(
    f: Awaited<ReturnType<typeof fixture>>,
    target: Id<"pages">,
    sourceKind: "candidate" | "current_public",
    count: number
  ) {
    await f.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_targetId", (q) => q.eq("targetId", target))
        .take(50)
      const { _id, _creationTime, ...row } = rows.find(
        (r) => r.referenceKind === "ancestry" && r.sourceKind === sourceKind
      )!
      void _id
      void _creationTime
      for (let i = 0; i < count; i++)
        await ctx.db.insert("pagePublicationDocumentReferences", {
          ...row,
          // Another source page, so clearing the child's own rows stays small.
          pageId: f.home,
        })
    })
  }

  test("parent address change ignores 520 old candidate rows", async () => {
    const f = await fixture(),
      p = await f.create("products")
    await f.publish(p)
    const child = await f.create("cards", p)
    await f.publish(child)
    await inflate(f, p, "candidate", 520)
    await f.save(p, "shop")
    await expect(f.publish(p)).resolves.toBeDefined()
  })

  test("parent address change still refuses above 512 current rows", async () => {
    const f = await fixture(),
      p = await f.create("products")
    await f.publish(p)
    const child = await f.create("cards", p)
    await f.publish(child)
    await inflate(f, p, "current_public", 520)
    await f.save(p, "shop")
    await expect(f.publish(p)).rejects.toThrow("PAGE_ANCESTRY_REFERENCE_LIMIT")
  })

  async function withdrawParent(
    current: boolean
  ): Promise<{ run: () => Promise<unknown> }> {
    const f = await fixture(),
      p = await f.create("products")
    await f.publish(p)
    const child = await f.create("cards", p)
    const childPub = await f.publish(child)
    await inflate(f, p, current ? "current_public" : "candidate", 520)
    // The child is the only current ancestry holder and is withdrawn first.
    await f.owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: child,
      locale: "en",
      expectedSnapshotId: childPub.snapshotId,
      expectedPublicGeneration: childPub.publicGeneration,
      expectedLifecycleGeneration: (await f.clocks(child)).lifecycleGeneration,
    })
    const pubGeneration = (await f.clocks(p)).locales.find(
      (l) => l.locale === "en"
    )!.publicGeneration
    const snapshotId = await f.t.run(async (ctx) => {
      const s = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", p).eq("locale", "en")
        )
        .unique()
      return s!.currentSnapshotId!
    })
    return {
      run: async () =>
        f.owner.mutation(api.cms.publication.withdrawLocale, {
          pageId: p,
          locale: "en",
          expectedSnapshotId: snapshotId,
          expectedPublicGeneration: pubGeneration,
          expectedLifecycleGeneration: (await f.clocks(p))
            .lifecycleGeneration,
        }),
    }
  }

  test("withdraw ignores 520 old candidate rows", async () => {
    const w = await withdrawParent(false)
    await expect(w.run()).resolves.toBeDefined()
  })

  test("withdraw still refuses above 512 current rows", async () => {
    const w = await withdrawParent(true)
    await expect(w.run()).rejects.toThrow("PAGE_ANCESTRY_REFERENCE_LIMIT")
  })
})
