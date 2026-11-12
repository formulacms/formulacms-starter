/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { hashPassword, verifyPassword } from "better-auth/crypto"
import { describe, expect, test } from "vitest"
import { components, internal } from "./_generated/api"
import schema from "./schema"
import betterAuthTest from "@convex-dev/better-auth/test"

const modules = import.meta.glob("./**/*.ts")

function makeTest() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  return t
}

async function seedUser(options: {
  t: ReturnType<typeof makeTest>
  email: string
  role: string
  durableOwner?: boolean
  withPassword?: boolean
  sessions?: number
}) {
  const now = Date.now()
  const oldPassword = "old-password-123"
  const oldPasswordHash = await hashPassword(oldPassword)

  const authId = await options.t.run(async (ctx) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          email: options.email,
          name: options.email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    const id = user._id as string

    if (options.withPassword !== false) {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "account",
          data: {
            accountId: id,
            providerId: "credential",
            userId: id,
            password: oldPasswordHash,
            createdAt: now,
            updatedAt: now,
          },
        },
      })
    }

    for (let index = 0; index < (options.sessions ?? 0); index += 1) {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "session",
          data: {
            expiresAt: now + 60_000,
            token: `session-${index}`,
            createdAt: now,
            updatedAt: now,
            userId: id,
          },
        },
      })
    }

    await ctx.db.insert("roles", {
      authId: id,
      role: options.role,
      assignedAt: now,
    })
    if (options.durableOwner) {
      await ctx.db.insert("cmsOwner", {
        key: "owner",
        authId: id,
        tokenIdentifier: `https://issuer.test|${id}`,
        establishedAt: now,
        updatedAt: now,
      })
    }
    return id
  })

  return { authId, oldPassword }
}

async function credentialPassword(
  t: ReturnType<typeof makeTest>,
  authId: string
) {
  return await t.run(async (ctx) => {
    const account = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "account",
      where: [
        { field: "userId", operator: "eq", value: authId },
        { field: "providerId", operator: "eq", value: "credential" },
      ],
    })
    return (account?.password as string | undefined) ?? null
  })
}

describe("console admin password recovery", () => {
  test("resets a built-in admin password and revokes every session in bounded batches", async () => {
    const t = makeTest()
    const { authId, oldPassword } = await seedUser({
      t,
      email: "admin@example.com",
      role: "admin",
      durableOwner: true,
      sessions: 101,
    })
    const ownerBefore = await t.run((ctx) =>
      ctx.db
        .query("cmsOwner")
        .withIndex("by_key", (q) => q.eq("key", "owner"))
        .unique()
    )

    await expect(
      t.action(internal.cms.adminPassword.resetAdminPassword, {
        email: " Admin@Example.com ",
        newPassword: "new-password-456",
      })
    ).resolves.toEqual({ reset: true, sessionsRevoked: 101 })

    const password = await credentialPassword(t, authId)
    expect(password).not.toBeNull()
    await expect(
      verifyPassword({ hash: password ?? "", password: oldPassword })
    ).resolves.toBe(false)
    await expect(
      verifyPassword({ hash: password ?? "", password: "new-password-456" })
    ).resolves.toBe(true)

    const sessions = await t.run((ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "session",
        where: [{ field: "userId", operator: "eq", value: authId }],
        paginationOpts: { numItems: 200, cursor: null },
      })
    )
    expect(sessions.page).toEqual([])
    await expect(
      t.run((ctx) => ctx.db.get(ownerBefore!._id))
    ).resolves.toMatchObject({
      _id: ownerBefore?._id,
      authId: ownerBefore?.authId,
      tokenIdentifier: ownerBefore?.tokenIdentifier,
      establishedAt: ownerBefore?.establishedAt,
    })
  })

  test("creates a credential account for an admin who has none", async () => {
    const t = makeTest()
    const { authId } = await seedUser({
      t,
      email: "oauth-admin@example.com",
      role: "admin",
      durableOwner: true,
      withPassword: false,
    })

    await t.action(internal.cms.adminPassword.resetAdminPassword, {
      email: "oauth-admin@example.com",
      newPassword: "new-password-456",
    })

    const password = await credentialPassword(t, authId)
    await expect(
      verifyPassword({ hash: password ?? "", password: "new-password-456" })
    ).resolves.toBe(true)
  })

  test("refuses a legacy Admin that is not the durable owner", async () => {
    const t = makeTest()
    const { authId, oldPassword } = await seedUser({
      t,
      email: "legacy-admin@example.com",
      role: "admin",
    })

    await expect(
      t.action(internal.cms.adminPassword.resetAdminPassword, {
        email: "legacy-admin@example.com",
        newPassword: "new-password-456",
      })
    ).rejects.toThrow(/durable owner account/i)

    const password = await credentialPassword(t, authId)
    await expect(
      verifyPassword({ hash: password ?? "", password: oldPassword })
    ).resolves.toBe(true)
  })

  test("enforces Better Auth password length limits", async () => {
    const t = makeTest()

    await expect(
      t.action(internal.cms.adminPassword.resetAdminPassword, {
        email: "admin@example.com",
        newPassword: "short",
      })
    ).rejects.toThrow(/at least 8 characters/i)

    await expect(
      t.action(internal.cms.adminPassword.resetAdminPassword, {
        email: "admin@example.com",
        newPassword: "x".repeat(129),
      })
    ).rejects.toThrow(/at most 128 characters/i)
  })
})
