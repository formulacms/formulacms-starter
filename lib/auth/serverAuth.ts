import { setupConvexAuthServer } from "@convex-dev/auth/ssr"
import { api } from "@/convex/_generated/api"
import { getNextAuthEnv } from "@/lib/env"

// The framework-agnostic auth handlers, configured once (Convex Auth Next.js
// example, src/lib/serverAuth.ts). The `secure` cookie flag is decided here
// (HTTPS-only in production) and applies to every handler, including sign-in.
// Route files under app/auth/ mount what this returns.
export const auth = setupConvexAuthServer({
  convexUrl: getNextAuthEnv().convexUrl,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  // The sign-in route refuses every function not listed here. Only the
  // username-and-password sign-in creates a browser session (ADR-0056).
  // Never list `signUpWithUsernamePassword` (sign-up needs a grant and runs
  // inside `cms.owner.createOwnerAccount` or `cms.recovery.claimRecoveryLink`)
  // or `changePassword` (called by `account.changeMyPassword`).
  signIn: [api.auth.signInWithUsernamePassword],
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
})
