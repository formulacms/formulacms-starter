"use client"

import { useAuthActions } from "@convex-dev/auth/react"
import { useSignInWithUsernamePassword } from "@convex-dev/auth/methods/username-password/react"
import { api } from "@/convex/_generated/api"

// Client-side auth hooks. Under ConvexAuthNextjsServerProvider the sign-in call
// goes through /auth/signin, which keeps the refresh token in an httpOnly
// cookie (Convex Auth Next.js example, app/signin/page.tsx).

/** Username-and-password sign-in: `{ signIn, pending }`. */
export function useUsernamePasswordSignIn() {
  return useSignInWithUsernamePassword(api.auth)
}

/** `{ signOut }`. After signing out, navigate so the server re-renders. */
export function useSignOut() {
  return useAuthActions().signOut
}
