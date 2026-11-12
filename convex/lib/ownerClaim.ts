import type { Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"

export const OWNER_CLAIM_HEADER = "x-nextcms-owner-claim"

type OwnerClaimCtx = QueryCtx | MutationCtx

export type OwnerClaimTransition =
  | { kind: "fresh" }
  | {
      kind: "replacement"
      owner: Doc<"cmsOwner">
      ledger: Doc<"ownerClaimLedger">
    }
  | { kind: "unavailable" }

export async function hashOwnerClaim(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export function equalOwnerClaimHashes(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/**
 * The only fresh-installation eligibility decision. Compatibility tables are
 * deny-only evidence: no row is inspected for an account, role, capacity, or
 * policy value. Keep each read bounded so a damaged legacy installation fails
 * closed without making owner establishment depend on a scan.
 */
export async function resolveOwnerClaimTransition(
  ctx: OwnerClaimCtx,
  claimHash: string
): Promise<OwnerClaimTransition> {
  const owners = await ctx.db
    .query("cmsOwner")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)

  if (owners.length === 0) {
    const [ledger, roles, memberships] = await Promise.all([
      ctx.db
        .query("ownerClaimLedger")
        .withIndex("by_key", (q) => q.eq("key", "owner"))
        .take(2),
      ctx.db.query("roles").take(1),
      ctx.db.query("cmsMemberships").take(1),
    ])
    return ledger.length === 0 && roles.length === 0 && memberships.length === 0
      ? { kind: "fresh" }
      : { kind: "unavailable" }
  }

  if (owners.length !== 1) return { kind: "unavailable" }

  // Replacement deliberately ignores retained role and membership rows. The
  // complete durable binding plus a newly rotated ledger hash are sufficient.
  const ledger = await ctx.db
    .query("ownerClaimLedger")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)
  if (
    ledger.length !== 1 ||
    ledger[0]!.claimedBy !== owners[0]!.authId ||
    ledger[0]!.secretHash === claimHash
  ) {
    return { kind: "unavailable" }
  }
  return { kind: "replacement", owner: owners[0]!, ledger: ledger[0]! }
}
