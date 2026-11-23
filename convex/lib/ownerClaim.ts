import type { MutationCtx, QueryCtx } from "../_generated/server"

export const OWNER_CLAIM_HEADER = "x-nextcms-owner-claim"

type OwnerClaimCtx = QueryCtx | MutationCtx

export type OwnerClaimTransition = { kind: "fresh" } | { kind: "unavailable" }

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
 * The only fresh-installation eligibility decision. An existing owner or a
 * consumed-claim ledger row makes the installation unavailable. Keep each read
 * bounded so duplicate markers fail closed without a scan. An installation
 * that already has an owner is never fresh: owner recovery is the one-time
 * link of ADR-0056 rule 4, not a rotated code.
 */
export async function resolveOwnerClaimTransition(
  ctx: OwnerClaimCtx
): Promise<OwnerClaimTransition> {
  const owners = await ctx.db
    .query("cmsOwner")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)
  if (owners.length !== 0) return { kind: "unavailable" }

  const ledger = await ctx.db
    .query("ownerClaimLedger")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)
  return ledger.length === 0 ? { kind: "fresh" } : { kind: "unavailable" }
}
