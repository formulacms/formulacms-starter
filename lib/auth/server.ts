import { fetchAction, fetchMutation, fetchQuery } from "convex/nextjs"
import type {
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server"
import {
  convexAuthNextjsAccessToken,
  isAuthenticatedNextjs,
} from "@/lib/auth/convexAuth"

// Server-side Convex calls as the signed-in person. Server Components, route
// handlers and server actions use these; each call reads the access token from
// the Convex Auth cookie (the proxy refreshes it first). Reading cookies makes
// the caller request-time, so public static pages must never import this
// module outside their draft-mode branches.

/** The current access token, or null when signed out or expired. */
export const getToken = convexAuthNextjsAccessToken

/** Whether the request carries a live session, verified by the deployment. */
export const isAuthenticated = isAuthenticatedNextjs

async function tokenOption() {
  return { token: (await getToken()) ?? undefined }
}

export async function fetchAuthQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgs<Query>
): Promise<FunctionReturnType<Query>> {
  return fetchQuery(query, args[0] ?? {}, await tokenOption())
}

export async function fetchAuthMutation<
  Mutation extends FunctionReference<"mutation">,
>(
  mutation: Mutation,
  ...args: OptionalRestArgs<Mutation>
): Promise<FunctionReturnType<Mutation>> {
  return fetchMutation(mutation, args[0] ?? {}, await tokenOption())
}

export async function fetchAuthAction<
  Action extends FunctionReference<"action">,
>(
  action: Action,
  ...args: OptionalRestArgs<Action>
): Promise<FunctionReturnType<Action>> {
  return fetchAction(action, args[0] ?? {}, await tokenOption())
}

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
