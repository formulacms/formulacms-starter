/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { sessionIdentity } from "@convex-dev/auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { api } from "./_generated/api"
import { getActor } from "./lib/access/actor"
import schema from "./schema"
import {
  issueFixtureSession,
  registerAuthComponents,
} from "../test-utils/convexAuthFixtures"

const modules = import.meta.glob("./**/*.ts")

const CODE = "initial-owner-claim"
const PASSWORD = "correct horse battery"
const NEW_PASSWORD = "a different long passphrase"

function makeTest() {
  const t = convexTest(schema, modules)
  rateLimiterTest.register(t)
  registerAuthComponents(t)
  return t
}
type Site = ReturnType<typeof makeTest>

async function signIn(t: Site, username: string, password: string) {
  const result = await t.mutation(api.auth.signInWithUsernamePassword, {
    username,
    password,
  })
  if (result.status !== "complete") {
    throw new Error(`sign-in failed: ${result.userError.error}`)
  }
  return result.tokens
}

async function siteWithOwner() {
  const t = makeTest()
  await t.mutation(api.cms.owner.createOwnerAccount, {
    code: CODE,
    name: "Ada Owner",
    username: "ada",
    password: PASSWORD,
  })
  return t
}

beforeEach(() => {
  vi.stubEnv("FORMULACMS_OWNER_CLAIM", CODE)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("own password change", () => {
  test("a wrong current password is refused and changes nothing", async () => {
    const t = await siteWithOwner()
    const tokens = await signIn(t, "ada", PASSWORD)
    const asOwner = t.withIdentity(sessionIdentity(tokens))
    await expect(
      asOwner.mutation(api.account.changeMyPassword, {
        currentPassword: "not my password",
        newPassword: NEW_PASSWORD,
      })
    ).resolves.toEqual({ status: "wrong_password" })
    await signIn(t, "ada", PASSWORD)
  })

  test("an invalid new password is a typed input error", async () => {
    const t = await siteWithOwner()
    const asOwner = t.withIdentity(sessionIdentity(await signIn(t, "ada", PASSWORD)))
    await expect(
      asOwner.mutation(api.account.changeMyPassword, {
        currentPassword: PASSWORD,
        newPassword: "short",
      })
    ).resolves.toEqual({ status: "invalid_input", error: "PASSWORD_TOO_SHORT" })
  })

  test("success changes the password, keeps this session and ends the others", async () => {
    const t = await siteWithOwner()
    const mine = await signIn(t, "ada", PASSWORD)
    const other = await signIn(t, "ada", PASSWORD)
    const asMine = t.withIdentity(sessionIdentity(mine))
    const asOther = t.withIdentity(sessionIdentity(other))
    await expect(
      asMine.mutation(api.account.changeMyPassword, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      })
    ).resolves.toEqual({ status: "changed" })
    await expect(asMine.run((ctx) => getActor(ctx))).resolves.not.toBeNull()
    await expect(asOther.run((ctx) => getActor(ctx))).resolves.toBeNull()
    await expect(
      t.mutation(api.auth.signInWithUsernamePassword, {
        username: "ada",
        password: PASSWORD,
      })
    ).resolves.toMatchObject({ status: "error" })
    await signIn(t, "ada", NEW_PASSWORD)
  })

  test("repeated wrong current passwords are rate-limited", async () => {
    const t = await siteWithOwner()
    const asOwner = t.withIdentity(sessionIdentity(await signIn(t, "ada", PASSWORD)))
    let limited: unknown = null
    for (let attempt = 0; attempt < 8 && !limited; attempt += 1) {
      const result = await asOwner.mutation(api.account.changeMyPassword, {
        currentPassword: `wrong ${attempt} password`,
        newPassword: NEW_PASSWORD,
      })
      if (result.status === "rate_limited") limited = result
    }
    expect(limited).toMatchObject({
      status: "rate_limited",
      retryAfterMs: expect.any(Number),
    })
  })

  test("a signed-out caller is refused", async () => {
    const t = await siteWithOwner()
    await expect(
      t.mutation(api.account.changeMyPassword, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toThrow("UNAUTHENTICATED")
  })
})

describe("owner notification email (ADR-0056 rule 5)", () => {
  test("the owner saves, reads, changes and clears it; invalid values are refused", async () => {
    const t = await siteWithOwner()
    const asOwner = t.withIdentity(sessionIdentity(await signIn(t, "ada", PASSWORD)))
    await expect(
      asOwner.query(api.cms.owner.getNotificationEmail, {})
    ).resolves.toBeNull()
    await expect(
      asOwner.mutation(api.cms.owner.setNotificationEmail, { email: "no-at-sign" })
    ).resolves.toEqual({ status: "invalid_email" })
    await expect(
      asOwner.mutation(api.cms.owner.setNotificationEmail, {
        email: " owner@example.test ",
      })
    ).resolves.toEqual({ status: "saved" })
    await expect(
      asOwner.query(api.cms.owner.getNotificationEmail, {})
    ).resolves.toBe("owner@example.test")
    await expect(
      asOwner.mutation(api.cms.owner.setNotificationEmail, { email: null })
    ).resolves.toEqual({ status: "saved" })
    await expect(
      asOwner.query(api.cms.owner.getNotificationEmail, {})
    ).resolves.toBeNull()
  })

  test("a signed-out caller and a non-owner session are refused", async () => {
    const t = await siteWithOwner()
    await expect(
      t.query(api.cms.owner.getNotificationEmail, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    const stranger = t.withIdentity(await issueFixtureSession(t, "stranger-user"))
    await expect(
      stranger.query(api.cms.owner.getNotificationEmail, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      stranger.mutation(api.cms.owner.setNotificationEmail, {
        email: "x@example.test",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    const owner = await t.run((ctx) => ctx.db.query("cmsOwner").unique())
    expect(owner?.notificationEmail).toBeUndefined()
  })
})

describe("display name (ADR-0056 rule 8)", () => {
  test("the public header label returns the name and no username, user ID or session ID", async () => {
    const t = await siteWithOwner()
    const tokens = await signIn(t, "ada", PASSWORD)
    const label = await t
      .withIdentity(sessionIdentity(tokens))
      .query(api.users.getCurrentUserLabel, {})
    expect(label).toEqual({ name: "Ada Owner" })
    expect(Object.keys(label!)).toEqual(["name"])
    const serialized = JSON.stringify(label)
    expect(serialized).not.toContain("ada\"")
    expect(serialized).not.toContain(sessionIdentity(tokens).subject)
    await expect(t.query(api.users.getCurrentUserLabel, {})).resolves.toBeNull()
  })

  test("presence rows carry the display name, never an email or username", async () => {
    const t = await siteWithOwner()
    const asOwner = t.withIdentity(sessionIdentity(await signIn(t, "ada", PASSWORD)))
    await t.run(async (ctx) => {
      await ctx.db.insert("pagePublicationCutover", {
        key: "published-snapshot-v1",
        phase: "legacy",
        revision: 1,
        updatedAt: 1,
      })
      await ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    })
    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Presence page",
    })
    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })
    const editors = await asOwner.query(api.cms.pages.listActiveEditors, { pageId })
    expect(editors).toHaveLength(1)
    expect(editors[0]).toMatchObject({ name: "Ada Owner" })
    expect(editors[0]!.email).toBeUndefined()
  })
})
