import { components } from "../_generated/api"
import type { MutationCtx } from "../_generated/server"

/**
 * End every session of `userId` (ADR-0056 rules 4 and 7).
 *
 * UNDOCUMENTED: the core component functions `components.auth.public.listSessions`
 * and `components.auth.public.revokeSessions` (convex-auth #59, #796 ask for
 * supported versions). This file is the only one that may name them (the editor
 * unit adds `lib/dangerousSetPassword.ts` for the third call, ADR-0056 rule 7). `componentGuard.test.ts` fails if their names or
 * argument shapes change, or if any other non-test file calls them.
 *
 * Returns how many sessions it ended. A user holds a small bounded number of
 * sessions (the core evicts the least recently refreshed ones).
 */
export async function revokeAllSessionsOf(
  ctx: MutationCtx,
  userId: string
): Promise<number> {
  const sessions = await ctx.runQuery(components.auth.public.listSessions, {
    userId,
  })
  if (sessions.length === 0) return 0
  const revoked = await ctx.runMutation(components.auth.public.revokeSessions, {
    sessionIds: sessions.map((session) => session.sessionId),
  })
  return revoked.length
}
