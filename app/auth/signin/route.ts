import { auth } from "@/lib/auth/serverAuth"

// The sign-in route. It serves every sign-in function listed in
// lib/auth/serverAuth.ts, forwarding each call to the deployment, and moves the
// minted refresh token into an httpOnly cookie on the way back.
export const POST = auth.convexProxyHandler
