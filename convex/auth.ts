// Better Auth wiring for the Convex backend.
//
// Phase 9 additions:
//  - `sendResetPassword` queues the reset email through the private FormulaCMS
//    delivery boundary. The callback runs inside whichever Convex ctx triggered
//    Better Auth — for our `requestPasswordReset` flow that's an action ctx,
//    so the internal enqueue mutation is available.
//  - Optional Google OAuth: enabled only when BOTH `GOOGLE_CLIENT_ID` and
//    `GOOGLE_CLIENT_SECRET` are set in the Convex deployment env. Otherwise
//    the provider is omitted entirely and the public `getProvidersAvailable`
//    query reports `{ google: false }` so the UI hides the button rather
//    than rendering a disabled stub.
//
// Reset-token defaults (Better Auth v1.6.x): single-use (the verification
// record is consumed by `consumeVerificationValue` inside `resetPassword`),
// `resetPasswordTokenExpiresIn` defaults to 3600s. Verified against:
//   https://github.com/better-auth/better-auth/blob/main/docs/content/docs/authentication/email-password.mdx
//   https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/api/routes/password.ts

import { betterAuth } from "better-auth"
import { APIError } from "better-auth"
import { createAuthMiddleware, getIP } from "better-auth/api"
import { v } from "convex/values"
import { components, internal } from "./_generated/api"
import { createClient } from "@convex-dev/better-auth"
import { convex } from "@convex-dev/better-auth/plugins"
import {
  requireActionCtx,
  requireRunMutationCtx,
} from "@convex-dev/better-auth/utils"
import type { GenericCtx as GenericCtxBase } from "@convex-dev/better-auth"
import type { DataModel } from "./_generated/dataModel"

type GenericCtx = GenericCtxBase<DataModel>
import { env, internalAction, query } from "./_generated/server"
import authConfig from "./auth.config"
import {
  AUTH_IP_EXPIRES_HEADER,
  AUTH_IP_HASH_HEADER,
  AUTH_IP_SIGNATURE_HEADER,
  AUTH_NEXT_ORIGIN,
  AUTH_ORIGIN_HEADER,
  verifyAuthIpProof,
} from "./lib/authIpProof"
import {
  equalOwnerClaimHashes,
  hashOwnerClaim,
  OWNER_CLAIM_HEADER,
} from "./lib/ownerClaim"
import { rateLimiter } from "./lib/rateLimits"
import { resolveOwnerClaim } from "./lib/environment"

export const authComponent = createClient<DataModel>(components.betterAuth)

/**
 * Operator-only repair for a deployment whose Better Auth JWKS was encrypted
 * with a retired BETTER_AUTH_SECRET. It deliberately returns no key material.
 */
export const rotateAuthKeys = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await createAuth(ctx).api.rotateKeys()
    return null
  },
})

// Better Auth runs inside Convex, so it reads the *Convex deployment* env —
// `.env.local` never reaches this runtime. With no explicit `trustedOrigins`,
// it trusts exactly one origin: the one `BETTER_AUTH_URL` names. But `next dev`
// walks to the next free port whenever 3000 is taken (3001, 3002, …), and a
// lingering dev server is enough to make every local sign-in fail closed with
// 403 INVALID_ORIGIN.
//
// So trust any loopback port — but only when this deployment is itself
// configured for loopback. A deployed `BETTER_AUTH_URL` never opts in, which
// keeps production pinned to its single origin.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"])

export function loopbackDevTrustedOrigins(): string[] {
  const configured = process.env.BETTER_AUTH_URL
  if (!configured) return []

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    return []
  }

  // Plain http on a loopback host is the `next dev` signature. https on
  // localhost means a deliberate TLS setup, so leave that pinned to one origin.
  // Matching is on the parsed hostname, so `localhost.evil.com` cannot opt in.
  if (url.protocol !== "http:") return []
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return []

  return ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

async function ownerClaimHashIfMatches(
  submitted: string | null
): Promise<string | null> {
  const configured = resolveOwnerClaim(env)
  if (!submitted || !configured?.trim()) return null

  const [submittedHash, configuredHash] = await Promise.all([
    hashOwnerClaim(submitted),
    hashOwnerClaim(configured),
  ])
  return equalOwnerClaimHashes(configuredHash, submittedHash)
    ? configuredHash
    : null
}

function googleProviderConfig() {
  const id = process.env.GOOGLE_CLIENT_ID
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!id || !secret) return undefined
  return {
    clientId: id,
    clientSecret: secret,
    // Existing users may still sign in or link Google. New users must enter
    // through the explicit invite/admin paths after the one-time owner claim.
    disableImplicitSignUp: true,
    disableSignUp: true,
  }
}

