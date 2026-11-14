import { setupConvexAuthNextjs } from "@convex-dev/auth/ssr/nextjs"
import { api } from "@/convex/_generated/api"
import { getNextAuthEnv } from "@/lib/env"

// The Next-specific server helpers (Convex Auth Next.js example,
// src/lib/convexAuth.tsx): proxy (up-front refresh), the server token
// accessor, and the provider that hydrates the client. The provider reads
// cookies, so only request-time layouts may render it, never the public
// `(public)/[locale]` tree, which stays static.
export const {
  convexAuthNextjsProxy,
  convexAuthNextjsAccessToken,
  isAuthenticatedNextjs,
  ConvexAuthNextjsServerProvider,
} = setupConvexAuthNextjs({
  convexUrl: getNextAuthEnv().convexUrl,
  refreshSession: api.auth.refreshSession,
  isAuthenticated: api.auth.isAuthenticated,
})
