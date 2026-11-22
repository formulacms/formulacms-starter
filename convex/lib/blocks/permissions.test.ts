import { createSampleBlock } from "@/convex/lib/blocks/sample"
/// <reference types="vite/client" />
import { blockProfile } from "@/test-utils/block-profile"
import { convexTestWithAuth as convexTest } from "../../../test-utils/convexAuthFixtures"
import { beforeAll, describe, expect, test } from "vitest"
import { validate } from "convex-helpers/validators"
import { seedCommunityOwner } from "../../../convexTestWithExplicitAdmin"
import { api } from "../../_generated/api"
import schema from "../../schema"
import {
  assertBlockMutationIntegrity,
  diffBlockMutations,
  requireBlockMutationsPermitted,
} from "./permissions"
import {
  readBlockPresentationCatalog,
  type BlockPresentationCatalog,
} from "./presentations"

import { blockDefs, blockValidator } from "./index"
import { separateBlockOccurrencePresentation } from "./occurrencePresentation"

const modules = import.meta.glob("../../**/*.ts")
const owner = {
  subject: "presentation-owner",
  tokenIdentifier: "presentation-owner",
}
let catalog: BlockPresentationCatalog
beforeAll(async () => {
  catalog = await readBlockPresentationCatalog()
})

function hero(presentationIdV1?: string) {
  return {
    ...createSampleBlock("hero-with-image"),
    items: createSampleBlock("hero-with-image").items.map((item, index) => ({
      ...item,
      itemId: `fixture-row-${index}`,
    })),
    id: "hero-1",
    ...(presentationIdV1 === undefined ? {} : { presentationIdV1 }),
  }
}
function content(presentationIdV1?: string) {
  return { en: { title: "Page", blocks: [hero(presentationIdV1)] } }
}
async function fixture() {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, owner)
  return { t, actor: t.withIdentity(owner) }
}

