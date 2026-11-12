/// <reference types="vite/client" />

import { expect, test } from "vitest"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import schema from "@/convex/schema"
import { convexTest } from "@/convexTestWithExplicitAdmin"

// Reuse the registered-function harness, offline, without editing Convex code.
const modules = import.meta.glob("../../../../convex/**/*.ts")
const OWNER = {
  subject: "conflict-copy-owner",
  tokenIdentifier: "https://convex.test|conflict-copy-owner",
}

test.each(["en", "fr"])(
  "snapshot conflict-copy carry-over persists target fields and leaves original rows unchanged (%s)",
  async (locale) => {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
      publicationAuthority: "missing",
    })
    const owner = t.withIdentity(OWNER)
    await owner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Conflict copy",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        updatedAt: Date.now(),
      })
    )
    const originalId = await owner.mutation(api.cms.pages.create, {
      slug: "original",
      pageType: "post",
      status: "draft",
      content: {
        en: { title: "Original", slices: [] },
        fr: { title: "Original français", slices: [] },
      },
      category: "Original category",
    })
    const originalState = await owner.query(api.cms.pages.getForEdit, {
      id: originalId,
    })
    // Give the original different generations so reusing its tokens is visible.
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId: originalId,
      expectedLifecycleGeneration:
        originalState!.publication!.lifecycleGeneration,
      shared: {
        expectedGeneration: originalState!.publication!.sharedDraftGeneration,
        sharedFieldsJson: JSON.stringify({
          category: "Original dirty category",
        }),
      },
      localized: {
        locale,
        slug: "original",
        expectedGeneration: originalState!.publication!.locales.find(
          (entry) => entry.locale === locale
        )!.draftGeneration,
        draft: {
          pageType: "post",
          localized: { title: "Original dirty title" },
          slices: [],
        },
      },
    })
    async function originalRows(id: Id<"pages">) {
      return t.run(async (ctx) => ({
        page: await ctx.db.get(id),
        lifecycle: await ctx.db
          .query("pagePublicationPageStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", id))
          .collect(),
        shared: await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", id))
          .collect(),
        drafts: await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", id))
          .collect(),
        states: await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", id))
          .collect(),
      }))
    }
    const before = await originalRows(originalId)
    const newId = await owner.mutation(api.cms.pages.create, {
      slug: "original-recovered",
      pageType: "post",
      status: "draft",
      content: { [locale]: { title: "Recovered", slices: [] } },
    })
    const target = await owner.query(api.cms.pages.getForEdit, { id: newId })
    const state = target!.publication!
    const result = await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId: newId,
      expectedLifecycleGeneration: state.lifecycleGeneration,
      shared: {
        expectedGeneration: state.sharedDraftGeneration,
        sharedFieldsJson: JSON.stringify({ category: "Recovered category" }),
      },
      localized: {
        locale,
        slug: "original-recovered",
        expectedGeneration: state.locales.find(
          (entry) => entry.locale === locale
        )!.draftGeneration,
        draft: {
          pageType: "post",
          localized: {
            title: "Recovered",
            metaDescription: `Recovered ${locale} descriptor`,
          },
          slices: [],
        },
      },
    })
    expect(result).toMatchObject({
      pageId: newId,
      draftGeneration: 2,
      sharedDraftGeneration: 2,
    })
    const saved = await owner.query(api.cms.pages.getForEdit, { id: newId })
    expect(saved!.page).toMatchObject({
      category: "Recovered category",
      content: {
        [locale]: {
          title: "Recovered",
          metaDescription: `Recovered ${locale} descriptor`,
          slices: [],
        },
      },
    })
    expect(await originalRows(originalId)).toEqual(before)
  }
)
