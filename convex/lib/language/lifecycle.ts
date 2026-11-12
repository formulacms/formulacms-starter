import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import { env, type MutationCtx, type QueryCtx } from "../../_generated/server"
import { SITE_LANGUAGE_AUTHORITY_KEY } from "./state"

export type LifecycleIntent = Doc<"siteLanguageLifecycleIntents">
export type LifecycleOperationKind = LifecycleIntent["operationKind"]

/**
 * The revalidation origin the drain would post to, or null when revalidation
 * is not configured (no shared secret, or neither `siteUrl` nor `SITE_URL`).
 * Shared by lifecycle preflight and the revalidation drain.
 */
export function configuredRevalidationOrigin(
  siteUrl: string | undefined
): string | null {
  if (!env.REVALIDATE_SECRET) return null
  return configuredSiteAddress(siteUrl)
}

/**
 * The public site address, whether or not the shared secret exists: the saved
 * address, else `SITE_URL`. Null when both are empty. The health
 * classification needs it apart from the secret to tell "no address" from
 * "address but integration incomplete".
 */
export function configuredSiteAddress(
  siteUrl: string | undefined
): string | null {
  const origin = (siteUrl || env.SITE_URL || "").replace(/\/$/, "")
  return origin || null
}

/**
 * The one place the lifecycle drain, the automatic re-arm and the owner
 * requeue read the current origin: the singleton settings row's site address
 * (or `SITE_URL`) with the shared secret. Null when nothing is configured.
 */
export async function readConfiguredLifecycleOrigin(
  ctx: QueryCtx | MutationCtx
): Promise<string | null> {
  const settings = await ctx.db.query("siteSettings").take(2)
  return configuredRevalidationOrigin(
    settings.length === 1 ? settings[0]!.siteUrl : undefined
  )
}

/**
 * M17: insert exactly one lifecycle intent in the committing transaction. The
 * operation id is deterministic per committed version, so a duplicate is
 * corrupt state and refuses the commit.
 */
export async function insertLanguageLifecycleIntent(
  ctx: MutationCtx,
  intent: {
    operationId: string
    operationKind: LifecycleOperationKind
    locales: readonly string[]
    /** `default_migration` only: the committed generation (P19c). */
    migrationId?: Id<"siteDefaultLanguageMigrations">
    generation?: number
    capturedAuthorityVersion: number
  }
): Promise<void> {
  const existing = await ctx.db
    .query("siteLanguageLifecycleIntents")
    .withIndex("by_operationId", (q) => q.eq("operationId", intent.operationId))
    .take(1)
  if (existing.length > 0) {
    throw new ConvexError("LANGUAGE_LIFECYCLE_INTENT_DUPLICATE")
  }
  const now = Date.now()
  await ctx.db.insert("siteLanguageLifecycleIntents", {
    operationId: intent.operationId,
    operationKind: intent.operationKind,
    locales: [...intent.locales],
    ...(intent.migrationId === undefined
      ? {}
      : { migrationId: intent.migrationId }),
    ...(intent.generation === undefined
      ? {}
      : { generation: intent.generation }),
    capturedAuthorityVersion: intent.capturedAuthorityVersion,
    phase: "tags_and_layout",
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * The generic public-module hook: one `module_toggle` intent for a committed
 * module configuration version. It reads the raw singletons rather than the
 * classifier, so a Redirects toggle is never refused by language state.
 */
export async function insertModuleToggleIntent(
  ctx: MutationCtx,
  configurationVersion: number
): Promise<void> {
  const [settingsRows, authorityRows] = await Promise.all([
    ctx.db.query("siteSettings").take(2),
    ctx.db
      .query("siteLanguageAuthority")
      .withIndex("by_key", (q) => q.eq("key", SITE_LANGUAGE_AUTHORITY_KEY))
      .take(2),
  ])
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `module_toggle:c${configurationVersion}`,
    operationKind: "module_toggle",
    locales: settingsRows.length === 1 ? settingsRows[0]!.enabledLocales : [],
    capturedAuthorityVersion:
      authorityRows.length === 1 ? authorityRows[0]!.version : 0,
  })
}

/**
 * M05 A2: whether a revalidation origin is a local address that a hosted
 * backend usually cannot reach. A local origin is `localhost`, a loopback,
 * a private (RFC 1918 / IPv6 unique-local) or link-local address, or a
 * `.local` host. Pure: no environment or network access.
 */
export function isLocalOrigin(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  // `URL` keeps the brackets around an IPv6 literal.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isLocalIpv6(hostname.slice(1, -1))
  }
  hostname = hostname.replace(/\.$/, "")
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true
  }
  const octets = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!octets) return false
  const [a, b] = [Number(octets[1]), Number(octets[2])]
  return (
    a === 127 || // loopback
    a === 10 || // RFC 1918
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 169 && b === 254) || // link-local
    a === 0 // "this host" (0.0.0.0)
  )
}

function isLocalIpv6(address: string): boolean {
  const first = address.split(":")[0] ?? ""
  if (address === "::1" || address === "::") return true
  // fe80::/10 link-local, fc00::/7 unique-local.
  const hextet = Number.parseInt(first || "0", 16)
  if (Number.isNaN(hextet)) return false
  return (hextet & 0xffc0) === 0xfe80 || (hextet & 0xfe00) === 0xfc00
}
