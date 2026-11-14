/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { sessionIdentity } from "@convex-dev/auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { api, components, internal } from "./_generated/api"
import { getActor } from "./lib/access/actor"
import schema from "./schema"
import { registerAuthComponents } from "../test-utils/convexAuthFixtures"

const modules = import.meta.glob("./**/*.ts")

const CODE = "initial-owner-claim"
const OLD_PASSWORD = "correct horse battery"
const NEW_PASSWORD = "another long passphrase"

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

/** An installation whose owner "ada" has signed in once. */
async function siteWithOwner() {
  const t = makeTest()
  await expect(
    t.mutation(api.cms.owner.createOwnerAccount, {
      code: CODE,
      name: "Ada Owner",
      username: "ada",
      password: OLD_PASSWORD,
    })
  ).resolves.toEqual({ status: "created" })
  const oldTokens = await signIn(t, "ada", OLD_PASSWORD)
  return { t, oldTokens }
}

async function newLink(t: Site): Promise<string> {
  const { url } = await t.action(internal.cms.recovery.createRecoveryLink, {
    baseUrl: "https://site.test/",
  })
  const token = new URL(url).searchParams.get("token")
  if (!token) throw new Error("no token in link")
  return token
}

function claim(t: Site, token: string, username = "grace", password = NEW_PASSWORD) {
  return t.mutation(api.cms.recovery.claimRecoveryLink, {
    token,
    username,
    password,
  })
}

async function counts(t: Site) {
  return t.run(async (ctx) => ({
    users: (await ctx.db.query("users").collect()).length,
    owners: (await ctx.db.query("cmsOwner").collect()).length,
    grants: (await ctx.db.query("signupGrants").collect()).length,
    links: (await ctx.db.query("recoveryGrants").collect()).length,
  }))
}

