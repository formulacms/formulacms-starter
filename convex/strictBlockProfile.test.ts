/// <reference types="vite/client" />
import { describe, expect, expectTypeOf, test } from "vitest"
import { validate } from "convex-helpers/validators"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import { getPresentationCatalog } from "./cms/blocks"
import schema from "./schema"
import {
  INSTALLED_BLOCK_TYPES,
  createDefaultBlock,
  type Block,
  type InstalledBlockType,
  REGISTERED_BLOCK_TYPES,
  installedBlockValidator,
  blockValidator,
} from "./lib/blocks"
import { createSampleBlock } from "./lib/blocks/sample"
import { writeBlockFields } from "./lib/richtext/write"
import { convertBlockFields } from "./lib/blocks/validate"
import { hasBlockType, readBlock } from "./lib/blocks/identity"
import manifest from "../lib/blocks/blocks.manifest.json"

const modules = import.meta.glob("./**/*.ts")
const ownerIdentity = {
  subject: "strict-profile-owner",
  tokenIdentifier: "strict-profile-owner",
}

function makeTest(publicationAuthority: "legacy" | "missing" = "legacy") {
  return convexTest({ schema, modules, ownerIdentity, publicationAuthority })
}

function queryReturnSchema(query: unknown): string {
  if (
    ((typeof query === "object" && query !== null) ||
      typeof query === "function") &&
    "exportReturns" in query &&
    typeof query.exportReturns === "function"
  ) {
    const schema: unknown = query.exportReturns()
    if (typeof schema === "string") return schema
  }
  throw new Error("Registered query has no serialized return validator.")
}

