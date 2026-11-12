// Per-user rate limits on every public AI action. Implemented via
// @convex-dev/rate-limiter (ADR-006 + V0.1 launch plan Step 6): hand-rolled
// throttling is not on the table — leaked Convex URL + retry-loop would burn
// the operator's BYOK OpenRouter key, and the component is the idiomatic fix.
//
// Limits are intentionally hard-coded for v0.1; surfacing them in Settings → AI
// is tracked on the AI-surface review checkbox of V0.1-LAUNCH-PLAN.md Step 6.
import { ConvexError } from "convex/values"
import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter"
import { components } from "../_generated/api"
import type { ActionCtx, MutationCtx } from "../_generated/server"

export const aiRateLimiter = new RateLimiter(components.rateLimiter, {
  // Per-user token bucket on every public AI action. ~1 call/sec with a small
  // burst absorbs editor-side bursts (one field at a time, occasional whole-
  // page Translate) while a runaway loop or stolen URL hits the wall fast.
  aiCallPerUser: {
    kind: "token bucket",
    rate: 60,
    period: MINUTE,
    capacity: 10,
  },
  // Per-deployment ceiling. A compromised key is bounded by this regardless of
  // how many users it impersonates. Tune in Settings → AI later if needed.
  aiCallPerDeployment: {
    kind: "token bucket",
    rate: 600,
    period: MINUTE,
    capacity: 60,
  },
  // Whole-page operations (localizePage, generatePageOutline, page meta) fan
  // out into many model calls — track them separately and at a lower rate.
  aiPageOpPerUser: { kind: "fixed window", rate: 20, period: HOUR },
  // Local generation audits are best-effort metadata writes after an already
  // charged preflight. Bound the public ingress independently so a permitted
  // direct client cannot flood the 90-day audit table.
  aiAuditPerUser: {
    kind: "token bucket",
    rate: 60,
    period: MINUTE,
    capacity: 20,
  },
  aiAuditPerDeployment: {
    kind: "token bucket",
    rate: 600,
    period: MINUTE,
    capacity: 200,
  },
})

/** Apply per-user + per-deployment AI limits. Call from action handlers
 *  immediately after the permission/config gate. Throws ConvexError on limit
 *  exceeded so the client sees a clear "try again later" surface. */
export async function enforceAiRateLimit(
  ctx: ActionCtx | MutationCtx,
  opts: { pageOp?: boolean } = {}
): Promise<void> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new ConvexError("Unauthenticated")
  // Buckets key on `tokenIdentifier` — the cross-issuer stable identifier
  // authHelpers treats as canonical (`subject` is only issuer-scoped).
  const key = identity.tokenIdentifier
  await aiRateLimiter.limit(ctx, "aiCallPerUser", { key, throws: true })
  await aiRateLimiter.limit(ctx, "aiCallPerDeployment", { throws: true })
  if (opts.pageOp) {
    await aiRateLimiter.limit(ctx, "aiPageOpPerUser", { key, throws: true })
  }
}

export async function enforceAiAuditRateLimit(
  ctx: MutationCtx,
  userKey: string
): Promise<void> {
  await aiRateLimiter.limit(ctx, "aiAuditPerUser", {
    key: userKey,
    throws: true,
  })
  await aiRateLimiter.limit(ctx, "aiAuditPerDeployment", { throws: true })
}
