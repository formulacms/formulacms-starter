import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs"
import { getNextAuthEnv } from "@/lib/env"

const nextAuthEnv = getNextAuthEnv()

export const {
  handler,
  isAuthenticated,
  getToken,
  fetchAuthQuery,
  fetchAuthMutation,
  fetchAuthAction,
} = convexBetterAuthNextJs(nextAuthEnv)

export async function safeIsAuthenticated(): Promise<boolean> {
  try {
    return await isAuthenticated()
  } catch {
    return false
  }
}

export async function requireAuth(
  message = "Sign in to continue."
): Promise<void> {
  if (!(await safeIsAuthenticated())) {
    throw new Error(message)
  }
}