describe("central Block mutation presentation integrity", () => {
  test("normal owner admits active explicit choices at a source-owned current revision", blockProfile(["hero-with-image"]), async () => {
    const { actor } = await fixture()
    for (const choice of ["default", "centered"]) {
      const incoming = content(choice)
      await actor.run(async (ctx) => {
        await requireBlockMutationsPermitted(
          ctx,
          diffBlockMutations(undefined, incoming),
          {
            content: incoming,
            expectedPresentationCatalogRevision: catalog.revision,
          }
        )
      })
    }
  })

  test("missing or stale revision refuses before the caller's first write", blockProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    const incoming = content("centered")
    for (const revision of [undefined, "stale"]) {
      await expect(
        actor.run(async (ctx) => {
          await requireBlockMutationsPermitted(
            ctx,
            diffBlockMutations(undefined, incoming),
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

  test("native storage admits string metadata while the central semantic guard refuses malformed strings", blockProfile(["hero-with-image"]), async () => {
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
    expect((await t.run((ctx) => ctx.db.get("pages", id)))?.content).toEqual(malformed)
    await expect(
      actor.run((ctx) =>
        requireBlockMutationsPermitted(
          ctx,
          diffBlockMutations(malformed, undefined),
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
        requireBlockMutationsPermitted(
          ctx,
          diffBlockMutations(undefined, malformed),
          {
            content: malformed,
            expectedPresentationCatalogRevision: catalog.revision,
          }
        )
      )
    ).rejects.toThrow("invalid-presentation-id")
  })

  test("retained unknown choices stay editable; copying to a new locale requires assignment authority", blockProfile(["hero-with-image"]), async () => {
    const { actor } = await fixture()
    const existingContent = content("old-choice")
    const incoming = content("old-choice")
    incoming.en.blocks[0].primary.title = "Edited"
    await actor.run((ctx) =>
      requireBlockMutationsPermitted(
        ctx,
        diffBlockMutations(existingContent, incoming),
        { existingContent, content: incoming }
      )
    )
    const copied = { ...incoming, fr: incoming.en }
    await expect(
      actor.run((ctx) =>
        requireBlockMutationsPermitted(
          ctx,
          diffBlockMutations(existingContent, copied),
          { existingContent, content: copied }
        )
      )
    ).rejects.toThrow("catalog-stale")
    await expect(
      actor.run((ctx) =>
        requireBlockMutationsPermitted(
          ctx,
          diffBlockMutations(existingContent, copied),
          {
            existingContent,
            content: copied,
            expectedPresentationCatalogRevision: catalog.revision,
          }
        )
      )
    ).rejects.toThrow("presentation-missing")
  })

  test("explicit catalog choices never bypass unauthenticated or unrelated-owner access", blockProfile([]), async () => {
    const { t } = await fixture()
    const incoming = content("centered")
    const options = {
      content: incoming,
      expectedPresentationCatalogRevision: catalog.revision,
    }
    const actions = diffBlockMutations(undefined, incoming)
    await expect(
      t.run((ctx) => requireBlockMutationsPermitted(ctx, actions, options))
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t
        .withIdentity({
          subject: "other",
          tokenIdentifier: "other",
        })
        .run((ctx) => requireBlockMutationsPermitted(ctx, actions, options))
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  test("the central guard refuses an explicit-to-absent choice change without a revision", blockProfile(["hero-with-image"]), async () => {
    const { actor } = await fixture()
    const existingContent = content("centered")
    const incoming = content()
    const actions = diffBlockMutations(existingContent, incoming)
    await expect(
      actor.run((ctx) =>
        requireBlockMutationsPermitted(ctx, actions, {
          existingContent,
          content: incoming,
        })
      )
    ).rejects.toThrow("catalog-stale")
    await actor.run((ctx) =>
      requireBlockMutationsPermitted(ctx, actions, {
        existingContent,
        content: incoming,
        expectedPresentationCatalogRevision: catalog.revision,
      })
    )
    expect(Object.hasOwn(incoming.en.blocks[0], "presentationIdV1")).toBe(false)
  })

  test("trusted restore preserves historical unknown IDs while Type archival still refuses additions", blockProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    const historical = content("old-choice")
    await actor.run((ctx) =>
      requireBlockMutationsPermitted(
        ctx,
        diffBlockMutations(undefined, historical),
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
        archivedBlockTypes: ["hero-with-image"],
      })
    )
    for (const operation of ["restore", "edit"]) {
      await expect(
        actor.run((ctx) =>
          requireBlockMutationsPermitted(
            ctx,
            diffBlockMutations(undefined, historical),
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

  test("raw authoritative integrity path enforces presentation/profile policy without repeating caller authentication", blockProfile(["hero-with-image"]), async () => {
    const { t } = await fixture()
    const incoming = content("centered")
    await t.run((ctx) =>
      assertBlockMutationIntegrity(
        ctx,
        diffBlockMutations(undefined, incoming),
        {
          content: incoming,
          expectedPresentationCatalogRevision: catalog.revision,
        }
      )
    )
    await expect(
      t.run((ctx) =>
        assertBlockMutationIntegrity(
          ctx,
          diffBlockMutations(undefined, incoming),
          { content: incoming }
        )
      )
    ).rejects.toThrow("catalog-stale")
    const absent = {
      en: { blocks: [{ ...hero("centered"), type: "uninstalled-type" }] },
    }
    await expect(
      t.run((ctx) =>
        assertBlockMutationIntegrity(
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

  test("a retained archived Type still permits edits with an active compatible presentation", blockProfile(["hero-with-image"]), async () => {
    const { t, actor } = await fixture()
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Presentation test",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
        archivedBlockTypes: ["hero-with-image"],
      })
    )
    const existingContent = content("default")
    const incoming = content("centered")
    const actions = diffBlockMutations(existingContent, incoming)
    expect(actions.add.size).toBe(0)
    await actor.run((ctx) =>
      requireBlockMutationsPermitted(ctx, actions, {
        existingContent,
        content: incoming,
        expectedPresentationCatalogRevision: catalog.revision,
      })
    )
  })

  test("registered Page creation keeps legacy behavior and refuses new metadata without a submitted revision", blockProfile(["hero-with-image"]), async () => {
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

  test("Type bodies retain their native descriptor validator with metadata", blockProfile(["hero-with-image"]), async () => {
    const { t } = await fixture()
    const incoming = content("centered")
    const malformed = { ...incoming.en.blocks[0], primary: { title: 42 } }
    // This guard deliberately owns metadata only. Body validation keeps using
    // the original descriptor; convex-test's db mock is not primitive proof.
    await t.run((ctx) =>
      assertBlockMutationIntegrity(
        ctx,
        {
          add: new Set(["hero-with-image"]),
          edit: new Set(),
          delete: new Set(),
        },
        {
          content: { en: { blocks: [malformed] } },
          expectedPresentationCatalogRevision: catalog.revision,
        }
      )
    )
    const separated = separateBlockOccurrencePresentation(malformed)!
    expect(
      validate(
        blockDefs["hero-with-image"].validator,
        separated.descriptorValue
      )
    ).toBe(false)
    expect(validate(blockValidator, malformed)).toBe(false)
    expect(validate(blockValidator, incoming.en.blocks[0])).toBe(true)
  })
})
