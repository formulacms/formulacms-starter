/// <reference types="vite/client" />

import { readFile } from "node:fs/promises"
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const owner = {
  subject: "f03b-owner",
  tokenIdentifier: "https://issuer.test|f03b-owner",
  email: "owner@example.test",
}
const unrelated = {
  subject: "f03b-unrelated",
  tokenIdentifier: "https://issuer.test|f03b-unrelated",
  email: "unrelated@example.test",
}

async function makeOwnerTest() {
  const t = convexTest(schema, modules)
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

function exportBlock(source: string, name: string): string {
  const constStart = source.indexOf(`export const ${name} =`)
  const functionStart = source.indexOf(`export async function ${name}(`)
  const start = Math.max(constStart, functionStart)
  expect(start, `${name} export`).toBeGreaterThanOrEqual(0)
  const nextConst = source.indexOf("\nexport const ", start + 1)
  const nextFunction = source.indexOf("\nexport async function ", start + 1)
  const next = [nextConst, nextFunction]
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0]
  return source.slice(start, next)
}

function expectBefore(
  source: string,
  gate: string,
  sensitiveWork: string
): void {
  const gateAt = source.indexOf(gate)
  const workAt = source.indexOf(sensitiveWork)
  expect(gateAt, `${gate} is present`).toBeGreaterThanOrEqual(0)
  expect(workAt, `${sensitiveWork} is present`).toBeGreaterThanOrEqual(0)
  expect(gateAt, `${gate} precedes ${sensitiveWork}`).toBeLessThan(workAt)
}