describe("owner recovery by one-time link (ADR-0056 rule 4)", () => {
  beforeEach(() => {
    vi.stubEnv("FORMULACMS_OWNER_CLAIM", CODE)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test("the terminal action prints a URL on the given base and stores only a hash", async () => {
    const { t } = await siteWithOwner()
    const { url, expiresAt } = await t.action(
      internal.cms.recovery.createRecoveryLink,
      { baseUrl: "https://site.test/" }
    )
    expect(url).toMatch(/^https:\/\/site\.test\/recover\?token=[A-Za-z0-9_-]{43}$/)
    const minutes = (Date.parse(expiresAt) - Date.now()) / 60_000
    expect(minutes).toBeGreaterThan(14)
    expect(minutes).toBeLessThanOrEqual(15)
    const token = new URL(url).searchParams.get("token")!
    const [row] = await t.run((ctx) => ctx.db.query("recoveryGrants").collect())
    expect(row!.state).toBe("open")
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(token)
  })

  test("without a base URL or a saved site address the action refuses", async () => {
    vi.stubEnv("SITE_URL", "")
    const { t } = await siteWithOwner()
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    )
    await expect(
      t.action(internal.cms.recovery.createRecoveryLink, {})
    ).rejects.toThrow("RECOVERY_BASE_URL_MISSING")
    expect((await counts(t)).links).toBe(0)
  })

  test("a claim moves ownership, disables the old account and ends its sessions", async () => {
    const { t, oldTokens } = await siteWithOwner()
    const oldOwner = await t.run((ctx) => ctx.db.query("cmsOwner").unique())
    const asOld = t.withIdentity(sessionIdentity(oldTokens))
    await expect(asOld.run((ctx) => getActor(ctx))).resolves.not.toBeNull()

    const token = await newLink(t)
    await expect(claim(t, token)).resolves.toEqual({ status: "claimed" })

    // Exactly one owner, bound to the new user; same durable row.
    await t.run(async (ctx) => {
      const owners = await ctx.db.query("cmsOwner").collect()
      const users = await ctx.db.query("users").collect()
      expect(owners).toHaveLength(1)
      expect(owners[0]!._id).toBe(oldOwner!._id)
      const oldUser = users.find((user) => user._id === oldOwner!.authId)!
      const newUser = users.find((user) => user._id !== oldOwner!.authId)!
      expect(owners[0]).toMatchObject({
        authId: newUser._id,
        tokenIdentifier: newUser._id,
      })
      expect(oldUser.disabled).toBe(true)
      expect(newUser.disabled).toBeUndefined()
      // The new account keeps the label typed at setup.
      expect(newUser.name).toBe("Ada Owner")
      expect(await ctx.db.query("signupGrants").collect()).toEqual([])
      const ledger = await ctx.db.query("ownerClaimLedger").unique()
      expect(ledger).toMatchObject({ claimedBy: newUser._id, recovery: true })
      // The session minted by the claim's sign-up is ended too.
      expect(
        await ctx.runQuery(components.auth.public.listSessions, {
          userId: newUser._id,
        })
      ).toEqual([])
    })

    // The old session is gone and the old account is refused at sign-in.
    await expect(asOld.run((ctx) => getActor(ctx))).resolves.toBeNull()
    await expect(
      asOld.query(internal.cms.owner.assertInstallationOwnerInternal, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      t.mutation(api.auth.signInWithUsernamePassword, {
        username: "ada",
        password: OLD_PASSWORD,
      })
    ).rejects.toThrow(/ACCOUNT_DISABLED/)

    // The new account signs in and is the owner.
    const newTokens = await signIn(t, "grace", NEW_PASSWORD)
    await expect(
      t
        .withIdentity(sessionIdentity(newTokens))
        .query(internal.cms.owner.assertInstallationOwnerInternal, {})
    ).resolves.toMatchObject({ ownerId: oldOwner!._id, role: "admin" })
    await expect(
      t
        .withIdentity(sessionIdentity(newTokens))
        .query(api.cms.owner.getOwnerSession, {})
    ).resolves.toMatchObject({ displayName: "Ada Owner" })
  })

  test("a link works once", async () => {
    const { t } = await siteWithOwner()
    const token = await newLink(t)
    await expect(claim(t, token)).resolves.toEqual({ status: "claimed" })
    const before = await counts(t)
    await expect(claim(t, token, "heidi")).resolves.toEqual({
      status: "RECOVERY_USED",
    })
    expect(await counts(t)).toEqual(before)
  })

  test("an unknown token and an expired link are refused and write nothing", async () => {
    const { t } = await siteWithOwner()
    const token = await newLink(t)
    const before = await counts(t)
    await expect(claim(t, "not-a-real-token")).resolves.toEqual({
      status: "RECOVERY_INVALID",
    })
    await t.run(async (ctx) => {
      const link = (await ctx.db.query("recoveryGrants").collect())[0]!
      await ctx.db.patch("recoveryGrants", link._id, {
        expiresAt: Date.now() - 1,
      })
    })
    await expect(claim(t, token)).resolves.toEqual({
      status: "RECOVERY_EXPIRED",
    })
    expect(await counts(t)).toEqual(before)
    const owner = await t.run((ctx) => ctx.db.query("cmsOwner").unique())
    expect(owner?.authId).toBe(
      (await t.run((ctx) => ctx.db.query("users").first()))!._id
    )
  })

  test("a new link replaces the open one", async () => {
    const { t } = await siteWithOwner()
    const first = await newLink(t)
    const second = await newLink(t)
    expect((await counts(t)).links).toBe(1)
    await expect(claim(t, first)).resolves.toEqual({ status: "RECOVERY_INVALID" })
    await expect(claim(t, second)).resolves.toEqual({ status: "claimed" })
  })

  test("a failed claim (short password, taken username) leaves the link open and writes nothing", async () => {
    const { t } = await siteWithOwner()
    const token = await newLink(t)
    const before = await counts(t)
    const short = await claim(t, token, "grace", "123456789")
    expect(short).toMatchObject({ status: "invalid_input" })
    await expect(claim(t, token, "ada")).resolves.toEqual({
      status: "invalid_input",
      error: "USERNAME_TAKEN",
    })
    expect(await counts(t)).toEqual(before)
    const link = (await t.run((ctx) => ctx.db.query("recoveryGrants").collect()))[0]!
    expect(link.state).toBe("open")
    await expect(claim(t, token)).resolves.toEqual({ status: "claimed" })
  })

  test("recovery works while wrong guesses have rate-limited the old account", async () => {
    const { t } = await siteWithOwner()
    let limited = false
    for (let attempt = 0; attempt < 8 && !limited; attempt += 1) {
      const result = await t.mutation(api.auth.signInWithUsernamePassword, {
        username: "ada",
        password: `wrong password ${attempt}`,
      })
      limited =
        result.status === "error" && result.userError.error === "RATE_LIMITED"
    }
    expect(limited).toBe(true)
    const token = await newLink(t)
    await expect(claim(t, token)).resolves.toEqual({ status: "claimed" })
    await signIn(t, "grace", NEW_PASSWORD)
  })

  test("two concurrent claims of one link produce exactly one owner", async () => {
    const { t } = await siteWithOwner()
    const token = await newLink(t)
    const results = await Promise.all([
      claim(t, token, "grace"),
      claim(t, token, "heidi"),
    ])
    expect(results.filter((r) => r.status === "claimed")).toHaveLength(1)
    const loser = results.find((r) => r.status !== "claimed")!
    expect(loser.status).toBe("RECOVERY_USED")
    const owners = await t.run((ctx) => ctx.db.query("cmsOwner").collect())
    expect(owners).toHaveLength(1)
    const users = await t.run((ctx) => ctx.db.query("users").collect())
    expect(users).toHaveLength(2)
  })

  test("the link check says open with the expiry for an open link and writes nothing", async () => {
    const { t } = await siteWithOwner()
    const token = await newLink(t)
    const before = await counts(t)
    const stored = (await t.run((ctx) => ctx.db.query("recoveryGrants").collect()))[0]!
    await expect(
      t.query(api.cms.recovery.recoveryLinkState, { token })
    ).resolves.toEqual({ status: "open", expiresAt: stored.expiresAt })
    expect(await counts(t)).toEqual(before)
    expect(
      (await t.run((ctx) => ctx.db.query("recoveryGrants").collect()))[0]
    ).toEqual(stored)
  })

  test("the link check says closed for a replaced, unknown or used link, and open with its past expiry for an expired one", async () => {
    const { t } = await siteWithOwner()
    const closed = { status: "closed" }
    const first = await newLink(t)
    const second = await newLink(t)
    await expect(
      t.query(api.cms.recovery.recoveryLinkState, { token: first })
    ).resolves.toEqual(closed)
    await expect(
      t.query(api.cms.recovery.recoveryLinkState, { token: "not-a-real-token" })
    ).resolves.toEqual(closed)

    // A past expiry stays "open" with that expiry: the page compares the
    // clock, and the claim (server clock) still refuses it. A full minute in
    // the past: convex-test pins Date.now() in t.run to its transaction time,
    // which can run a millisecond ahead of the test's own clock.
    await t.run(async (ctx) => {
      const link = (await ctx.db.query("recoveryGrants").collect())[0]!
      await ctx.db.patch("recoveryGrants", link._id, {
        expiresAt: Date.now() - 60_000,
      })
    })
    const expired = await t.query(api.cms.recovery.recoveryLinkState, {
      token: second,
    })
    expect(expired.status).toBe("open")
    if (expired.status === "open") expect(expired.expiresAt).toBeLessThan(Date.now())
    await expect(claim(t, second)).resolves.toEqual({ status: "RECOVERY_EXPIRED" })

    await t.run(async (ctx) => {
      const link = (await ctx.db.query("recoveryGrants").collect())[0]!
      await ctx.db.patch("recoveryGrants", link._id, {
        expiresAt: Date.now() + 60_000,
      })
    })
    await expect(claim(t, second)).resolves.toEqual({ status: "claimed" })
    await expect(
      t.query(api.cms.recovery.recoveryLinkState, { token: second })
    ).resolves.toEqual(closed)
  })

  test("an open link does not open plain sign-up", async () => {
    const { t } = await siteWithOwner()
    await newLink(t)
    await expect(
      t.mutation(api.auth.signUpWithUsernamePassword, {
        username: "mallory",
        password: NEW_PASSWORD,
      })
    ).rejects.toThrow(/SIGNUP_CLOSED/)
  })
})
