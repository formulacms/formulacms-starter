import { ConvexError, v } from "convex/values"
import { components, internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import {
  env,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server"
import type { MutationCtx } from "../_generated/server"
import {
  getOwnerIdentity,
  insertOwnerForClaim,
  ownerPresenceValidator,
  ownerPrincipalValidator,
  ownerSessionValidator,
  readOwnerState,
  replaceOwnerBinding,
  resolveOwnerPrincipal,
} from "../lib/access/owner"
import type { OwnerIdentity } from "../lib/access/owner"
import {
  requireInstallationOwner,
  requireOperationAccess,
} from "../lib/access/policy"
import {
  equalOwnerClaimHashes,
  hashOwnerClaim,
  resolveOwnerClaimTransition,
} from "../lib/ownerClaim"
import { rateLimiter } from "../lib/rateLimits"
import { resolveOwnerClaim } from "../lib/environment"

const ownerClaimResultValidator = v.object({
  status: v.union(v.literal("claimed"), v.literal("unavailable")),
})

const SESSION_CLEANUP_BATCH_SIZE = 100

function configuredOwnerClaimHash(): Promise<string | null> {
  const claim = resolveOwnerClaim(env)
  return claim?.trim() ? hashOwnerClaim(claim) : Promise.resolve(null)
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

/**
 * Commits the binding, replay-ledger update, and first cleanup schedule as one
 * transaction. The injectable scheduler is only for rollback proof.
 */
export async function commitOwnerReplacement(
  ctx: MutationCtx,
  owner: Doc<"cmsOwner">,
  ledger: Doc<"ownerClaimLedger">,
  successor: OwnerIdentity,
  claimHash: string,
  scheduleCleanup: (authId: string) => Promise<unknown> = (authId) =>
    ctx.scheduler.runAfter(0, internal.cms.owner.cleanupOutgoingOwnerSessions, {
      authId,
    })
) {
  const outgoingAuthId = owner.authId
  await replaceOwnerBinding(ctx, owner, successor)
  await ctx.db.patch(ledger._id, {
    secretHash: claimHash,
    claimedBy: successor.authId,
    claimedAt: Date.now(),
    recovery: true,
  })
  await scheduleCleanup(outgoingAuthId)
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
    return {
      available:
        claimHash !== null &&
        (await resolveOwnerClaimTransition(ctx, claimHash)).kind !==
          "unavailable",
    }
  },
})

/** Used by Better Auth before it creates a user. It has no authority effect. */
export const canAdmitOwnerSignup = internalQuery({
  args: { claimHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const configuredHash = await configuredOwnerClaimHash()
    return (
      configuredHash !== null &&
      equalOwnerClaimHashes(configuredHash, args.claimHash) &&
      (await resolveOwnerClaimTransition(ctx, configuredHash)).kind !==
        "unavailable"
    )
  },
})

/**
 * Atomically establishes the durable owner. The identity is always read from
 * Convex auth; no client-supplied account, role, or membership participates.
 */
export const claimOwner = mutation({
  args: { claim: v.string() },
  returns: ownerClaimResultValidator,
  handler: async (ctx, args) => {
    const identity = await getOwnerIdentity(ctx)
    if (!identity) throw new ConvexError("UNAUTHENTICATED")

    const [perIdentity, global] = await Promise.all([
      rateLimiter.limit(ctx, "ownerClaimPerIdentity", {
        key: identity.tokenIdentifier,
      }),
      rateLimiter.limit(ctx, "ownerClaimGlobal"),
    ])
    if (!perIdentity.ok || !global.ok) {
      return { status: "unavailable" as const }
    }

    const claimHash = await submittedClaimMatchesConfigured(args.claim)
    if (
      !claimHash ||
      (await resolveOwnerClaimTransition(ctx, claimHash)).kind !== "fresh"
    ) {
      return { status: "unavailable" as const }
    }

    await insertOwnerForClaim(ctx, identity)
    await ctx.db.insert("ownerClaimLedger", {
      key: "owner",
      secretHash: claimHash,
      claimedBy: identity.authId,
      claimedAt: Date.now(),
      recovery: false,
    })
    return { status: "claimed" as const }
  },
})

/**
 * Rebinds the existing durable owner to a different signed-in account after a
 * rotated claim. The binding cutover and cleanup scheduling are one mutation;
 * session deletion itself remains bounded and retryable.
 */
export const replaceOwner = mutation({
  args: { claim: v.string() },
  returns: ownerClaimResultValidator,
  handler: async (ctx, args) => {
    const successor = await getOwnerIdentity(ctx)
    if (!successor) throw new ConvexError("UNAUTHENTICATED")

    const [perIdentity, global] = await Promise.all([
      rateLimiter.limit(ctx, "ownerClaimPerIdentity", {
        key: successor.tokenIdentifier,
      }),
      rateLimiter.limit(ctx, "ownerClaimGlobal"),
    ])
    if (!perIdentity.ok || !global.ok) {
      return { status: "unavailable" as const }
    }

    const claimHash = await submittedClaimMatchesConfigured(args.claim)
    if (!claimHash) return { status: "unavailable" as const }
    const transition = await resolveOwnerClaimTransition(ctx, claimHash)
    if (
      transition.kind !== "replacement" ||
      successor.authId === transition.owner.authId
    ) {
      return { status: "unavailable" as const }
    }

    await commitOwnerReplacement(
      ctx,
      transition.owner,
      transition.ledger,
      successor,
      claimHash
    )
    return { status: "claimed" as const }
  },
})

/** Deletes one fixed session page without starting a continuation itself. */
export const deleteOwnerSessionBatch = internalMutation({
  args: { authId: v.string() },
  returns: v.object({ deleted: v.number(), complete: v.boolean() }),
  handler: async (ctx, args) => {
    const result = await ctx.runMutation(
      components.betterAuth.adapter.deleteMany,
      {
        input: {
          model: "session",
          where: [{ field: "userId", operator: "eq", value: args.authId }],
        },
        paginationOpts: { numItems: SESSION_CLEANUP_BATCH_SIZE, cursor: null },
      }
    )
    const complete = result.isDone || result.count === 0
    return { deleted: result.count, complete }
  },
})

/** Deletes one fixed outgoing-session page and schedules the next if needed. */
export const cleanupOutgoingOwnerSessions = internalMutation({
  args: { authId: v.string() },
  returns: v.object({ deleted: v.number(), complete: v.boolean() }),
  handler: async (ctx, args) => {
    const result: { deleted: number; complete: boolean } =
      await ctx.runMutation(internal.cms.owner.deleteOwnerSessionBatch, args)
    if (!result.complete) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.owner.cleanupOutgoingOwnerSessions,
        args
      )
    }
    return result
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
