// Public forgot-password entrypoint (Phase 9).
//
// Wraps Better Auth's `requestPasswordReset` server endpoint with the abuse
// surface ADR-0026 §3 requires:
//
//  * Verify the short-lived IP proof minted by the public Next route before
//    spending any limiter state or invoking Better Auth. Direct callers cannot
//    choose limiter keys or trigger email.
//  * Rate-limit BEFORE any DB read or Better Auth call. A hit returns
//    `{ ok: true }` silently; the caller can't tell the difference between
//    "throttled", "no such user", and "sent".
//  * No enumeration: every code path returns `{ ok: true }`. Better Auth
//    itself already returns 200 for unknown emails; we additionally swallow
//    any internal error so a transient backend failure doesn't leak the
//    existence of an account through a 500/timing channel.
//  * The actual email send happens inside the Better Auth `sendResetPassword`
//    callback (see `convex/auth.ts`), which queues the private FormulaCMS
//    boundary. Action Retrier then owns the bounded delivery attempts outside
//    the request critical path.
//
// Defaults verified against Better Auth v1.6.x:
//   https://github.com/better-auth/better-auth/blob/main/docs/content/docs/authentication/email-password.mdx
//   https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/api/routes/password.ts

import { v } from "convex/values"
import { action } from "../_generated/server"
import { authComponent, createAuth } from "../auth"
import { hashAuthClientIdentity, verifyAuthIpProof } from "../lib/authIpProof"
import { rateLimiter } from "../lib/rateLimits"

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

// Loose RFC 5321 sanity check — Better Auth validates more strictly, but we
// short-circuit obvious garbage so it doesn't consume rate-limit budget.
function isLikelyEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export const requestPasswordReset = action({
  args: {
    email: v.string(),
    /** Signed proof fields minted by the public Next route. All remain optional
     *  so untrusted direct calls receive the same neutral response shape. */
    ipHash: v.optional(v.string()),
    ipHashExpiresAt: v.optional(v.number()),
    ipHashSignature: v.optional(v.string()),
    /** Path the user is sent to after clicking the reset link, e.g.
     *  "/reset-password". Better Auth appends `?token=…` (or
     *  `?error=INVALID_TOKEN`). Unsafe values fall back to the default. */
    redirectTo: v.optional(v.string()),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const email = normalizeEmail(args.email)
    const redirectTo = normalizeResetRedirect(args.redirectTo)

    // Cheap input gate — never throws, just deflects so a malformed input
    // doesn't burn a rate-limit slot.
    if (!email || !isLikelyEmail(email)) {
      return { ok: true }
    }

    // Fail closed before touching any limiter key derived from caller input.
    const verifiedIpHash = await verifyAuthIpProof({
      ipHash: args.ipHash,
      expiresAt: args.ipHashExpiresAt,
      signature: args.ipHashSignature,
    })
    if (!verifiedIpHash) {
      return { ok: true }
    }

    // Hard deployment-wide ceiling: no direct caller can drive more than 100
    // Better Auth attempts (and therefore email delivery attempts) per hour.
    const global = await rateLimiter.limit(ctx, "forgotPasswordGlobal")
    if (!global.ok) {
      return { ok: true }
    }

    // Per-IP cap: catches a single client sweeping many addresses.
    const perIp = await rateLimiter.limit(ctx, "forgotPasswordPerIp", {
      key: verifiedIpHash,
    })
    if (!perIp.ok) {
      return { ok: true }
    }

    // Per-email cap: catches repeated targeting of one inbox. Store only a
    // one-way hash in the limiter component so its key does not contain PII.
    const perEmail = await rateLimiter.limit(ctx, "forgotPasswordPerEmail", {
      key: await hashAuthClientIdentity(email),
    })
    if (!perEmail.ok) {
      return { ok: true }
    }

    // Better Auth's `/request-password-reset` invokes our `sendResetPassword`
    // callback (configured in `convex/auth.ts`) which schedules the actual
    // delivery. Returns 200 regardless of whether the email exists.
    try {
      const { auth } = await authComponent.getAuth(createAuth, ctx)
      await auth.api.requestPasswordReset({
        body: { email, redirectTo },
      })
    } catch (err) {
      // Swallow: surfacing an error here would let a caller distinguish
      // "Better Auth threw" from "email sent" — exactly the enumeration leak
      // we're trying to avoid. Log for operators.
      console.error("[passwordRecovery] requestPasswordReset failed:", err)
    }

    return { ok: true }
  },
})

const DEFAULT_RESET_REDIRECT = "/reset-password"

export function normalizeResetRedirect(raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) return DEFAULT_RESET_REDIRECT
  if (!value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_RESET_REDIRECT
  }
  if (value.includes("\\")) {
    return DEFAULT_RESET_REDIRECT
  }

  try {
    const base = "https://nextcms.local"
    const parsed = new URL(value, base)
    if (parsed.origin !== base) return DEFAULT_RESET_REDIRECT
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return DEFAULT_RESET_REDIRECT
  }
}
