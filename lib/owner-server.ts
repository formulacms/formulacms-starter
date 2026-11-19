import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery, requireAuth } from "@/lib/auth/server"

export type InstallationOwner = NonNullable<
  FunctionReturnType<typeof api.cms.owner.getOwnerSession>
>

/**
 * Checks the durable installation-owner binding from a Next.js server action.
 * The public owner session is intentionally sanitized, but Convex resolves it
 * from both persisted owner identifiers. A role label or Convex Auth session
 * alone cannot authorize a machine-local write. Returns that owner session.
 */
export async function requireInstallationOwner(
  message = "Only the installation owner can continue."
): Promise<InstallationOwner> {
  await requireAuth(message)
  const owner = await fetchAuthQuery(api.cms.owner.getOwnerSession, {})
  if (!owner) throw new Error(message)
  return owner
}