describe("actual emitted source block profile", () => {
  test("constructors preserve installed admission", () => {
    expectTypeOf<
      Parameters<typeof createDefaultBlock>[0]
    >().toEqualTypeOf<InstalledBlockType>()
    expect(() =>
      Reflect.apply(createDefaultBlock, undefined, ["unregistered"])
    ).toThrow(/not installed/)
    expect(() =>
      Reflect.apply(createSampleBlock, undefined, ["unregistered"])
    ).toThrow(/not registered/)
    for (const type of INSTALLED_BLOCK_TYPES)
      expect(validate(installedBlockValidator, createDefaultBlock(type))).toBe(
        true
      )
  })

  test("actual normalized values preserve identity, presentations, root items and links through Page save/read", async () => {
    const t = makeTest()
    const owner = t.withIdentity(ownerIdentity)
    const targetId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Link target",
    })
    const normalized = REGISTERED_BLOCK_TYPES.map((type) => {
      const sample = createSampleBlock(type)
      sample.id = `profile-${type}`
      sample.presentationIdV1 = "default"
      if ("items" in sample)
        sample.items.forEach((item, index) => {
          item.itemId = `${type}-${index}`
        })
      if (hasBlockType(sample, "hero-with-image")) {
        sample.items[0].link = {
          type: "internal",
          pageId: targetId,
          anchor: "proof",
        }
        sample.items[1].link = {
          type: "external",
          url: "https://example.test/fr?proof=1",
        }
      }
      expectTypeOf(readBlock(sample)).toEqualTypeOf<typeof sample>()
      const written = writeBlockFields(sample, "fr")
      expectTypeOf(written.value).toEqualTypeOf<Block>()
      const converted = convertBlockFields(written.value)
      expect(converted.value).toEqual(written.value)
      expect(written.value.id).toBe(sample.id)
      expect(written.value.presentationIdV1).toBe("default")
      if ("items" in sample)
        expect(converted.value).toHaveProperty("items", sample.items)
      expect(written.reports.every((report) => report.locale === "fr")).toBe(
        true
      )
      if (hasBlockType(sample, "hero-with-image"))
        expect(converted.value).toHaveProperty("items", sample.items)
      expect(validate(blockValidator, converted.value)).toBe(true)
      return converted.value
    })
    const installed = new Set<string>(INSTALLED_BLOCK_TYPES)
    const blocks = normalized.filter((block) => installed.has(block.type))
    const catalog = await owner.query(api.cms.blocks.getPresentationCatalog, {})
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Normalized",
      expectedPresentationCatalogRevision: catalog.revision,
      content: { en: { title: "Normalized", blocks } },
    })
    const read = await owner.query(api.cms.pages.getForEdit, { id: pageId })
    const stored = read?.page
    if (!stored || stored.pageType !== "landing-page")
      throw new Error("Missing saved landing Page")
    expect(stored.content?.en?.blocks).toEqual(blocks)
  })

  test("keeps validators and the authorized catalog coherent with the emitted manifest", async () => {
    expect(REGISTERED_BLOCK_TYPES).toEqual(manifest.map(({ type }) => type))
    expect(INSTALLED_BLOCK_TYPES).toEqual(
      manifest
        .filter((entry) => !("selected" in entry) || entry.selected !== false)
        .map(({ type }) => type)
    )
    const installed = new Set<string>(INSTALLED_BLOCK_TYPES)
    for (const type of REGISTERED_BLOCK_TYPES) {
      const sample = createSampleBlock(type)
      expect(validate(blockValidator, sample)).toBe(true)
      expect(validate(installedBlockValidator, sample)).toBe(
        installed.has(type)
      )
      expect(validate(blockValidator, { ...sample, primary: null })).toBe(false)
    }
    expect(
      validate(blockValidator, {
        id: "unknown",
        type: "unregistered",
        enabled: true,
        primary: {},
      })
    ).toBe(false)
    const t = makeTest()
    await expect(
      t.query(api.cms.blocks.getPresentationCatalog, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    const catalog = await t
      .withIdentity(ownerIdentity)
      .query(api.cms.blocks.getPresentationCatalog, {})
    expect(catalog.installedTypes).toEqual(INSTALLED_BLOCK_TYPES)
    expect(
      catalog.entries
        .filter(({ id }) => id === "default")
        .map(({ type }) => type)
    ).toEqual(REGISTERED_BLOCK_TYPES)
    const hasHero = new Set<string>(REGISTERED_BLOCK_TYPES).has(
      "hero-with-image"
    )
    expect(catalog.entries.some(({ id }) => id === "centered")).toBe(hasHero)
    expect(
      queryReturnSchema(getPresentationCatalog).includes(
        '"value":"hero-with-image"'
      )
    ).toBe(hasHero)
    expect(queryReturnSchema(getPresentationCatalog)).not.toContain(
      '"value":"unknown-presentation"'
    )
  })

  test("creates a blank Page and refuses unavailable or invalid content without inserting another Page", async () => {
    const t = makeTest()
    const owner = t.withIdentity(ownerIdentity)
    const args = {
      pageType: "landing-page" as const,
      status: "draft" as const,
      title: "Blank",
      content: { en: { title: "Blank", blocks: [] } },
    }
    const pageId = await owner.mutation(api.cms.pages.create, args)
    const view = await owner.query(api.cms.pages.getForEdit, { id: pageId })
    const stored = view?.page
    if (!stored || stored.pageType !== "landing-page")
      throw new Error("Missing blank landing Page")
    expect(stored.content?.en?.blocks).toEqual([])
    const before = await t.run((ctx) => ctx.db.query("pages").take(10))
    const installed = new Set<string>(INSTALLED_BLOCK_TYPES)
    for (const type of REGISTERED_BLOCK_TYPES.filter(
      (type) => !installed.has(type)
    )) {
      await expect(
        owner.mutation(api.cms.pages.create, {
          ...args,
          content: {
            en: { title: "Unavailable", blocks: [createSampleBlock(type)] },
          },
        })
      ).rejects.toThrow(/installed block code is unavailable/)
    }
    await expect(
      owner.mutation(api.cms.pages.create, {
        ...args,
        content: JSON.parse(
          '{"en":{"title":"Invalid","blocks":[{"id":"invalid","type":"unregistered","enabled":true,"primary":{}}]}}'
        ),
      })
    ).rejects.toThrow()
    expect(await t.run((ctx) => ctx.db.query("pages").take(10))).toEqual(before)
  })

  test("the separate setup constructor persists an empty Home Working Draft", async () => {
    const t = makeTest("missing")
    await t
      .withIdentity(ownerIdentity)
      .mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "Blank setup",
        timezone: "UTC",
        defaultLocale: "en",
      })
    const drafts = await t.run((ctx) =>
      ctx.db.query("pageLocaleDrafts").take(2)
    )
    expect(drafts).toHaveLength(1)
    expect(drafts[0].content).toMatchObject({
      title: "Blank setup",
      blocks: [],
    })
  })
})
