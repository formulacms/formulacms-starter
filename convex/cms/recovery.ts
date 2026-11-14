// Owner recovery by one-time link (ADR-0056 rule 4). The owner runs
//   npx convex run cms/recovery:createRecoveryLink '{}'
// in a terminal. It prints a URL; the /recover page calls
// `claimRecoveryLink` with a new username and password. The claim creates the
// new account through the same grant path as the owner code, and
// `users.createUser` moves the owner binding, disables the old account and
// ends its sessions in the same transaction.
import { ConvexError, v } from "convex/values"
import type { Infer } from "convex/values"
import type { SignUpResult } from "@convex-dev/auth/methods/username-password/server"
import { api, internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "../_generated/server"
import type { DatabaseReader } from "../_generated/server"
import { configuredSiteAddress } from "../lib/language/lifecycle"

export const RECOVERY_LINK_TTL_MS = 15 * 60 * 1000

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/**
 * Terminal only. Prints a one-time owner recovery URL valid for 15 minutes.
 * The base URL is `baseUrl`, else the site address saved in Settings. With
 * neither, it throws `RECOVERY_BASE_URL_MISSING`.
 * A new link replaces any open one.
 */
export const createRecoveryLink = internalAction({
  args: { baseUrl: v.optional(v.string()) },
  returns: v.object({ url: v.string(), expiresAt: v.string() }),
  handler: async (ctx, { baseUrl }): Promise<{ url: string; expiresAt: string }> => {
    // The saved site address is read only when no base URL is given.
    const configured =
      baseUrl ??
      configuredSiteAddress(
        (await ctx.runQuery(api.cms.settings.getSiteConfig, {})).siteUrl
      )
    const origin = (configured ?? "").trim().replace(/\/$/, "")
    if (!origin) {
      throw new ConvexError("RECOVERY_BASE_URL_MISSING")
    }
    const token = randomToken()
    const expiresAt = Date.now() + RECOVERY_LINK_TTL_MS
    await ctx.runMutation(internal.cms.recovery.storeRecoveryGrant, {
      tokenHash: await sha256Hex(token),
      expiresAt,
    })
    return {
      url: `${origin}/recover?token=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  },
})

/** Stores the hash. A new grant replaces any open one. */
export const storeRecoveryGrant = internalMutation({
  args: { tokenHash: v.string(), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const open = await ctx.db
      .query("recoveryGrants")
      .withIndex("by_state", (q) => q.eq("state", "open"))
      .take(100)
    for (const grant of open) await ctx.db.delete("recoveryGrants", grant._id)
    await ctx.db.insert("recoveryGrants", { ...args, state: "open" })
    return null
  },
})

type RecoveryLinkLookup =
  | { kind: "unknown" }
  | { kind: "used" }
  | { kind: "open"; link: Doc<"recoveryGrants"> }

/**
 * Finds the grant for a token and says whether its state is open. It does not
 * compare the expiry: a mutation uses the server clock for that, and a query
 * must not read the clock. Shared by `claimRecoveryLink` and
 * `recoveryLinkState`, so both read the link the same way.
 */
async function lookupRecoveryLink(
  ctx: { db: DatabaseReader },
  token: string
): Promise<RecoveryLinkLookup> {
  const tokenHash = await sha256Hex(token)
  const link = await ctx.db
    .query("recoveryGrants")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique()
  if (!link) return { kind: "unknown" }
  if (link.state !== "open") return { kind: "used" }
  return { kind: "open", link }
}

const recoveryLinkStateValidator = v.union(
  v.object({ status: v.literal("open"), expiresAt: v.number() }),
  v.object({ status: v.literal("closed") })
)

/**
 * Read-only check for the /recover page: is this link still open? It answers
 * only open or closed, so an unknown, used or lost link look the same. A query
 * must not read the clock (Convex guidelines), so an open link returns its
 * `expiresAt` and the page compares it with its own clock once, at load. The
 * server clock decides at claim time (`claimRecoveryLink`).
 */
export const recoveryLinkState = query({
  args: { token: v.string() },
  returns: recoveryLinkStateValidator,
  handler: async (
    ctx,
    { token }
  ): Promise<Infer<typeof recoveryLinkStateValidator>> => {
    const found = await lookupRecoveryLink(ctx, token)
    if (found.kind !== "open") return { status: "closed" }
    return { status: "open", expiresAt: found.link.expiresAt }
  },
})

const claimRecoveryLinkResultValidator = v.union(
  v.object({ status: v.literal("claimed") }),
  v.object({
    status: v.union(
      v.literal("RECOVERY_INVALID"),
      v.literal("RECOVERY_USED"),
      v.literal("RECOVERY_EXPIRED")
    ),
  }),
  v.object({ status: v.literal("invalid_input"), error: v.string() })
)

/**
 * Claims a recovery link with a NEW username and password. Every refusal
 * returns a typed status and writes nothing: a failed claim (taken username,
 * short password) leaves the link open. On success the visitor signs in
 * normally afterwards; the session minted by the sign-up is ended here.
 */
export const claimRecoveryLink = mutation({
  args: { token: v.string(), username: v.string(), password: v.string() },
  returns: claimRecoveryLinkResultValidator,
  handler: async (
    ctx,
    { token, username, password }
  ): Promise<Infer<typeof claimRecoveryLinkResultValidator>> => {
    const found = await lookupRecoveryLink(ctx, token)
    if (found.kind === "unknown") return { status: "RECOVERY_INVALID" }
    if (found.kind === "used") return { status: "RECOVERY_USED" }
    const link = found.link
    if (link.expiresAt <= Date.now()) return { status: "RECOVERY_EXPIRED" }

    const grantId = await ctx.db.insert("signupGrants", {
      kind: "recovery",
      recoveryGrantId: link._id,
    })
    let result: SignUpResult
    try {
      result = await ctx.runMutation(api.auth.signUpWithUsernamePassword, {
        username,
        password,
      })
    } catch (error) {
      console.error("claimRecoveryLink: sign-up threw", error)
      await ctx.db.delete("signupGrants", grantId)
      return { status: "RECOVERY_INVALID" }
    }
    if (result.status !== "complete") {
      await ctx.db.delete("signupGrants", grantId)
      return { status: "invalid_input", error: result.userError.error }
    }
    // `createUser` consumed the grant and the link. Fail loudly otherwise.
    const after = await ctx.db.get("recoveryGrants", link._id)
    if (after?.state !== "consumed" || (await ctx.db.get("signupGrants", grantId))) {
      throw new ConvexError("RECOVERY_NOT_CONSUMED")
    }
    await ctx.runMutation(api.auth.signOut, {
      refreshToken: result.tokens.refreshToken,
    })
    return { status: "claimed" }
  },
})
