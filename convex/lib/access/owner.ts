import { ConvexError, v } from "convex/values"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"

type OwnerContext = QueryCtx | MutationCtx

export type OwnerIdentity = {
  authId: string
  tokenIdentifier: string
  email: string | null
}

export type OwnerPrincipal = OwnerIdentity & {
  ownerId: Id<"cmsOwner">
  role: "admin"
}

export type OwnerState =
  | { status: "missing" }
  | { status: "ready"; owner: Doc<"cmsOwner"> }
  | { status: "invalid" }

export const ownerPresenceValidator = v.object({
  established: v.boolean(),
})

export const ownerPrincipalValidator = v.object({
  ownerId: v.id("cmsOwner"),
  authId: v.string(),
  tokenIdentifier: v.string(),
  email: v.union(v.string(), v.null()),
  role: v.literal("admin"),
})

export const ownerSessionValidator = v.union(
  v.object({
    ownerId: v.id("cmsOwner"),
    authId: v.string(),
    email: v.union(v.string(), v.null()),
    role: v.literal("admin"),
  }),
  v.null()
)

export async function readOwnerState(ctx: OwnerContext): Promise<OwnerState> {
  const rows = await ctx.db
    .query("cmsOwner")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)

  if (rows.length === 0) return { status: "missing" }
  if (rows.length === 1) return { status: "ready", owner: rows[0]! }
  return { status: "invalid" }
}

export async function getOwnerIdentity(
  ctx: OwnerContext
): Promise<OwnerIdentity | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return null
  return {
    authId: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? null,
  }
}

function principalFrom(
  owner: Doc<"cmsOwner">,
  identity: OwnerIdentity
): OwnerPrincipal {
  return {
    ownerId: owner._id,
    authId: owner.authId,
    tokenIdentifier: owner.tokenIdentifier,
    email: identity.email,
    role: "admin",
  }
}

function assertCompleteBinding(
  owner: Doc<"cmsOwner">,
  identity: OwnerIdentity
): OwnerPrincipal | null {
  const authIdMatches = owner.authId === identity.authId
  const tokenIdentifierMatches =
    owner.tokenIdentifier === identity.tokenIdentifier

  if (authIdMatches && tokenIdentifierMatches) {
    return principalFrom(owner, identity)
  }
  if (authIdMatches || tokenIdentifierMatches) {
    throw new ConvexError("CMS_OWNER_BINDING_INVALID")
  }
  return null
}

/**
 * Returns a principal for the exact current owner. Unauthenticated and
 * unrelated identities resolve to null; malformed owner state is never
 * normalized into an unrelated caller.
 */
export async function resolveOwnerPrincipal(
  ctx: OwnerContext
): Promise<OwnerPrincipal | null> {
  const identity = await getOwnerIdentity(ctx)
  if (!identity) return null

  const state = await readOwnerState(ctx)
  if (state.status === "missing") return null
  if (state.status === "invalid") {
    throw new ConvexError("CMS_OWNER_STATE_INVALID")
  }
  return assertCompleteBinding(state.owner, identity)
}

export async function requireOwnerPrincipal(
  ctx: OwnerContext
): Promise<OwnerPrincipal> {
  const identity = await getOwnerIdentity(ctx)
  if (!identity) throw new ConvexError("UNAUTHENTICATED")

  const state = await readOwnerState(ctx)
  if (state.status === "missing") {
    throw new ConvexError("CMS_OWNER_NOT_ESTABLISHED")
  }
  if (state.status === "invalid") {
    throw new ConvexError("CMS_OWNER_STATE_INVALID")
  }

  const principal = assertCompleteBinding(state.owner, identity)
  if (!principal) throw new ConvexError("CMS_OWNER_REQUIRED")
  return principal
}

/**
 * Transaction helper for F02's claim mutation. The caller must derive the
 * identity from its authenticated context and consume the claim atomically.
 */
export async function insertOwnerForClaim(
  ctx: MutationCtx,
  identity: OwnerIdentity
): Promise<OwnerPrincipal> {
  const state = await readOwnerState(ctx)
  if (state.status === "invalid") {
    throw new ConvexError("CMS_OWNER_STATE_INVALID")
  }
  if (state.status === "ready") {
    throw new ConvexError("CMS_OWNER_ALREADY_ESTABLISHED")
  }

  const now = Date.now()
  const ownerId = await ctx.db.insert("cmsOwner", {
    key: "owner",
    authId: identity.authId,
    tokenIdentifier: identity.tokenIdentifier,
    establishedAt: now,
    updatedAt: now,
  })
  return {
    ownerId,
    ...identity,
    role: "admin",
  }
}

/**
 * Transaction helper for F02's reviewed replacement mutation. It preserves
 * the durable row and only changes the currently bound account pair.
 */
export async function replaceOwnerBinding(
  ctx: MutationCtx,
  currentOwner: Doc<"cmsOwner">,
  successorIdentity: OwnerIdentity
): Promise<OwnerPrincipal> {
  const state = await readOwnerState(ctx)
  if (state.status !== "ready") {
    throw new ConvexError(
      state.status === "missing"
        ? "CMS_OWNER_NOT_ESTABLISHED"
        : "CMS_OWNER_STATE_INVALID"
    )
  }
  if (
    state.owner._id !== currentOwner._id ||
    state.owner.authId !== currentOwner.authId ||
    state.owner.tokenIdentifier !== currentOwner.tokenIdentifier
  ) {
    throw new ConvexError("CMS_OWNER_STATE_STALE")
  }
  if (successorIdentity.authId === currentOwner.authId) {
    throw new ConvexError("CMS_OWNER_REPLACEMENT_INVALID")
  }

  await ctx.db.patch(currentOwner._id, {
    authId: successorIdentity.authId,
    tokenIdentifier: successorIdentity.tokenIdentifier,
    updatedAt: Date.now(),
  })
  return {
    ownerId: currentOwner._id,
    ...successorIdentity,
    role: "admin",
  }
}
