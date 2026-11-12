import { convexTest as baseConvexTest, type TestConvex } from "convex-test"
import type { UserIdentity } from "convex/server"
import appSchema from "./convex/schema"

type Modules = Record<string, () => Promise<unknown>>
type BaseOptions = Parameters<typeof baseConvexTest>[0]
type TransactionLimits = BaseOptions extends {
  transactionLimits?: infer Limits
}
  ? Limits
  : never
type OwnerIdentity = Pick<UserIdentity, "subject" | "tokenIdentifier">
type Options = {
  schema: typeof appSchema
  modules?: Modules
  transactionLimits?: TransactionLimits
  /**
   * Deterministic Community owner fixture. Only an identity matching BOTH
   * `subject` and `tokenIdentifier` establishes the durable owner row; every
   * other authenticated identity stays unprivileged.
   */
  ownerIdentity?: OwnerIdentity
  /** Opt out only in tests that deliberately exercise missing cutover state. */
  publicationAuthority?: "legacy" | "missing"
}

/**
 * Test harness for suites that historically relied on the removed empty-table
 * admin bootstrap.
 *
 * The wrapper is deliberately **not** an authorization authority. It grants no
 * legacy `roles`, `cmsMemberships`, or `cmsCapacity` rows, so a non-owner test
 * identity remains unprivileged against every still-registered legacy
 * `requirePermission` endpoint and cannot poison the fresh owner-claim
 * eligibility checks in `convex/lib/ownerClaim.ts`.
 *
 * Its only fixture behavior is: when `ownerIdentity` is configured, the first
 * call made by exactly that identity establishes the one durable `cmsOwner`
 * row through the same `seedCommunityOwner` helper suites call directly.
 */
export function convexTest(
  schema: typeof appSchema,
  modules?: Modules
): TestConvex<typeof appSchema>
export function convexTest(options: Options): TestConvex<typeof appSchema>
export function convexTest(
  schemaOrOptions: typeof appSchema | Options,
  modules?: Modules
): TestConvex<typeof appSchema> {
  const t =
    "schema" in schemaOrOptions
      ? baseConvexTest(schemaOrOptions)
      : baseConvexTest(schemaOrOptions, modules)
  const configuredOwner =
    schemaOrOptions === appSchema
      ? undefined
      : (schemaOrOptions as Options).ownerIdentity
  const publicationAuthority =
    schemaOrOptions === appSchema
      ? "legacy"
      : (schemaOrOptions as Options).publicationAuthority ?? "legacy"
  const rawRun = t.run.bind(t)
  const ensurePublicationAuthority = async () => {
    if (publicationAuthority === "missing") return
    await rawRun(async (ctx) => {
      const rows = await ctx.db.query("pagePublicationCutover")
        .withIndex("by_key", (q) => q.eq("key", "published-snapshot-v1")).take(2)
      if (rows.length === 0) {
        await ctx.db.insert("pagePublicationCutover", {
          key: "published-snapshot-v1",
          phase: "legacy",
          revision: 1,
          updatedAt: Date.now(),
        })
      }
    })
  }
  const withIdentity = t.withIdentity.bind(t)

  for (const property of ["query", "mutation", "action", "run"] as const) {
    const value = t[property].bind(t) as (...args: unknown[]) => Promise<unknown>
    ;(t[property] as unknown) = async (...args: unknown[]) => {
      await ensurePublicationAuthority()
      return value(...args)
    }
  }

  t.withIdentity = (identity: Partial<UserIdentity>) => {
    if (!identity.subject) {
      throw new Error(
        "Explicit-admin test identities must declare a stable subject."
      )
    }
    const authenticated = withIdentity(identity)
    if (!configuredOwner) return authenticated

    // convex-test defaults a missing `tokenIdentifier` to `<issuer>|<subject>`.
    // Resolve it the same way so the owner match stays a genuine two-field
    // comparison rather than an accident of the caller omitting the field.
    const tokenIdentifier =
      identity.tokenIdentifier ??
      `${identity.issuer ?? "https://convex.test"}|${identity.subject}`
    const isConfiguredOwner =
      identity.subject === configuredOwner.subject &&
      tokenIdentifier === configuredOwner.tokenIdentifier
    if (!isConfiguredOwner) return authenticated

    const ensureOwner = async () => {
      await ensurePublicationAuthority()
      await seedCommunityOwner(t, configuredOwner)
    }

    return new Proxy(authenticated, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (
          (property === "query" ||
            property === "mutation" ||
            property === "action") &&
          typeof value === "function"
        ) {
          return async (...args: unknown[]) => {
            await ensureOwner()
            return Reflect.apply(value, target, args)
          }
        }
        return value
      },
    })
  }

  return t
}

/** Seed the one intended Community owner explicitly in a test fixture. */
export async function seedCommunityOwner(
  t: TestConvex<typeof appSchema>,
  identity: OwnerIdentity
): Promise<void> {
  const authId = identity.subject
  const tokenIdentifier = identity.tokenIdentifier
  if (!authId || !tokenIdentifier) {
    throw new Error(
      "Community owner fixtures require authId and tokenIdentifier"
    )
  }
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("cmsOwner")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .take(2)
    if (existing.length > 0) {
      if (
        existing.length !== 1 ||
        existing[0]!.authId !== authId ||
        existing[0]!.tokenIdentifier !== tokenIdentifier
      ) {
        throw new Error(
          "Community owner fixture already has a different binding"
        )
      }
      return
    }
    const now = Date.now()
    await ctx.db.insert("cmsOwner", {
      key: "owner",
      authId,
      tokenIdentifier,
      establishedAt: now,
      updatedAt: now,
    })
  })
}
