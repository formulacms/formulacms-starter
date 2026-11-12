import { createSampleSlice } from "@/convex/lib/slices/sample"
/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { convexTest } from "convex-test"
import { beforeAll, describe, expect, test } from "vitest"
import { validate } from "convex-helpers/validators"
import { seedCommunityOwner } from "../../../convexTestWithExplicitAdmin"
import { api } from "../../_generated/api"
import schema from "../../schema"
import {
  assertSliceMutationIntegrity,
  diffSliceMutations,
  requireSliceMutationsPermitted,
} from "./permissions"
import {
  readSlicePresentationCatalog,
  type SlicePresentationCatalog,
} from "./presentations"

import { sliceDefs, sliceValidator } from "./index"
import { separateSliceOccurrencePresentation } from "./occurrencePresentation"

const modules = import.meta.glob("../../**/*.ts")
const owner = {
  subject: "presentation-owner",
  tokenIdentifier: "https://convex.test|presentation-owner",
}
let catalog: SlicePresentationCatalog
beforeAll(async () => {
  catalog = await readSlicePresentationCatalog()
})

function hero(presentationIdV1?: string) {
  return {
    ...createSampleSlice("hero-with-image"),
    items: createSampleSlice("hero-with-image").items.map((item, index) => ({
      ...item,
      itemId: `fixture-row-${index}`,
    })),
    id: "hero-1",
    ...(presentationIdV1 === undefined ? {} : { presentationIdV1 }),
  }
}
function content(presentationIdV1?: string) {
  return { en: { title: "Page", slices: [hero(presentationIdV1)] } }
}
async function fixture() {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, owner)
  return { t, actor: t.withIdentity(owner) }
}

