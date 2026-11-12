/// <reference types="vite/client" />

import { readFile } from "node:fs/promises"
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api, internal } from "./_generated/api"
import type { QueryCtx } from "./_generated/server"
import { readOwnerState, replaceOwnerBinding } from "./lib/access/owner"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")

const ownerIdentity = {
  subject: "owner-auth-id",
  tokenIdentifier: "https://issuer.test|owner-auth-id",
  email: "owner@example.test",
}

const successorIdentity = {
  subject: "successor-auth-id",
  tokenIdentifier: "https://issuer.test|successor-auth-id",
  email: "successor@example.test",
}

const forbiddenPublicOwnerAssertion =
  // @ts-expect-error Owner assertions are intentionally internal-only.
  api.cms.owner.assertOperationAccessInternal
void forbiddenPublicOwnerAssertion

function makeTest() {
  return convexTest(schema, modules)
}

async function insertOwner(
  t: ReturnType<typeof makeTest>,
  overrides: Partial<{
    authId: string
    tokenIdentifier: string
    establishedAt: number
  }> = {}
) {
  return await t.run((ctx) =>
    ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: overrides.authId ?? ownerIdentity.subject,
      tokenIdentifier:
        overrides.tokenIdentifier ?? ownerIdentity.tokenIdentifier,
      establishedAt: overrides.establishedAt ?? 1,
      updatedAt: 1,
    })
  )
}

async function insertHistoricalMedia(
  t: ReturnType<typeof makeTest>,
  uploadedBy = "https://issuer.test|previous-owner"
) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(["image"], { type: "image/png" })
    )
    return await ctx.db.insert("media", {
      filename: "legacy.png",
      storageId,
      url: "https://example.test/legacy.png",
      size: 5,
      mimeType: "image/png",
      uploadedAt: 1,
      uploadedBy,
    })
  })
}

async function expectProtectedDenial(
  t: ReturnType<typeof makeTest>,
  mediaId: Awaited<ReturnType<typeof insertHistoricalMedia>>,
  identity: Parameters<ReturnType<typeof makeTest>["withIdentity"]>[0],
  error: string
) {
  const caller = t.withIdentity(identity)
  await expect(
    caller.query(internal.cms.owner.assertOperationAccessInternal, {})
  ).rejects.toThrow(error)
  await expect(
    caller.query(internal.cms.owner.assertInstallationOwnerInternal, {})
  ).rejects.toThrow(error)
  await expect(
    caller.mutation(api.cms.media.update, { id: mediaId, folder: "blocked" })
  ).rejects.toThrow(error)
}

