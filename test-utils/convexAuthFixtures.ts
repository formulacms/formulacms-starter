import { convexTest as baseConvexTest, type TestConvex } from "convex-test"
import type { GenericSchema, SchemaDefinition } from "convex/server"
import type { UserIdentity } from "convex/server"
import { registerCore, sessionIdentity } from "@convex-dev/auth/test"
import { registerPassword } from "@convex-dev/auth/components/password/test"
import { registerUsername } from "@convex-dev/auth/components/username/test"
import { components } from "../convex/_generated/api"

/**
 * Convex Auth test fixtures (ADR-0056).
 *
 * Convex Auth puts the SESSION id in the token `subject`, and `getActor`
 * looks the session up in the auth component. A fake `withIdentity({ subject })`
 * therefore reads as signed out, without an error. These helpers register the
 * three auth components and make `t.withIdentity({ subject: "owner" })` run as
 * a REAL session of a user whose ID is that subject string.
 *
 * Fixture sessions are minted with the component's
 * `_internal_dangerous_signIn`. Tests need actors that sign-up must refuse
 * (non-owners; sign-up refuses everyone without a grant), and this is the only
 * way to mint a session for an arbitrary user ID. The call lives in this
 * test-only file. Tests of the real sign-up path (`ownerAccount.test.ts`) use
 * the public sign-up and sign-in functions instead.
 */

type AnyTestConvex = TestConvex<SchemaDefinition<GenericSchema, boolean>>

const FIXTURE_TTL = {
  accessTokenTtlSeconds: 60,
  refreshInactivityTimeoutSeconds: 7 * 24 * 60 * 60,
  sessionMaxLifetimeSeconds: 30 * 24 * 60 * 60,
}

/** Registers the Convex Auth core, password and username components. */
export function registerAuthComponents(t: AnyTestConvex): void {
  registerCore(t)
  registerPassword(t)
  registerUsername(t)
}

/**
 * Mints a real session for `userId` and returns the identity Convex derives
 * from its access token (`{ subject: <sessionId> }`).
 */
export async function issueFixtureSession(
  t: Pick<AnyTestConvex, "run">,
  userId: string
): Promise<{ subject: string }> {
  const tokens = await t.run(async (ctx) =>
    ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
      claims: { method: "usernamePassword", profile: {} },
      componentPath: "authPassword",
      userId,
      ...FIXTURE_TTL,
    })
  )
  return sessionIdentity(tokens)
}

const sessionRegistry = new WeakMap<
  object,
  (subject: string) => Promise<{ subject: string }>
>()

/**
 * Mints the fixture sessions up front. Signing a token yields to the event
 * loop, so minting lazily inside a measured call lets queued scheduler jobs
 * run mid-call. Suites that snapshot state around calls prepare sessions first.
 */
export async function prepareAuthSessions(
  t: object,
  ...subjects: string[]
): Promise<void> {
  const sessionFor = sessionRegistry.get(t)
  if (!sessionFor) throw new Error("Auth sessions are not enabled on this t")
  await Promise.all(subjects.map((subject) => sessionFor(subject)))
}

type Identityful = { withIdentity: (identity: Partial<UserIdentity>) => unknown }

/**
 * Makes `t.withIdentity(identity)` run as a real session. One fixture session
 * is minted lazily per distinct `subject` and reused, so two calls by the same
 * subject share a user ID, as two requests of one signed-in person do.
 *
 * `beforeCall` runs before each call of an identity-bound client, for fixtures
 * that must exist first (for example the durable owner row).
 */
export function enableAuthSessions<T extends AnyTestConvex>(
  t: T,
  options: {
    beforeCall?: (identity: Partial<UserIdentity>) => Promise<void>
  } = {}
): T {
  registerAuthComponents(t)
  const baseWithIdentity = t.withIdentity.bind(t)
  const rawRun = t.run.bind(t)
  const sessions = new Map<string, Promise<{ subject: string }>>()
  const sessionFor = (subject: string) => {
    let session = sessions.get(subject)
    if (!session) {
      session = issueFixtureSession({ run: rawRun }, subject)
      sessions.set(subject, session)
    }
    return session
  }

  sessionRegistry.set(t, sessionFor)
  ;(t as Identityful).withIdentity = (identity: Partial<UserIdentity>) => {
    const subject = identity.subject
    if (!subject) {
      throw new Error("Test identities must declare a stable subject.")
    }
    const passthrough = baseWithIdentity({ subject: "not-yet-issued" })
    return new Proxy(passthrough, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (
          (property === "query" ||
            property === "mutation" ||
            property === "action" ||
            property === "run") &&
          typeof value === "function"
        ) {
          return async (...args: unknown[]) => {
            // `run` is raw database access, not a caller-visible entry point.
            if (property !== "run") await options.beforeCall?.(identity)
            const authenticated = baseWithIdentity(await sessionFor(subject))
            const method = Reflect.get(authenticated, property) as (
              ...a: unknown[]
            ) => unknown
            return Reflect.apply(method, authenticated, args)
          }
        }
        return value
      },
    })
  }
  return t
}

/**
 * Drop-in replacement for `convexTest` from "convex-test" in suites that call
 * `t.withIdentity(...)`: the auth components are registered and every identity
 * runs as a real session (see `enableAuthSessions`).
 */
export const convexTestWithAuth: typeof baseConvexTest = ((
  ...args: Parameters<typeof baseConvexTest>
) =>
  enableAuthSessions(
    baseConvexTest(...args) as unknown as AnyTestConvex
  )) as typeof baseConvexTest