describe("central Slice mutation presentation integrity", () => {
  test("normal owner admits active explicit choices at a source-owned current revision", sliceProfile(["hero-with-image"]), async () => {
    const { actor } = await fixture()
    for (const choice of ["default", "centered"]) {
      const incoming = content(choice)
      await actor.run(async (ctx) => {
        await requireSliceMutationsPermitted(
          ctx,
          diffSliceMutations(undefined, incoming),
          {
            content: incoming,
            expectedPresentationCatalogRevision: catalog.revision,
          }
        )
      })
    }
  })

  test("missing or stale revision refuses before the caller's first write", sliceProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    const incoming = content("centered")
    for (const revision of [undefined, "stale"]) {
      await expect(
        actor.run(async (ctx) => {
          await requireSliceMutationsPermitted(
            ctx,
            diffSliceMutations(undefined, incoming),
            {
              content: incoming,
              expectedPresentationCatalogRevision: revision,
            }
          )
          await ctx.db.insert("pages", {
            pageType: "page",
            slug: "refused",
            status: "draft",
            createdAt: 1,
            updatedAt: 1,
            content: incoming,
          })
        })
      ).rejects.toThrow("catalog-stale")
    }
    expect(await t.run((ctx) => ctx.db.query("pages").take(2))).toEqual([])
  })

  test("native storage admits string metadata while the central semantic guard refuses malformed strings", sliceProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    const malformed = content("default\n")
    const id = await t.run((ctx) =>
      ctx.db.insert("pages", {
        pageType: "page",
        slug: "native-shape-only",
        status: "draft",
        createdAt: 1,
        updatedAt: 1,
        content: malformed,
      })
    )
    expect((await t.run((ctx) => ctx.db.get(id)))?.content).toEqual(malformed)
    await expect(
      actor.run((ctx) =>
        requireSliceMutationsPermitted(
          ctx,
          diffSliceMutations(malformed, undefined),
          {
            existingContent: malformed,
            content: {},
            operation: "restore",
          }
        )
      )
    ).rejects.toThrow("invalid-presentation-id")
    await expect(
      actor.run((ctx) =>
        requireSliceMutationsPermitted(
          ctx,
          diffSliceMutations(undefined, malformed),
          {
            content: malformed,
            expectedPresentationCatalogRevision: catalog.revision,
          }
        )
      )
    ).rejects.toThrow("invalid-presentation-id")
  })

  test("retained unknown choices stay editable; copying to a new locale requires assignment authority", sliceProfile(["hero-with-image"]), async () => {
    const { actor } = await fixture()
    const existingContent = content("old-choice")
    const incoming = content("old-choice")
    incoming.en.slices[0].primary.title = "Edited"
    await actor.run((ctx) =>
      requireSliceMutationsPermitted(
        ctx,
        diffSliceMutations(existingContent, incoming),
        { existingContent, content: incoming }
      )
    )
    const copied = { ...incoming, fr: incoming.en }
    await expect(
      actor.run((ctx) =>
        requireSliceMutationsPermitted(
          ctx,
          diffSliceMutations(existingContent, copied),
          { existingContent, content: copied }
        )
      )
    ).rejects.toThrow("catalog-stale")
    await expect(
      actor.run((ctx) =>
        requireSliceMutationsPermitted(
          ctx,
          diffSliceMutations(existingContent, copied),
          {
            existingContent,
            content: copied,
            expectedPresentationCatalogRevision: catalog.revision,
          }
        )
      )
    ).rejects.toThrow("presentation-missing")
  })

  test("explicit catalog choices never bypass unauthenticated or unrelated-owner access", sliceProfile([]), async () => {
    const { t } = await fixture()
    const incoming = content("centered")
    const options = {
      content: incoming,
      expectedPresentationCatalogRevision: catalog.revision,
    }
    const actions = diffSliceMutations(undefined, incoming)
    await expect(
      t.run((ctx) => requireSliceMutationsPermitted(ctx, actions, options))
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t
        .withIdentity({
          subject: "other",
          tokenIdentifier: "https://convex.test|other",
        })
        .run((ctx) => requireSliceMutationsPermitted(ctx, actions, options))
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  test("the central guard refuses an explicit-to-absent choice change without a revision", sliceProfile(["hero-with-image"]), async () => {
    const { actor } = await fixture()
    const existingContent = content("centered")
    const incoming = content()
    const actions = diffSliceMutations(existingContent, incoming)
    await expect(
      actor.run((ctx) =>
        requireSliceMutationsPermitted(ctx, actions, {
          existingContent,
          content: incoming,
        })
      )
    ).rejects.toThrow("catalog-stale")
    await actor.run((ctx) =>
      requireSliceMutationsPermitted(ctx, actions, {
        existingContent,
        content: incoming,
        expectedPresentationCatalogRevision: catalog.revision,
      })
    )
    expect(Object.hasOwn(incoming.en.slices[0], "presentationIdV1")).toBe(false)
  })

  test("trusted restore preserves historical unknown IDs while Type archival still refuses additions", sliceProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    const historical = content("old-choice")
    await actor.run((ctx) =>
      requireSliceMutationsPermitted(
        ctx,
        diffSliceMutations(undefined, historical),
        { content: historical, operation: "restore" }
      )
    )
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Presentation test",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
        archivedSliceTypes: ["hero-with-image"],
      })
    )
    for (const operation of ["restore", "edit"]) {
      await expect(
        actor.run((ctx) =>
          requireSliceMutationsPermitted(
            ctx,
            diffSliceMutations(undefined, historical),
            {
              content: historical,
              operation,
              expectedPresentationCatalogRevision: catalog.revision,
            }
          )
        )
      ).rejects.toThrow('Archived Block Type "hero-with-image"')
    }
  })

  test("raw authoritative integrity path enforces presentation/profile policy without repeating caller authentication", sliceProfile(["hero-with-image"]), async () => {
    const { t } = await fixture()
    const incoming = content("centered")
    await t.run((ctx) =>
      assertSliceMutationIntegrity(
        ctx,
        diffSliceMutations(undefined, incoming),
        {
          content: incoming,
          expectedPresentationCatalogRevision: catalog.revision,
        }
      )
    )
    await expect(
      t.run((ctx) =>
        assertSliceMutationIntegrity(
          ctx,
          diffSliceMutations(undefined, incoming),
          { content: incoming }
        )
      )
    ).rejects.toThrow("catalog-stale")
    const absent = {
      en: { slices: [{ ...hero("centered"), type: "uninstalled-type" }] },
    }
    await expect(
      t.run((ctx) =>
        assertSliceMutationIntegrity(
          ctx,
          { add: new Set(), edit: new Set(), delete: new Set() },
          {
            existingContent: absent,
            content: {},
            operation: "restore",
          }
        )
      )
    ).rejects.toThrow("installed block code is unavailable")
  })

  test("a retained archived Type still permits edits with an active compatible presentation", sliceProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Presentation test",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
        archivedSliceTypes: ["hero-with-image"],
      })
    )
    const existingContent = content("default")
    const incoming = content("centered")
    const actions = diffSliceMutations(existingContent, incoming)
    expect(actions.add.size).toBe(0)
    await actor.run((ctx) =>
      requireSliceMutationsPermitted(ctx, actions, {
        existingContent,
        content: incoming,
        expectedPresentationCatalogRevision: catalog.revision,
      })
    )
  })

  test("registered Page creation keeps legacy behavior and refuses new metadata without a submitted revision", sliceProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    await actor.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    const id = await actor.mutation(api.cms.pages.create, {
      pageType: "page",
      slug: "legacy",
      status: "draft",
      content: content(),
    })
    const draft = await t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", id).eq("locale", "en")
        )
        .unique()
    )
    expect(draft?.content).toEqual(content().en)
    await expect(
      actor.mutation(api.cms.pages.create, {
        pageType: "page",
        slug: "explicit",
        status: "draft",
        content: content("centered"),
      })
    ).rejects.toThrow("catalog-stale")
    expect((await t.run((ctx) => ctx.db.query("pages").take(3))).length).toBe(1)
  })

  test("Type bodies retain their native descriptor validator with metadata", sliceProfile(["hero-with-image"]), async () => {
    const { t } = await fixture()
    const incoming = content("centered")
    const malformed = { ...incoming.en.slices[0], primary: { title: 42 } }
    // This guard deliberately owns metadata only. Body validation keeps using
    // the original descriptor; convex-test's db mock is not primitive proof.
    await t.run((ctx) =>
      assertSliceMutationIntegrity(
        ctx,
        {
          add: new Set(["hero-with-image"]),
          edit: new Set(),
          delete: new Set(),
        },
        {
          content: { en: { slices: [malformed] } },
          expectedPresentationCatalogRevision: catalog.revision,
        }
      )
    )
    const separated = separateSliceOccurrencePresentation(malformed)!
    expect(
      validate(
        sliceDefs["hero-with-image"].validator,
        separated.descriptorValue
      )
    ).toBe(false)
    expect(validate(sliceValidator, malformed)).toBe(false)
    expect(validate(sliceValidator, incoming.en.slices[0])).toBe(true)
  })
})
