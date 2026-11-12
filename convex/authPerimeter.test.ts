/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { api, components } from "./_generated/api"
import { createAuth } from "./auth"
import schema from "./schema"
import betterAuthTest from "@convex-dev/better-auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { addNextAuthClientProof } from "../lib/auth/next-auth-client-proof"

const modules = import.meta.glob("./**/*.ts")

const envSnapshot = new Map<string, string | undefined>()
const TEST_ENV = {
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
  CONTACT_IP_PROOF_SECRET: "test-auth-ip-proof-secret",
  CONVEX_SITE_URL: "http://localhost",
  NEXTCMS_OWNER_CLAIM: "test-owner-claim",
}

function makeTest() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  rateLimiterTest.register(t)
  return t
}

async function postEmailSignup(
  t: ReturnType<typeof makeTest>,
  headers: Record<string, string> = {},
  email = "uninvited@example.com"
) {
  return await t.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_ENV.CONVEX_SITE_URL,
      ...headers,
    },
    body: JSON.stringify({
      name: "Uninvited user",
      email,
      password: "password123",
    }),
  })
}

async function postNextEmailSignup(
  t: ReturnType<typeof makeTest>,
  headers: Record<string, string>,
  email = "next-uninvited@example.com"
) {
  const request = await addNextAuthClientProof(
    new Request(`${TEST_ENV.CONVEX_SITE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_ENV.CONVEX_SITE_URL,
        ...headers,
      },
      body: JSON.stringify({
        name: "Next uninvited user",
        email,
        password: "password123",
      }),
    }),
    { secret: TEST_ENV.CONTACT_IP_PROOF_SECRET }
  )

  return await t.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: request.headers,
    body: await request.text(),
  })
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

describe("G0-B — account-creation perimeter", () => {
  beforeEach(() => {
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
      envSnapshot.set(key, process.env[key])
    }
    for (const [key, value] of Object.entries(TEST_ENV)) {
      envSnapshot.set(key, process.env[key])
      process.env[key] = value
    }
  })

  afterEach(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    envSnapshot.clear()
  })

  test("the direct Convex auth origin rejects email signup without the owner claim", async () => {
    const t = makeTest()

    const response = await postEmailSignup(t)

    expect(response.status).toBe(403)
    await t.run(async (ctx) => {
      const users = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "user",
        paginationOpts: { numItems: 10, cursor: null },
      })
      expect(users.page).toHaveLength(0)
    })
  })

  test("email signup fails closed when the deployment owner claim is unset", async () => {
    const t = makeTest()
    delete process.env.NEXTCMS_OWNER_CLAIM

    const response = await postEmailSignup(t, {
      "x-nextcms-owner-claim": "caller-supplied-claim",
    })

    expect(response.status).toBe(403)
  })

  test("the direct Convex auth origin rejects a consumed owner claim", async () => {
    const t = makeTest()
    await t.run(async (ctx) => {
      await ctx.db.insert("ownerClaimLedger", {
        key: "owner",
        secretHash: await sha256Hex(TEST_ENV.NEXTCMS_OWNER_CLAIM),
        claimedBy: "existing-owner",
        claimedAt: Date.now(),
        recovery: false,
      })
    })

    const response = await postEmailSignup(t, {
      "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
    })

    expect(response.status).toBe(403)
    await t.run(async (ctx) => {
      const users = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "user",
        paginationOpts: { numItems: 10, cursor: null },
      })
      expect(users.page).toHaveLength(0)
    })
  })

  test("the direct Convex auth origin permits the available configured owner claim", async () => {
    const t = makeTest()

    const response = await postEmailSignup(t, {
      "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
    })

    expect(response.status).toBe(200)
    const authId = await t.run(async (ctx) => {
      const users = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "user",
        paginationOpts: { numItems: 10, cursor: null },
      })
      expect(users.page).toHaveLength(1)
      expect(users.page[0]?.email).toBe("uninvited@example.com")
      // Admission is coordination only. It must not initialize legacy
      // capacity, reservations, membership, or role authority.
      expect(await ctx.db.query("cmsSeatReservations").take(1)).toEqual([])
      expect(await ctx.db.query("cmsCapacity").take(1)).toEqual([])
      expect(await ctx.db.query("cmsMemberships").take(1)).toEqual([])
      expect(await ctx.db.query("roles").take(1)).toEqual([])
      return users.page[0]?._id as string
    })
    expect(authId).toEqual(expect.any(String))
  })

  test("a signup race may leave an auth account but grants exactly one owner", async () => {
    const t = makeTest()
    const headers = {
      "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
    }

    const first = await postEmailSignup(t, headers, "first@example.com")
    const second = await postEmailSignup(t, headers, "second@example.com")
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const users = await t.run(async (ctx) => {
      const result = await ctx.runQuery(
        components.betterAuth.adapter.findMany,
        {
          model: "user",
          paginationOpts: { numItems: 10, cursor: null },
        }
      )
      return result.page
    })
    const firstAuthId = users.find(
      (user: Record<string, unknown>) => user.email === "first@example.com"
    )?._id as string
    const secondAuthId = users.find(
      (user: Record<string, unknown>) => user.email === "second@example.com"
    )?._id as string
    const firstIdentity = {
      subject: firstAuthId,
      tokenIdentifier: `https://issuer.test|${firstAuthId}`,
    }
    const secondIdentity = {
      subject: secondAuthId,
      tokenIdentifier: `https://issuer.test|${secondAuthId}`,
    }

    await expect(
      t.withIdentity(firstIdentity).mutation(api.cms.owner.claimOwner, {
        claim: TEST_ENV.NEXTCMS_OWNER_CLAIM,
      })
    ).resolves.toEqual({ status: "claimed" })
    await expect(
      t.withIdentity(secondIdentity).mutation(api.cms.owner.claimOwner, {
        claim: TEST_ENV.NEXTCMS_OWNER_CLAIM,
      })
    ).resolves.toEqual({ status: "unavailable" })
    await expect(
      t.withIdentity(secondIdentity).query(api.cms.owner.getOwnerSession, {})
    ).resolves.toBeNull()

    const closed = await postEmailSignup(t, headers, "after-owner@example.com")
    expect(closed.status).toBe(403)
  })

  test("a rotated claim admits and binds a successor, then closes again", async () => {
    const t = makeTest()
    const ownerAuthId = "current-owner"
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("cmsOwner", {
        key: "owner",
        authId: ownerAuthId,
        tokenIdentifier: `https://issuer.test|${ownerAuthId}`,
        establishedAt: now,
        updatedAt: now,
      })
      await ctx.db.insert("ownerClaimLedger", {
        key: "owner",
        secretHash: await sha256Hex(TEST_ENV.NEXTCMS_OWNER_CLAIM),
        claimedBy: ownerAuthId,
        claimedAt: now,
        recovery: false,
      })
      // Retained compatibility rows neither select nor block the durable
      // owner's explicitly rotated replacement.
      await ctx.db.insert("roles", {
        authId: "legacy-admin",
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: "legacy-admin",
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "legacy",
      })
    })

    const unchanged = await postEmailSignup(t, {
      "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
    })
    expect(unchanged.status).toBe(403)

    const rotatedClaim = "rotated-owner-claim"
    process.env.NEXTCMS_OWNER_CLAIM = rotatedClaim
    const admitted = await postEmailSignup(
      t,
      { "x-nextcms-owner-claim": rotatedClaim },
      "successor@example.com"
    )
    expect(admitted.status).toBe(200)

    const successorAuthId = await t.run(async (ctx) => {
      const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "user",
        where: [
          { field: "email", operator: "eq", value: "successor@example.com" },
        ],
      })
      return user?._id as string
    })
    const successorIdentity = {
      subject: successorAuthId,
      tokenIdentifier: `https://issuer.test|${successorAuthId}`,
    }
    await expect(
      t.withIdentity(successorIdentity).mutation(api.cms.owner.replaceOwner, {
        claim: rotatedClaim,
      })
    ).resolves.toEqual({ status: "claimed" })
    await expect(
      t.withIdentity(successorIdentity).query(api.cms.owner.getOwnerSession, {})
    ).resolves.toMatchObject({ authId: successorAuthId, role: "admin" })

    const replay = await postEmailSignup(
      t,
      { "x-nextcms-owner-claim": rotatedClaim },
      "replay@example.com"
    )
    expect(replay.status).toBe(403)
  })

  test("the direct Convex auth origin rate-limits one client without locking out another", async () => {
    const t = makeTest()
    const limitedClient = "203.0.113.10"

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postEmailSignup(t, {
        "x-forwarded-for": limitedClient,
        "x-nextcms-owner-claim": "wrong-owner-claim",
      })
      expect(response.status).toBe(403)
    }

    const limitedResponse = await postEmailSignup(
      t,
      {
        "x-forwarded-for": limitedClient,
        "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
      },
      "limited-client@example.com"
    )
    expect(limitedResponse.status).toBe(429)

    const otherClientResponse = await postEmailSignup(
      t,
      {
        "x-forwarded-for": "203.0.113.11",
        "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
      },
      "other-client@example.com"
    )
    expect(otherClientResponse.status).toBe(200)
  })

  test("the signed Next auth origin has an independent trusted client bucket", async () => {
    const t = makeTest()
    const clientIp = "203.0.113.20"

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postNextEmailSignup(t, {
        "x-forwarded-for": clientIp,
        "x-nextcms-owner-claim": "wrong-owner-claim",
      })
      expect(response.status).toBe(403)
    }

    const nextLimitedResponse = await postNextEmailSignup(
      t,
      {
        "x-forwarded-for": clientIp,
        "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
      },
      "next-limited@example.com"
    )
    expect(nextLimitedResponse.status).toBe(429)

    const directResponse = await postEmailSignup(
      t,
      {
        "x-forwarded-for": clientIp,
        "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
      },
      "direct-after-next@example.com"
    )
    expect(directResponse.status).toBe(200)
  })

  test("the Next auth origin permits the available configured owner claim", async () => {
    const t = makeTest()

    const response = await postNextEmailSignup(t, {
      "x-forwarded-for": "203.0.113.21",
      "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
    })

    expect(response.status).toBe(200)
  })

  test("the Next auth origin fails closed without a trusted client identity", async () => {
    const t = makeTest()

    const response = await postNextEmailSignup(t, {
      "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
    })

    expect(response.status).toBe(403)
    await t.run(async (ctx) => {
      const users = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "user",
        paginationOpts: { numItems: 10, cursor: null },
      })
      expect(users.page).toHaveLength(0)
    })
  })

  test("a forged Next proof fails closed instead of falling back to direct-origin identity", async () => {
    const t = makeTest()

    const response = await postEmailSignup(t, {
      "x-forwarded-for": "203.0.113.22",
      "x-nextcms-auth-origin": "next",
      "x-nextcms-auth-ip-hash": "a".repeat(64),
      "x-nextcms-auth-ip-expires-at": String(Date.now() + 60_000),
      "x-nextcms-auth-ip-signature": "b".repeat(64),
      "x-nextcms-owner-claim": TEST_ENV.NEXTCMS_OWNER_CLAIM,
    })

    expect(response.status).toBe(403)
  })

  test("configured social providers cannot create implicit users", async () => {
    const t = makeTest()
    process.env.GOOGLE_CLIENT_ID = "test-google-client"
    process.env.GOOGLE_CLIENT_SECRET = "test-google-secret"

    await t.run(async (ctx) => {
      const auth = createAuth(ctx)
      expect(auth.options.socialProviders?.google).toMatchObject({
        disableImplicitSignUp: true,
        disableSignUp: true,
      })
    })
  })

  test("direct signup accepts a formulacms-only owner claim", async () => {
    const legacy = process.env.NEXTCMS_OWNER_CLAIM
    delete process.env.NEXTCMS_OWNER_CLAIM
    process.env.FORMULACMS_OWNER_CLAIM = "formulacms-only-owner-claim"
    try {
      const response = await postEmailSignup(makeTest(), {
        "x-nextcms-owner-claim": "formulacms-only-owner-claim",
      })
      expect(response.status).toBe(200)
    } finally {
      delete process.env.FORMULACMS_OWNER_CLAIM
      if (legacy !== undefined) process.env.NEXTCMS_OWNER_CLAIM = legacy
    }
  })

  test("direct signup gives the formulacms claim precedence over the legacy claim", async () => {
    const current = process.env.FORMULACMS_OWNER_CLAIM
    const legacy = process.env.NEXTCMS_OWNER_CLAIM
    process.env.FORMULACMS_OWNER_CLAIM = "current-owner-claim"
    process.env.NEXTCMS_OWNER_CLAIM = "legacy-owner-claim"
    try {
      const t = makeTest()
      const rejected = await postEmailSignup(t, {
        "x-nextcms-owner-claim": "legacy-owner-claim",
      })
      expect(rejected.status).toBe(403)

      const accepted = await postEmailSignup(t, {
        "x-nextcms-owner-claim": "current-owner-claim",
      })
      expect(accepted.status).toBe(200)
    } finally {
      if (current === undefined) delete process.env.FORMULACMS_OWNER_CLAIM
      else process.env.FORMULACMS_OWNER_CLAIM = current
      if (legacy === undefined) delete process.env.NEXTCMS_OWNER_CLAIM
      else process.env.NEXTCMS_OWNER_CLAIM = legacy
    }
  })
})
