/// <reference types="vite/client" />

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const owner = {
  subject: "admin-locale-owner",
  tokenIdentifier: "https://issuer.test|admin-locale-owner",
  email: "owner@example.test",
}

describe("admin locale preference writes", () => {
  test("rejects unshipped dictionaries without erasing a saved unsupported value", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert("cmsOwner", {
        key: "owner",
        authId: owner.subject,
        tokenIdentifier: owner.tokenIdentifier,
        establishedAt: 1,
        updatedAt: 1,
      })
      await ctx.db.insert("userPreferences", {
        authId: owner.subject,
        adminLocale: "es",
      })
    })
    const asOwner = t.withIdentity(owner)

    await expect(
      asOwner.query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBe("es")
    await expect(
      asOwner.mutation(api.cms.userPreferences.setAdminLocale, { locale: "es" })
    ).rejects.toThrow("Unsupported locale: es")
    await expect(
      asOwner.mutation(api.cms.userPreferences.setAdminLocale, { locale: "de" })
    ).rejects.toThrow("Unsupported locale: de")
    await expect(
      asOwner.query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBe("es")

    await asOwner.mutation(api.cms.userPreferences.setAdminLocale, {
      locale: "fr",
    })
    await expect(
      asOwner.query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBe("fr")
    await asOwner.mutation(api.cms.userPreferences.setAdminLocale, {
      locale: "en",
    })
    await expect(
      asOwner.query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBe("en")
  })
})