describe("durable Community owner access", () => {
  test("keeps unauthenticated, missing, and legacy-Admin-only callers closed through registered boundaries", async () => {
    const t = makeTest()
    const mediaId = await insertHistoricalMedia(t)
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("roles", {
        authId: "legacy-admin",
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: "legacy-admin",
        tokenIdentifier: "https://issuer.test|legacy-admin",
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "legacy-admin",
      })
    })

    await expect(
      t.query(api.cms.owner.getOwnerEstablished, {})
    ).resolves.toEqual({ established: false })
    await expect(t.query(api.cms.owner.getOwnerSession, {})).resolves.toBeNull()
    await expect(
      t.query(internal.cms.owner.assertOperationAccessInternal, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t.query(internal.cms.owner.assertInstallationOwnerInternal, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t.mutation(api.cms.media.update, { id: mediaId, folder: "blocked" })
    ).rejects.toThrow("UNAUTHENTICATED")

    const legacyAdmin = {
      subject: "legacy-admin",
      tokenIdentifier: "https://issuer.test|legacy-admin",
    }
    await expect(
      t.withIdentity(legacyAdmin).query(api.cms.owner.getOwnerSession, {})
    ).resolves.toBeNull()
    await expectProtectedDenial(
      t,
      mediaId,
      legacyAdmin,
      "CMS_OWNER_NOT_ESTABLISHED"
    )
  })

  test("returns only the fixed Admin principal to the exact owner and rejects an unrelated account", async () => {
    const t = makeTest()
    const ownerId = await insertOwner(t)
    const mediaId = await insertHistoricalMedia(t)
    const owner = t.withIdentity(ownerIdentity)

    await expect(
      t.query(api.cms.owner.getOwnerEstablished, {})
    ).resolves.toEqual({ established: true })
    const session = await owner.query(api.cms.owner.getOwnerSession, {})
    expect(session).toEqual({
      ownerId,
      authId: ownerIdentity.subject,
      email: ownerIdentity.email,
      role: "admin",
    })
    expect(session).not.toHaveProperty("permissions")
    expect(session).not.toHaveProperty("tokenIdentifier")

    const [operationPrincipal, installationPrincipal] = await Promise.all([
      owner.query(internal.cms.owner.assertOperationAccessInternal, {}),
      owner.query(internal.cms.owner.assertInstallationOwnerInternal, {}),
    ])
    for (const principal of [operationPrincipal, installationPrincipal]) {
      expect(principal).toEqual({
        ownerId,
        authId: ownerIdentity.subject,
        tokenIdentifier: ownerIdentity.tokenIdentifier,
        email: ownerIdentity.email,
        role: "admin",
      })
      expect(principal).not.toHaveProperty("permissions")
    }
    await expect(
      owner.mutation(api.cms.media.update, { id: mediaId, folder: "owner" })
    ).resolves.toBeNull()

    const unrelated = {
      subject: "unrelated-auth-id",
      tokenIdentifier: "https://issuer.test|unrelated-auth-id",
    }
    await expect(
      t.withIdentity(unrelated).query(api.cms.owner.getOwnerSession, {})
    ).resolves.toBeNull()
    await expectProtectedDenial(t, mediaId, unrelated, "CMS_OWNER_REQUIRED")
  })

  test("sanitizes missing, duplicate, and both partial bindings while every protected path fails closed", async () => {
    const missing = makeTest()
    const missingMedia = await insertHistoricalMedia(missing)
    const unrelated = {
      subject: "unrelated-auth-id",
      tokenIdentifier: "https://issuer.test|unrelated-auth-id",
    }
    await expect(
      missing.query(api.cms.owner.getOwnerEstablished, {})
    ).resolves.toEqual({ established: false })
    await expect(
      missing.withIdentity(unrelated).query(api.cms.owner.getOwnerSession, {})
    ).resolves.toBeNull()
    await expectProtectedDenial(
      missing,
      missingMedia,
      unrelated,
      "CMS_OWNER_NOT_ESTABLISHED"
    )

    const duplicate = makeTest()
    const duplicateMedia = await insertHistoricalMedia(duplicate)
    await insertOwner(duplicate)
    await insertOwner(duplicate, {
      authId: "second-owner",
      tokenIdentifier: "https://issuer.test|second-owner",
    })
    await expect(
      duplicate.query(api.cms.owner.getOwnerEstablished, {})
    ).resolves.toEqual({ established: true })
    await expect(
      duplicate
        .withIdentity(ownerIdentity)
        .query(api.cms.owner.getOwnerSession, {})
    ).rejects.toThrow("CMS_OWNER_UNAVAILABLE")
    await expectProtectedDenial(
      duplicate,
      duplicateMedia,
      ownerIdentity,
      "CMS_OWNER_STATE_INVALID"
    )

    for (const partialIdentity of [
      {
        ...ownerIdentity,
        tokenIdentifier: "https://issuer.test|changed-token",
      },
      { ...ownerIdentity, subject: "changed-owner-auth-id" },
    ]) {
      const partial = makeTest()
      const partialMedia = await insertHistoricalMedia(partial)
      await insertOwner(partial)
      await expect(
        partial
          .withIdentity(partialIdentity)
          .query(api.cms.owner.getOwnerSession, {})
      ).rejects.toThrow("CMS_OWNER_UNAVAILABLE")
      await expectProtectedDenial(
        partial,
        partialMedia,
        partialIdentity,
        "CMS_OWNER_BINDING_INVALID"
      )
    }
  })

  test("replacement revokes the old binding immediately, preserves the durable row and attribution, and admits the successor", async () => {
    const t = makeTest()
    const ownerId = await insertOwner(t, { establishedAt: 123 })
    const mediaId = await insertHistoricalMedia(
      t,
      ownerIdentity.tokenIdentifier
    )
    const before = await t.run((ctx) => ctx.db.get(ownerId))
    expect(before).not.toBeNull()

    await t.run(async (ctx) => {
      const currentOwner = await ctx.db.get(ownerId)
      expect(currentOwner).not.toBeNull()
      const replacement = await replaceOwnerBinding(ctx, currentOwner!, {
        authId: successorIdentity.subject,
        tokenIdentifier: successorIdentity.tokenIdentifier,
        email: successorIdentity.email,
      })
      expect(replacement).toMatchObject({
        ownerId,
        authId: successorIdentity.subject,
        tokenIdentifier: successorIdentity.tokenIdentifier,
        role: "admin",
      })
    })

    const after = await t.run((ctx) => ctx.db.get(ownerId))
    expect(after).toMatchObject({
      _id: ownerId,
      establishedAt: before!.establishedAt,
      authId: successorIdentity.subject,
      tokenIdentifier: successorIdentity.tokenIdentifier,
    })
    await expectProtectedDenial(t, mediaId, ownerIdentity, "CMS_OWNER_REQUIRED")

    const successor = t.withIdentity(successorIdentity)
    await expect(
      successor.query(api.cms.owner.getOwnerSession, {})
    ).resolves.toMatchObject({ ownerId, role: "admin" })
    await expect(
      successor.query(internal.cms.owner.assertOperationAccessInternal, {})
    ).resolves.toMatchObject({ ownerId, role: "admin" })
    await expect(
      successor.query(internal.cms.owner.assertInstallationOwnerInternal, {})
    ).resolves.toMatchObject({ ownerId, role: "admin" })
    await expect(
      successor.mutation(api.cms.media.update, {
        id: mediaId,
        folder: "successor",
      })
    ).resolves.toBeNull()

    await expect(t.run((ctx) => ctx.db.get(mediaId))).resolves.toMatchObject({
      filename: "legacy.png",
      url: "https://example.test/legacy.png",
      uploadedBy: ownerIdentity.tokenIdentifier,
      folder: "successor",
    })
  })

  test("rejects stale and same-account replacement without changing the current owner row", async () => {
    const sameAccount = makeTest()
    const sameAccountOwnerId = await insertOwner(sameAccount, {
      establishedAt: 123,
    })
    const sameAccountBefore = await sameAccount.run((ctx) =>
      ctx.db.get(sameAccountOwnerId)
    )
    expect(sameAccountBefore).not.toBeNull()

    await expect(
      sameAccount.run((ctx) =>
        replaceOwnerBinding(ctx, sameAccountBefore!, {
          authId: ownerIdentity.subject,
          tokenIdentifier: ownerIdentity.tokenIdentifier,
          email: ownerIdentity.email,
        })
      )
    ).rejects.toThrow("CMS_OWNER_REPLACEMENT_INVALID")
    await expect(
      sameAccount.run((ctx) => ctx.db.get(sameAccountOwnerId))
    ).resolves.toEqual(sameAccountBefore)

    const stale = makeTest()
    const staleOwnerId = await insertOwner(stale, { establishedAt: 456 })
    const staleSnapshot = await stale.run((ctx) => ctx.db.get(staleOwnerId))
    expect(staleSnapshot).not.toBeNull()
    await stale.run((ctx) =>
      ctx.db.patch(staleOwnerId, {
        authId: successorIdentity.subject,
        tokenIdentifier: successorIdentity.tokenIdentifier,
        updatedAt: 2,
      })
    )
    const currentBeforeAttempt = await stale.run((ctx) =>
      ctx.db.get(staleOwnerId)
    )

    await expect(
      stale.run((ctx) =>
        replaceOwnerBinding(ctx, staleSnapshot!, {
          authId: "third-owner-auth-id",
          tokenIdentifier: "https://issuer.test|third-owner-auth-id",
          email: "third-owner@example.test",
        })
      )
    ).rejects.toThrow("CMS_OWNER_STATE_STALE")
    await expect(stale.run((ctx) => ctx.db.get(staleOwnerId))).resolves.toEqual(
      currentBeforeAttempt
    )
  })

  test("authorizes media updates before revealing whether the target exists", async () => {
    const t = makeTest()
    await insertOwner(t)
    const deletedMediaId = await insertHistoricalMedia(t)
    await t.run((ctx) => ctx.db.delete(deletedMediaId))

    await expect(
      t.mutation(api.cms.media.update, {
        id: deletedMediaId,
        folder: "blocked",
      })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t.withIdentity(ownerIdentity).mutation(api.cms.media.update, {
        id: deletedMediaId,
        folder: "missing",
      })
    ).rejects.toThrow("Media not found")
  })

  test("records the exact bounded owner-table read and rejects any other table", async () => {
    const events: string[] = []
    const queryBuilder = {
      eq(field: string, value: string) {
        events.push(`eq:${field}:${value}`)
        return queryBuilder
      },
    }
    const ctx = {
      db: {
        query(table: string) {
          events.push(`query:${table}`)
          if (table !== "cmsOwner") {
            throw new Error(`forbidden owner-path table read: ${table}`)
          }
          return {
            withIndex(
              index: string,
              build: (q: typeof queryBuilder) => typeof queryBuilder
            ) {
              events.push(`index:${index}`)
              build(queryBuilder)
              return {
                take(limit: number) {
                  events.push(`take:${limit}`)
                  return Promise.resolve([])
                },
              }
            },
          }
        },
      },
    } as unknown as QueryCtx

    await expect(readOwnerState(ctx)).resolves.toEqual({ status: "missing" })
    expect(events).toEqual([
      "query:cmsOwner",
      "index:by_key",
      "eq:key:owner",
      "take:2",
    ])
  })

  test("keeps owner resolution isolated from legacy authority tables and retains the singleton schema contract", async () => {
    const paths = ["./lib/access/owner.ts", "./lib/access/policy.ts"]
    const source = (
      await Promise.all(
        paths.map((path) => readFile(new URL(path, import.meta.url), "utf8"))
      )
    ).join("\n")

    for (const table of [
      "roles",
      "rolePermissions",
      "cmsMemberships",
      "cmsCapacity",
      "cmsSeatReservations",
      "teamPublishingPolicies",
      "invites",
      "cmsInstalledEntitlement",
    ]) {
      expect(source).not.toContain(`query(\"${table}\")`)
      expect(source).not.toContain(`query('${table}')`)
    }
    expect(source).toContain('query("cmsOwner")')

    const schemaSource = await readFile(
      new URL("./schema.ts", import.meta.url),
      "utf8"
    )
    expect(schemaSource).toMatch(
      /cmsOwner: defineTable\(\{[\s\S]*?key: v\.literal\("owner"\)[\s\S]*?\.index\("by_key", \["key"\]\)/
    )
  })
})