export const createAuth = (ctx: GenericCtx) => {
  const google = googleProviderConfig()
  return betterAuth({
    database: authComponent.adapter(ctx),
    // Empty on a deployed origin — see `loopbackDevTrustedOrigins`.
    trustedOrigins: loopbackDevTrustedOrigins(),
    emailAndPassword: {
      enabled: true,
      // Defaults are good: single-use token, 1h expiry. Pinned explicitly so a
      // future Better Auth default change doesn't silently widen the window.
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        // `forgetPassword` is invoked from our V8 action
        // (`cms/passwordRecovery.requestPasswordReset`), so this is always an
        // action ctx with a working scheduler. `requireActionCtx` throws a
        // clear error if that ever stops being true — caller swallows the
        // throw and we still return `{ ok: true }` to the public.
        const actionCtx = requireActionCtx(ctx)
        const text =
          `Someone (hopefully you) asked to reset the password for your formulacms account.\n\n` +
          `Open this link to choose a new password:\n${url}\n\n` +
          `This link expires in 60 minutes and can only be used once. ` +
          `If you didn't request a reset, you can safely ignore this email — ` +
          `your password won't change.`
        await actionCtx.runMutation(internal.email.enqueueDelivery, {
          consumer: { kind: "password_recovery" },
          idempotencyKey: `password_recovery:${bytesToHex(await sha256(url))}`,
          message: {
            to: user.email,
            subject: "Reset your formulacms password",
            text,
          },
        })
      },
    },
    hooks: {
      before: createAuthMiddleware(async (requestCtx) => {
        if (requestCtx.path !== "/sign-up/email") return

        const requestHeaders = requestCtx.headers
        let clientKey: string | null = null
        if (requestHeaders?.get(AUTH_ORIGIN_HEADER) === AUTH_NEXT_ORIGIN) {
          const verifiedIpHash = await verifyAuthIpProof({
            ipHash: requestHeaders.get(AUTH_IP_HASH_HEADER) ?? undefined,
            expiresAt: Number(
              requestHeaders.get(AUTH_IP_EXPIRES_HEADER) ?? Number.NaN
            ),
            signature:
              requestHeaders.get(AUTH_IP_SIGNATURE_HEADER) ?? undefined,
          })
          if (verifiedIpHash) {
            clientKey = `next:${verifiedIpHash}`
          }
        } else {
          const request = requestCtx.request ?? requestHeaders
          const clientIp = request
            ? getIP(request, requestCtx.context.options)
            : null
          if (clientIp) {
            clientKey = `convex:${bytesToHex(await sha256(clientIp))}`
          }
        }

        if (!clientKey) {
          throw new APIError("FORBIDDEN", {
            message: "Account creation is not available.",
          })
        }

        const limiterCtx = requireRunMutationCtx(ctx)
        const [clientLimit, globalLimit] = await Promise.all([
          rateLimiter.limit(limiterCtx, "authSignupPerClient", {
            key: clientKey,
          }),
          rateLimiter.limit(limiterCtx, "authSignupGlobal"),
        ])
        if (!clientLimit.ok || !globalLimit.ok) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many account creation attempts. Try again later.",
          })
        }

        const submittedClaim =
          requestCtx.headers?.get(OWNER_CLAIM_HEADER) ?? null
        const claimHash = await ownerClaimHashIfMatches(submittedClaim)
        if (!claimHash) {
          throw new APIError("FORBIDDEN", {
            message: "Account creation is not available.",
          })
        }
        try {
          const admitted = await limiterCtx.runQuery(
            internal.cms.owner.canAdmitOwnerSignup,
            { claimHash }
          )
          if (!admitted) throw new Error("OWNER_SIGNUP_UNAVAILABLE")
        } catch {
          throw new APIError("FORBIDDEN", {
            message: "Account creation is not available.",
          })
        }
      }),
    },
    // Spread to avoid the property even existing when unconfigured — Better
    // Auth would otherwise initialise a Google provider with `undefined`
    // credentials, which throws at first sign-in.
    ...(google ? { socialProviders: { google } } : {}),
    plugins: [
      convex({
        authConfig,
        // A deployment can retain a JWKS record from an older Better Auth
        // algorithm. Regenerate it once when token signing rejects that key;
        // otherwise every valid session is stranded at /convex/token.
        jwksRotateOnTokenGenerationError: true,
      }),
    ],
  })
}

// Exported for use in Convex queries/mutations to get the current user
export const { getAuthUser, safeGetAuthUser } = {
  getAuthUser: (ctx: GenericCtx) => authComponent.getAuthUser(ctx),
  safeGetAuthUser: (ctx: GenericCtx) => authComponent.safeGetAuthUser(ctx),
}

/**
 * Public-safe flags for which optional auth providers are configured on this
 * deployment. The sign-in screen reads this to decide whether to
 * render the "Continue with Google" button at all — unconfigured providers
 * are omitted (no disabled UI, no "coming soon" text).
 */
export const getProvidersAvailable = query({
  args: {},
  returns: v.object({
    google: v.boolean(),
  }),
  handler: async () => {
    return {
      google:
        !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    }
  },
})
