// Convex Auth wiring (ADR-0056). Username and password is the only sign-in
// method. Shape follows the official Next.js example
// (github.com/convex/convex-auth/tree/main/examples/nextjs/convex/auth.ts).
//
// The core owns sessions and tokens. The password method hands back its
// functions only after the app attaches the callbacks in `users.ts`.
// `createUser` there refuses every account that has no claiming grant, so
// the public sign-up mutation exported below cannot create an account on its
// own (ADR-0056 rule 1). People create the first owner through
// `cms.owner.createOwnerAccount`, which holds the grant.
import { components, internal } from "./_generated/api"
import { setupConvexAuth } from "@convex-dev/auth/server"
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server"

const DAY_SECONDS = 24 * 60 * 60

// ADR-0056 rule 3: 60-second access tokens, 30-day sessions, 7 days without use.
const auth = setupConvexAuth({
  component: components.auth,
  accessTokenTtlSeconds: 60,
  sessionMaxLifetimeSeconds: 30 * DAY_SECONDS,
  refreshInactivityTimeoutSeconds: 7 * DAY_SECONDS,
})
export const { signOut, refreshSession, isAuthenticated } = auth

// `changePassword` is exported for `account.changeMyPassword`; the Next.js
// route does not allowlist it.
export const {
  signUpWithUsernamePassword,
  signInWithUsernamePassword,
  changePassword,
} =
  setupUsernamePassword(auth, {
    component: components.authPassword,
    usernameComponent: components.authUsername,
  }).attachUserCallbacks({
    createUser: internal.users.createUser,
    onSignIn: internal.users.onSignIn,
  })