describe("F03b owner boundary", () => {
  test("keeps each account and operational export on its intended owner seam", async () => {
    // FR2e (D-7): the Webhooks exports are checked in
    // webhooks.boundaries.test.ts, which ships only with convex/webhooks.ts.
    const [preferences, email, revalidate] = await Promise.all(
      [
        "convex/cms/userPreferences.ts",
        "convex/email.ts",
        "convex/cms/revalidate.ts",
      ].map((file) => readFile(file, "utf8"))
    )

    expect(exportBlock(preferences, "setAdminLocale")).toContain(
      "requireOperationAccess(ctx)"
    )
    expect(exportBlock(email, "getEmailProviderSettings")).toContain(
      "requireInstallationOwner(ctx)"
    )
    expect(exportBlock(email, "saveEmailProviderConfiguration")).toContain(
      "requireInstallationOwner(ctx)"
    )
    expect(exportBlock(email, "assertSettingsUpdate")).toContain(
      "requireInstallationOwner(ctx)"
    )
    expect(exportBlock(email, "sendTestEmail")).toContain(
      "internal.email.assertSettingsUpdate"
    )
    expect(exportBlock(email, "sendTestEmail")).toContain("rateLimiter.limit")
    expect(exportBlock(revalidate, "getRevalidationHealth")).toContain(
      "requireOperationAccess(ctx)"
    )
    for (const name of [
      "assertCanRunRevalidationSelfTest",
      "assertCanVerifyContactIpProofPairing",
    ]) {
      expect(exportBlock(revalidate, name)).toContain(
        "requireInstallationOwner(ctx)"
      )
    }
    const pageActions = await readFile(
      "app/(core)/admin/(authenticated)/pages/actions.ts",
      "utf8"
    )
    expect(exportBlock(pageActions, "revalidatePagePaths")).toContain(
      "requireOperationAccess"
    )
  })

  test("runs operational assertions before sensitive work", async () => {
    const [email, revalidate] = await Promise.all(
      ["convex/email.ts", "convex/cms/revalidate.ts"].map((file) =>
        readFile(file, "utf8")
      )
    )

    expectBefore(
      exportBlock(email, "checkEmailProviderConfiguration"),
      "internal.email.assertSettingsUpdate",
      "emailProviderEnvironmentReadiness"
    )
    expectBefore(
      exportBlock(email, "sendTestEmail"),
      "internal.email.assertSettingsUpdate",
      "ctx.auth.getUserIdentity"
    )
    expectBefore(
      exportBlock(email, "sendTestEmail"),
      "internal.email.assertSettingsUpdate",
      "rateLimiter.limit"
    )
    expectBefore(
      exportBlock(revalidate, "verifyContactIpProofPairing"),
      "internal.cms.revalidate.assertCanVerifyContactIpProofPairing",
      "verifyContactIpProofPairingValue"
    )
    expectBefore(
      exportBlock(revalidate, "runRevalidationSelfTest"),
      "internal.cms.revalidate.assertCanRunRevalidationSelfTest",
      'revalidateAndRecord(ctx, "settings"'
    )
  })

  test("keeps source writers behind durable owner plus local-development guards", async () => {
    for (const file of [
      "app/(core)/admin/(authenticated)/content-types/actions.ts",
      "app/(core)/admin/(authenticated)/slices/actions.ts",
      "app/(sim)/slice-sim/[type]/actions.ts",
      "app/(sim)/slice-sim/[type]/read-renderer-source.ts",
    ]) {
      const source = await readFile(file, "utf8")
      expect(source).toContain("requireInstallationOwner")
      expect(source).not.toContain("roles.myPermissions")
      expect(source).not.toContain("requireSliceAuthorPermission")
    }
    const ownerAction = await readFile("lib/owner-server.ts", "utf8")
    expect(ownerAction).toContain("getOwnerSession")
    expect(ownerAction).not.toContain("roles.myPermissions")
  })

  test("denies unrelated callers while the owner can use account and protected reads", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    const asUnrelated = t.withIdentity(unrelated)

    await expect(
      asUnrelated.mutation(api.cms.userPreferences.setAdminLocale, {
        locale: "not-a-supported-locale",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asOwner.mutation(api.cms.userPreferences.setAdminLocale, {
        locale: "en",
      })
    ).resolves.toBeNull()
    await expect(
      asUnrelated.mutation(api.email.saveEmailProviderConfiguration, {
        providerId: "resend",
        senderAddress: "sender@example.test",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asOwner.mutation(api.email.saveEmailProviderConfiguration, {
        providerId: "resend",
        senderAddress: "sender@example.test",
      })
    ).resolves.toMatchObject({ status: "configured" })
    await expect(
      asUnrelated.query(api.email.getEmailProviderSettings, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asOwner.query(api.email.getEmailProviderSettings, {})
    ).resolves.toMatchObject({
      configuredProviderId: "resend",
      activeProviderId: null,
    })

    await expect(
      asUnrelated.query(api.cms.revalidate.getRevalidationHealth, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asOwner.query(api.cms.revalidate.getRevalidationHealth, {})
    ).resolves.toMatchObject({ recentAttempts: [], consecutiveFailureCount: 0 })
  })

  test("keeps admin locale private and bound to the exact durable owner", async () => {
    const t = await makeOwnerTest()
    await t.run(async (ctx) => {
      await ctx.db.insert("userPreferences", {
        authId: unrelated.subject,
        adminLocale: "fr",
      })
      await ctx.db.insert("userPreferences", {
        authId: unrelated.subject,
        adminLocale: "en",
      })
    })

    await expect(
      t.query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBeNull()
    await expect(
      t
        .withIdentity(unrelated)
        .query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBeNull()
    const asOwner = t.withIdentity(owner)
    await expect(
      asOwner.query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBeNull()
    await asOwner.mutation(api.cms.userPreferences.setAdminLocale, {
      locale: "fr",
    })
    await expect(
      asOwner.query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBe("fr")
  })

  test("keeps a partial owner binding nullable for admin locale reads", async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert("cmsOwner", {
        key: "owner",
        authId: owner.subject,
        tokenIdentifier: "https://issuer.test|wrong-binding",
        establishedAt: 1,
        updatedAt: 1,
      })
    )

    await expect(
      t.withIdentity(owner).query(api.cms.userPreferences.getAdminLocale, {})
    ).resolves.toBeNull()
  })

  test("keeps the public owner-established signal public", async () => {
    const t = await makeOwnerTest()
    await expect(
      t.query(api.cms.owner.getOwnerEstablished, {})
    ).resolves.toEqual({ established: true })
  })
})
