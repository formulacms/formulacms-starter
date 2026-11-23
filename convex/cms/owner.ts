import { ConvexError, v } from "convex/values"
import type { Infer } from "convex/values"
import type { SignUpResult } from "@convex-dev/auth/methods/username-password/server"
import { api } from "../_generated/api"
import {
  env,
  internalQuery,
  mutation,
  query,
} from "../_generated/server"
import {
  getOwnerIdentity,
  ownerDisplayName,
  ownerUsername,
  ownerPresenceValidator,
  ownerPrincipalValidator,
  ownerSessionValidator,
  readOwnerState,
  resolveOwnerPrincipal,
} from "../lib/access/owner"
import { isEmailAddress } from "../lib/email/providerState"
import {
  requireInstallationOwner,
  requireOperationAccess,
} from "../lib/access/policy"
import {
  equalOwnerClaimHashes,
  hashOwnerClaim,
  resolveOwnerClaimTransition,
} from "../lib/ownerClaim"
import { getOwnerNotificationEmail } from "../lib/access/actor"
import { rateLimiter } from "../lib/rateLimits"
import { resolveOwnerClaim } from "../lib/environment"
import { startRichTextImageBackfill } from "../lib/media/richTextBackfill"

/**
 * Typed result of `createOwnerAccount`. No error text crosses this boundary:
 * `unavailable` covers every refusal that must not reveal why (wrong code,
 * owner exists, rate limit), and `invalid_input` carries a
 * stable code for a field the person can fix.
 */
const createOwnerAccountResultValidator = v.union(
  v.object({ status: v.literal("created") }),
  v.object({ status: v.literal("unavailable") }),
  v.object({ status: v.literal("invalid_input"), error: v.string() })
)

const OWNER_NAME_MAX_LENGTH = 100

function configuredOwnerClaimHash(): Promise<string | null> {
  const claim = resolveOwnerClaim(env)
  return claim?.trim() ? hashOwnerClaim(claim) : Promise.resolve(null)
}

/**
 * True when the configured owner code has the shape the setup tools create:
 * 64 hexadecimal characters. It reads only the configured code, never the
 * submitted one, so a caller cannot choose which rule applies to them. It
 * tests the raw value that the code check hashes, untrimmed: a padded value
 * is not the generated shape and keeps the limit.
 */
function configuredOwnerClaimIsGenerated(): boolean {
  const claim = resolveOwnerClaim(env)
  return claim !== undefined && /^[0-9a-f]{64}$/i.test(claim)
}

async function submittedClaimMatchesConfigured(
  claim: string
): Promise<string | null> {
  const [configuredHash, submittedHash] = await Promise.all([
    configuredOwnerClaimHash(),
    hashOwnerClaim(claim),
  ])
  if (
    !configuredHash ||
    !equalOwnerClaimHashes(configuredHash, submittedHash)
  ) {
    return null
  }
  return configuredHash
}

function isSanitizedOwnerState(error: unknown): boolean {
  return (
    error instanceof ConvexError &&
    (error.data === "CMS_OWNER_STATE_INVALID" ||
      error.data === "CMS_OWNER_BINDING_INVALID")
  )
}

export const getOwnerEstablished = query({
  args: {},
  returns: ownerPresenceValidator,
  handler: async (ctx) => {
    const state = await readOwnerState(ctx)
    return { established: state.status !== "missing" }
  },
})

/** Public setup signal. It does not identify a blocking legacy record. */
export const getOwnerClaimAvailability = query({
  args: {},
  returns: v.object({ available: v.boolean() }),
  handler: async (ctx) => {
    const claimHash = await configuredOwnerClaimHash()
    // Only a fresh installation can create the owner: a rotated code with an
    // owner already present is no longer a recovery path here (ADR-0056 rule
    // 4 moves recovery to a one-time link in B1b).
    return {
      available:
        claimHash !== null &&
        (await resolveOwnerClaimTransition(ctx)).kind === "fresh",
    }
  },
})

/** A valid notification email, trimmed with its case kept, or null (empty, over 254 characters, or not an address). */
function parseNotificationEmail(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 254 || !isEmailAddress(trimmed)) {
    return null
  }
  return trimmed
}

/**
 * Creates the first owner account (ADR-0056 rule 1, owner-code grant). One
 * transaction: the owner-code check with the global owner-claim limit, a
 * claiming grant, the library sign-up (which calls `users.createUser`, which
 * consumes the grant and binds the durable owner), then the minted session is
 * ended. The person signs in
 * afterwards through the normal sign-in route.
 *
 * The global limit bounds code guessing. A wrong code (or any code when none
 * is configured) always uses up one try. The right code gets in without
 * touching the limit when the configured code is the long random kind the
 * setup tools create (64 hex characters), because that code cannot be
 * guessed; a hand-set code keeps the limit before the check, as before.
 *
 * Every refusal returns normally so the rate-limit writes commit. A failed
 * sign-up deletes the grant before returning, so no committed state holds one.
 */
