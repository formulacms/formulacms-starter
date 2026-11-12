import { api } from "@/convex/_generated/api"
import { fetchAuthQuery, requireAuth } from "@/lib/auth-server"

/**
 * Checks ordinary protected-operation access from a Next.js server action.
 * Community currently binds this to the same sanitized owner session as the
 * installation-owner helper, while keeping the seam separate for Team roles.
 */
export async function requireOperationAccess(
  message = "You do not have access to this operation."
): Promise<void> {
  await requireAuth(message)
  const principal = await fetchAuthQuery(api.cms.owner.getOwnerSession, {})
  if (!principal) throw new Error(message)
}
