"use client"

import { ConvexProvider, ConvexReactClient } from "convex/react"

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

/**
 * The anonymous Convex client for the static public site. It never carries a
 * session: the public tree must not read auth cookies, so signed-in state
 * comes from /api/session-label instead. Request-time trees (admin, setup,
 * sign-in, live preview) use ConvexAuthNextjsServerProvider from
 * lib/auth/convexAuth.tsx.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>
}
