import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { requireOwnerPrincipal, type OwnerPrincipal } from "./owner"

type OwnerAccessContext = QueryCtx | MutationCtx

/** Community's ordinary protected-operation seam. */
export async function requireOperationAccess(
  ctx: OwnerAccessContext
): Promise<OwnerPrincipal> {
  return requireOwnerPrincipal(ctx)
}

/**
 * Installation-owner-only seam. It intentionally remains separate from
 * ordinary operation access so a future Team role cannot acquire ownership.
 */
export async function requireInstallationOwner(
  ctx: OwnerAccessContext
): Promise<OwnerPrincipal> {
  return requireOwnerPrincipal(ctx)
}