export const createOwnerAccount = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    username: v.string(),
    password: v.string(),
    notificationEmail: v.optional(v.string()),
  },
  returns: createOwnerAccountResultValidator,
  handler: async (
    ctx,
    args
  ): Promise<Infer<typeof createOwnerAccountResultValidator>> => {
    const unavailable = { status: "unavailable" as const }

    // The grants cannot be guessed; this one global limit bounds code guessing.
    // A wrong code always spends it. The right code skips it only when the
    // configured code is the generated 64-hex kind, so flooding wrong codes
    // can never lock the real owner out of /setup.
    const claimHash = await submittedClaimMatchesConfigured(args.code)
    if (!claimHash || !configuredOwnerClaimIsGenerated()) {
      const claimGlobal = await rateLimiter.limit(ctx, "ownerClaimGlobal")
      if (!claimGlobal.ok) return unavailable
    }
    if (
      !claimHash ||
      (await resolveOwnerClaimTransition(ctx)).kind !== "fresh"
    ) {
      return unavailable
    }

    const name = args.name.trim()
    if (name.length === 0 || name.length > OWNER_NAME_MAX_LENGTH) {
      return { status: "invalid_input" as const, error: "NAME_INVALID" }
    }

    let notificationEmail: string | undefined
    if (args.notificationEmail !== undefined && args.notificationEmail.trim()) {
      const parsed = parseNotificationEmail(args.notificationEmail)
      if (!parsed) {
        return { status: "invalid_input" as const, error: "EMAIL_INVALID" }
      }
      notificationEmail = parsed
    }

    const grantId = await ctx.db.insert("signupGrants", {
      kind: "owner",
      claimHash,
      name,
      ...(notificationEmail !== undefined ? { notificationEmail } : {}),
    })
    let result: SignUpResult
    try {
      result = await ctx.runMutation(api.auth.signUpWithUsernamePassword, {
        username: args.username,
        password: args.password,
      })
    } catch (error) {
      // The nested sign-up rolled back; drop the grant and commit nothing else.
      // Log the cause: the person only sees "unavailable".
      console.error("createOwnerAccount: sign-up threw", error)
      await ctx.db.delete("signupGrants", grantId)
      return unavailable
    }
    if (result.status !== "complete") {
      await ctx.db.delete("signupGrants", grantId)
      return {
        status: "invalid_input" as const,
        error: result.userError.error,
      }
    }
    // `createUser` consumed the grant. Fail loudly if it did not, so nothing
    // commits with a dangling grant.
    if ((await ctx.db.get("signupGrants", grantId)) !== null) {
      throw new ConvexError("CMS_OWNER_GRANT_NOT_CONSUMED")
    }
    await ctx.runMutation(api.auth.signOut, {
      refreshToken: result.tokens.refreshToken,
    })
    // A fresh site has no content, so this finishes within seconds. Without it
    // the first permanent image delete in Trash is refused until the hourly
    // cron starts the backfill. Supported limit: the backfill finishes in
    // scheduled work after this claim commits, so a delete made before that
    // work runs is still refused safely (nothing is deleted; a retry after
    // the backfill completes works).
    // Starting it must never fail the owner claim:
    // the component call runs as its own sub-transaction, so a throw rolls back
    // only the start; the cron and the purge fallback start it later.
    try {
      await startRichTextImageBackfill(ctx)
    } catch (error) {
      console.error("createOwnerAccount: image backfill start failed", error)
    }
    return { status: "created" as const }
  },
})

export const getOwnerSession = query({
  args: {},
  returns: ownerSessionValidator,
  handler: async (ctx) => {
    const identity = await getOwnerIdentity(ctx)
    if (!identity) return null

    try {
      const principal = await resolveOwnerPrincipal(ctx)
      if (!principal) return null
      return {
        ownerId: principal.ownerId,
        authId: principal.authId,
        email: principal.email,
        displayName: await ownerDisplayName(ctx, principal.authId),
        username: await ownerUsername(ctx, principal.authId),
        role: principal.role,
      }
    } catch (error) {
      if (isSanitizedOwnerState(error)) {
        throw new ConvexError("CMS_OWNER_UNAVAILABLE")
      }
      throw error
    }
  },
})

export const assertOperationAccessInternal = internalQuery({
  args: {},
  returns: ownerPrincipalValidator,
  handler: async (ctx) => requireOperationAccess(ctx),
})

export const assertInstallationOwnerInternal = internalQuery({
  args: {},
  returns: ownerPrincipalValidator,
  handler: async (ctx) => requireInstallationOwner(ctx),
})

const setNotificationEmailResultValidator = v.union(
  v.object({ status: v.literal("saved") }),
  v.object({ status: v.literal("invalid_email") })
)

/** The owner's notification email, or null. Owner only. */
export const getNotificationEmail = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    return await getOwnerNotificationEmail(ctx)
  },
})

/**
 * Saves the owner's notification email (ADR-0056 rule 5), or clears it with
 * null. The address receives the email delivery test and, when the Forms
 * module is installed, contact form messages.
 */
export const setNotificationEmail = mutation({
  args: { email: v.union(v.string(), v.null()) },
  returns: setNotificationEmailResultValidator,
  handler: async (ctx, { email }) => {
    const principal = await requireInstallationOwner(ctx)
    let value: string | undefined
    if (email !== null && email.trim()) {
      const parsed = parseNotificationEmail(email)
      if (!parsed) return { status: "invalid_email" as const }
      value = parsed
    }
    await ctx.db.patch("cmsOwner", principal.ownerId, {
      notificationEmail: value,
      updatedAt: Date.now(),
    })
    return { status: "saved" as const }
  },
})
