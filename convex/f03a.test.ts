/// <reference types="vite/client" />

import { blockProfile } from "@/test-utils/block-profile"
import { readFile } from "node:fs/promises"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"

import schema from "./schema"
import { readBlockPresentationCatalog } from "./lib/blocks/presentations"

const modules = import.meta.glob("./**/*.ts")
const owner = {
  subject: "f03a-owner",
  tokenIdentifier: "f03a-owner",
  email: "owner@example.test",
}
const unrelated = {
  subject: "f03a-unrelated",
  tokenIdentifier: "f03a-unrelated",
  email: "unrelated@example.test",
}

async function makeOwnerTest() {
  const t = convexTest({
    schema,
    modules,
  })
  await t.run((ctx) =>
    ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: owner.subject,
      tokenIdentifier: owner.tokenIdentifier,
      establishedAt: 1,
      updatedAt: 1,
    })
  )
  return t
}

describe("F03a owner operation access", () => {
  test("guards the current presentation catalog and returns the owned source snapshot", blockProfile([]), async () => {
    const t = await makeOwnerTest()
    await expect(
      t.query(api.cms.blocks.getPresentationCatalog, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t.withIdentity(unrelated).query(api.cms.blocks.getPresentationCatalog, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    const catalog = await t
      .withIdentity(owner)
      .query(api.cms.blocks.getPresentationCatalog, {})
    expect(catalog).toEqual(await readBlockPresentationCatalog())
    expect(
      catalog.entries
        .filter((entry) => entry.type === "hero-with-image")
        .map((entry) => entry.id)
    ).toEqual(["default", "centered"])
  })
  test("inventory routes the F03a private boundary through operation access", async () => {
    for (const file of [
      "convex/cms/pages.ts",
      "convex/cms/media.ts",
      "convex/cms/settings.ts",
      "convex/cms/contentTypes.ts",
      "convex/cms/relations.ts",
      "convex/cms/blocks.ts",
      "convex/lib/blocks/permissions.ts",
    ]) {
      const source = await readFile(file, "utf8")
      expect(source).toContain("requireOperationAccess")
      expect(source).not.toContain('from "../lib/authHelpers"')
      expect(source).not.toContain("auth.permissions")
    }
  })

  test("denies missing private media before revealing whether its row exists", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    const asUnrelated = t.withIdentity(unrelated)
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["image"], { type: "image/png" }))
    )
    const mediaId = await asOwner.mutation(api.cms.media.create, {
      filename: "removed.png",
      storageId,
      size: 5,
      mimeType: "image/png",
    })
    await t.run((ctx) => ctx.db.delete("media", mediaId))

    await expect(
      t.query(api.cms.media.getById, { id: mediaId })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      asUnrelated.query(api.cms.media.getById, { id: mediaId })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.mutation(api.cms.media.softDelete, { id: mediaId })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

})
