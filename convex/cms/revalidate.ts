import { v, type Infer } from "convex/values"
import {
  action,
  env,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server"
import type { ActionCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { api, internal } from "../_generated/api"
import { CMS_TAGS } from "../../lib/cms/tags"
import {
  requireInstallationOwner,
  requireOperationAccess,
} from "../lib/access/policy"
import {
  revalidationStatusValidator,
  revalidationTargetValidator,
} from "../schema"
import { readPublicationAuthority } from "../lib/publishing/snapshots"
import {
  configuredRevalidationOrigin,
  configuredSiteAddress,
  isLocalOrigin,
} from "../lib/language/lifecycle"

const MAX_REVALIDATION_ITEM_COUNT = 10_000
const MAX_ERROR_SNIPPET_LENGTH = 500
const REVALIDATION_HEALTH_LIMIT = 50
/** A failed lifecycle intent is lasting from its third attempt on (A2). */
const LASTING_FAILURE_ATTEMPTS = 3
const REVALIDATION_ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE = 500
const CONTACT_IP_PROOF_PAIRING_VERSION = "nextcms-contact-ip-pairing:v1"
const CONTACT_IP_PROOF_PAIRING_SENTINEL = "contact-ip-proof-secret"
const CONTACT_IP_PROOF_PAIRING_MAX_FUTURE_MS = 10 * 60 * 1000
const SHA256_HEX_RE = /^[a-f0-9]{64}$/
type RevalidationTarget = Id<"pages"> | "menus" | "settings"
type RevalidationBody = {
  paths?: string[]
  layoutPaths?: string[]
  tags?: string[]
  languageVersion?: number
}
type RevalidationResult =
  | { status: "ok"; httpStatus: number }
  | { status: "http_error"; httpStatus: number; errorSnippet: string }
  | { status: "network_error"; errorSnippet: string }
  | { status: "unconfigured" }
type RevalidationSelfTestResult =
  | { status: "ok"; httpStatus: number }
  | { status: "http_error"; httpStatus: number }
  | { status: "network_error" }
  | { status: "unconfigured" }
type ContactIpProofPairingResult =
  { status: "pass" } | { status: "fail" } | { status: "unconfigured" }

const revalidationHealthAttemptValidator = v.object({
  target: revalidationTargetValidator,
  pathCount: v.number(),
  tagCount: v.number(),
  status: revalidationStatusValidator,
  httpStatus: v.optional(v.number()),
  errorSnippet: v.optional(v.string()),
  timestamp: v.number(),
})

const revalidationSelfTestResultValidator = v.union(
  v.object({
    status: v.literal("ok"),
    httpStatus: v.number(),
  }),
  v.object({
    status: v.literal("http_error"),
    httpStatus: v.number(),
  }),
  v.object({
    status: v.literal("network_error"),
  }),
  v.object({
    status: v.literal("unconfigured"),
  })
)

const contactIpProofPairingResultValidator = v.union(
  v.object({ status: v.literal("pass") }),
  v.object({ status: v.literal("fail") }),
  v.object({ status: v.literal("unconfigured") })
)

function pairingPayload(expiresAt: number): string {
  return `${CONTACT_IP_PROOF_PAIRING_VERSION}:${expiresAt}:${CONTACT_IP_PROOF_PAIRING_SENTINEL}`
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0)
  }
  return difference === 0
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  )
  return bytesToHex(signature)
}

async function verifyContactIpProofPairingValue(proof: {
  expiresAt: number
  signature: string
}): Promise<ContactIpProofPairingResult> {
  const secret = env.CONTACT_IP_PROOF_SECRET
  if (!secret) return { status: "unconfigured" }

  const expiresAt = proof.expiresAt
  const signature = proof.signature
  const now = Date.now()
  if (
    !Number.isSafeInteger(expiresAt) ||
    !SHA256_HEX_RE.test(signature) ||
    expiresAt < now ||
    expiresAt > now + CONTACT_IP_PROOF_PAIRING_MAX_FUTURE_MS
  ) {
    return { status: "fail" }
  }

  const expected = await hmacSha256Hex(secret, pairingPayload(expiresAt))
  return constantTimeEqual(expected, signature)
    ? { status: "pass" }
    : { status: "fail" }
}

function boundedCount(name: string, value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_REVALIDATION_ITEM_COUNT
  ) {
    throw new Error(`${name} must be a bounded non-negative integer`)
  }
  return value
}

function sanitizeErrorSnippet(
  value: string,
  sensitiveValues: readonly string[] = []
): string {
  let sanitized = value
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) {
      sanitized = sanitized.split(sensitiveValue).join("[REDACTED]")
    }
  }
  return sanitized
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(secret|token|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/:\/\/[^/\s@]+@/g, "://[REDACTED]@")
    .slice(0, MAX_ERROR_SNIPPET_LENGTH)
}

export const recordAttempt = internalMutation({
  args: {
    target: revalidationTargetValidator,
    pathCount: v.number(),
    tagCount: v.number(),
    status: revalidationStatusValidator,
    httpStatus: v.optional(v.number()),
    errorSnippet: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const pathCount = boundedCount("pathCount", args.pathCount)
    const tagCount = boundedCount("tagCount", args.tagCount)
    if (
      args.httpStatus !== undefined &&
      (!Number.isSafeInteger(args.httpStatus) ||
        args.httpStatus < 100 ||
        args.httpStatus > 599)
    ) {
      throw new Error("httpStatus must be an HTTP status code")
    }
    await ctx.db.insert("revalidationAttempts", {
      target: args.target,
      pathCount,
      tagCount,
      status: args.status,
      ...(args.httpStatus !== undefined && { httpStatus: args.httpStatus }),
      ...(args.errorSnippet !== undefined && {
        errorSnippet: sanitizeErrorSnippet(args.errorSnippet),
      }),
      timestamp: Date.now(),
    })
    return null
  },
})

/**
 * Delete revalidation attempts older than the 90-day retention boundary.
 * Each invocation deletes a fixed batch so it stays within mutation limits;
 * a full batch continues in a fresh transaction until the backlog drains.
 */
export const purgeExpiredAttempts = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - REVALIDATION_ATTEMPT_RETENTION_MS
    const expired = await ctx.db
      .query("revalidationAttempts")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .take(REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE)
    await Promise.all(expired.map((attempt) => ctx.db.delete(attempt._id)))
    if (expired.length === REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.revalidate.purgeExpiredAttempts,
        {}
      )
    }
    return expired.length
  },
})

const publicSiteUpdateStateValidator = v.union(
  v.literal("no_address"),
  v.literal("incomplete"),
  v.literal("updating"),
  v.literal("local_unreachable"),
  v.literal("failed"),
  v.literal("ok")
)
export type PublicSiteUpdateState = Infer<typeof publicSiteUpdateStateValidator>

/**
 * The one classification both admin surfaces (General settings and Pages)
 * show, in this order: `no_address` (saved address and `SITE_URL` both
 * empty); `incomplete` (an address but no shared secret); `failed` (a
 * lifecycle intent failed three times, so Retry is useful); `updating`
 * (queued, running, still-unconfigured or early-retry intents); then
 * `local_unreachable` (a quiet local intent, or recent failures against a
 * local address); `failed` again for a real failure streak; else `ok`.
 * Reads no secret value and returns none.
 */
async function classifyUpdateState(
  ctx: QueryCtx,
  hasFailureStreak: boolean
): Promise<PublicSiteUpdateState> {
  const settings = await ctx.db.query("siteSettings").take(2)
  const address = configuredSiteAddress(
    settings.length === 1 ? settings[0]!.siteUrl : undefined
  )
  if (!address) return "no_address"
  if (!env.REVALIDATE_SECRET) return "incomplete"
  const probe = (status: Doc<"siteLanguageLifecycleIntents">["status"], count: number) =>
    ctx.db
      .query("siteLanguageLifecycleIntents")
      .withIndex("by_status_and_updatedAt", (q) => q.eq("status", status))
      .take(count)
  const [pending, running, unconfigured, failed, local] = await Promise.all([
    probe("pending", 1),
    probe("running", 1),
    probe("unconfigured", 1),
    // Bounded: realistic sites hold a handful of failed intents.
    probe("failed", 32),
    probe("local_unreachable", 1),
  ])
  if (failed.some((intent) => intent.attempts >= LASTING_FAILURE_ATTEMPTS)) {
    return "failed"
  }
  if (
    pending.length + running.length + unconfigured.length + failed.length >
    0
  ) {
    return "updating"
  }
  if (local.length > 0) return "local_unreachable"
  if (hasFailureStreak) {
    return isLocalOrigin(address) ? "local_unreachable" : "failed"
  }
  return "ok"
}

/**
 * Protected-operation read for the admin health surfaces. The newest
 * 50 rows are returned; one extra sentinel row distinguishes an exact
 * 50-failure streak from a longer streak without an unbounded scan.
 *
 * `unconfigured` reflects only the newest attempt. A later configured attempt
 * therefore clears stale configuration state even when older rows remain.
 */
export const getRevalidationHealth = query({
  args: {},
  returns: v.object({
    recentAttempts: v.array(revalidationHealthAttemptValidator),
    consecutiveFailureCount: v.number(),
    consecutiveFailureCountCapped: v.boolean(),
    unconfigured: v.boolean(),
    updateState: publicSiteUpdateStateValidator,
  }),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    const scanned = await ctx.db
      .query("revalidationAttempts")
      .withIndex("by_timestamp")
      .order("desc")
      .take(REVALIDATION_HEALTH_LIMIT + 1)
    const recent = scanned.slice(0, REVALIDATION_HEALTH_LIMIT)
    // Only real delivery failures count. A success or an `unconfigured`
    // record (nothing was attempted) ends the streak (B1, owner 2026-11-02).
    let scannedFailureCount = 0
    for (const attempt of scanned) {
      if (attempt.status === "ok" || attempt.status === "unconfigured") break
      scannedFailureCount += 1
    }
    const updateState = await classifyUpdateState(ctx, scannedFailureCount > 0)
    return {
      recentAttempts: recent.map((attempt) => ({
        target: attempt.target,
        pathCount: attempt.pathCount,
        tagCount: attempt.tagCount,
        status: attempt.status,
        ...(attempt.httpStatus !== undefined && {
          httpStatus: attempt.httpStatus,
        }),
        ...(attempt.errorSnippet !== undefined && {
          errorSnippet: attempt.errorSnippet,
        }),
        timestamp: attempt.timestamp,
      })),
      consecutiveFailureCount: Math.min(
        scannedFailureCount,
        REVALIDATION_HEALTH_LIMIT
      ),
      consecutiveFailureCountCapped:
        scannedFailureCount > REVALIDATION_HEALTH_LIMIT,
      unconfigured: recent[0]?.status === "unconfigured",
      updateState,
    }
  },
})

export const assertCanRunRevalidationSelfTest = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    return null
  },
})

export const assertCanVerifyContactIpProofPairing = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    return null
  },
})

/**
 * Verify that the Next and Convex deployments share CONTACT_IP_PROOF_SECRET.
 * The proof's fixed-sentinel domain is diagnostic-only and cannot authenticate
 * a visitor IP or affect any auth limiter state.
 */
export const verifyContactIpProofPairing = action({
  args: {
    expiresAt: v.number(),
    signature: v.string(),
  },
  returns: contactIpProofPairingResultValidator,
  handler: async (ctx, proof): Promise<ContactIpProofPairingResult> => {
    const authorized: null = await ctx.runQuery(
      internal.cms.revalidate.assertCanVerifyContactIpProofPairing,
      {}
    )
    void authorized
    return await verifyContactIpProofPairingValue(proof)
  },
})

export const runRevalidationSelfTest = action({
  args: {},
  returns: revalidationSelfTestResultValidator,
  handler: async (ctx): Promise<RevalidationSelfTestResult> => {
    const authorized: null = await ctx.runQuery(
      internal.cms.revalidate.assertCanRunRevalidationSelfTest,
      {}
    )
    void authorized
    const result = await revalidateAndRecord(ctx, "settings", {
      paths: [],
      tags: [],
    })
    if (result.status === "ok" || result.status === "http_error") {
      return { status: result.status, httpStatus: result.httpStatus }
    }
    return { status: result.status }
  },
})

// Resolve the Next app origin + shared secret, or null when revalidation isn't
// configured (best-effort: the time-based `revalidate` floor is the fallback).
export type RevalidationEndpoint = { baseUrl: string; secret: string }

export async function resolveTarget(
  ctx: ActionCtx
): Promise<RevalidationEndpoint | null> {
  const secret = env.REVALIDATE_SECRET
  // Keep the unconfigured fast path free of a settings query.
  if (!secret) return null
  const config = await ctx.runQuery(api.cms.settings.getSiteConfig, {})
  const baseUrl = configuredRevalidationOrigin(config.siteUrl)
  if (!baseUrl) return null
  return { baseUrl, secret }
}

// POST to the Next /api/revalidate endpoint. `tags` purges the shared Data
// Cache (unstable_cache) by content type; `paths` purges the Full Route Cache
// for specific public URLs. Both are best-effort.
async function postRevalidate(
  target: { baseUrl: string; secret: string },
  body: RevalidationBody
): Promise<Exclude<RevalidationResult, { status: "unconfigured" }>> {
  try {
    const response = await fetch(`${target.baseUrl}/api/revalidate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-revalidate-secret": target.secret,
      },
      body: JSON.stringify(body),
    })
    return response.ok
      ? { status: "ok", httpStatus: response.status }
      : {
          status: "http_error",
          httpStatus: response.status,
          errorSnippet: `HTTP ${response.status}`,
        }
  } catch (error) {
    // Best-effort; the time-based revalidate floor is the fallback.
    return {
      status: "network_error",
      errorSnippet: sanitizeErrorSnippet(
        error instanceof Error ? error.message : String(error),
        [target.secret]
      ),
    }
  }
}

async function revalidateAndRecord(
  ctx: ActionCtx,
  attemptTarget: RevalidationTarget,
  body: RevalidationBody
): Promise<RevalidationResult> {
  return postAndRecordRevalidation(
    ctx,
    await resolveTarget(ctx),
    attemptTarget,
    body
  )
}

/** POST to an already-resolved endpoint (or record `unconfigured`). */
export async function postAndRecordRevalidation(
  ctx: ActionCtx,
  target: RevalidationEndpoint | null,
  attemptTarget: RevalidationTarget,
  body: RevalidationBody
): Promise<RevalidationResult> {
  const result: RevalidationResult = target
    ? await postRevalidate(target, body)
    : { status: "unconfigured" }
  const recorded: null = await ctx.runMutation(
    internal.cms.revalidate.recordAttempt,
    {
      target: attemptTarget,
      pathCount: (body.paths?.length ?? 0) + (body.layoutPaths?.length ?? 0),
      tagCount: body.tags?.length ?? 0,
      ...result,
    }
  )
  void recorded
  return result
}

/**
 * Purge a page's ISR cache after it's published, unpublished, moved, re-slugged,
 * or edited. Scheduled (fire-and-forget) from the page mutations.
 *
 * `extraPaths` carries the page's *previous* URLs (captured before a slug/parent
 * change) so the old location is purged too. Invalidates both the `pages` tag
 * and the `menus` tag — navigation links resolve to page paths, so a slug or
 * structure change can change a menu's rendered hrefs.
 *
 * Requires Convex env vars: REVALIDATE_SECRET (shared with the Next route) and,
 * if `siteSettings.siteUrl` is empty, SITE_URL (the public site origin).
 */
export const revalidatePage = internalAction({
  args: {
    pageId: v.id("pages"),
    extraPaths: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, { pageId, extraPaths }) => {
    const config = await ctx.runQuery(api.cms.settings.getSiteConfig, {})
    // The navigation set (M05 C5): every enabled locale's current URL,
    // indexable or not.
    const current = await ctx.runQuery(
      api.cms.pages.getPublicLocaleAlternates,
      {
        pageId,
        languageVersion: config.languageVersion,
      }
    )
    const paths = Array.from(
      new Set([...current.map(({ url }) => url), ...(extraPaths ?? [])])
    )

    const body = {
      paths,
      tags: [CMS_TAGS.pages, CMS_TAGS.menus],
    }
    await revalidateAndRecord(ctx, pageId, body)
    return null
  },
})

/**
 * Purge the navigation cache after a menu is created, saved, or removed.
 * Scheduled from the menu mutations. The resolved menu is rendered in the
 * public layout on every page, so only the `menus` tag is needed (it purges
 * every locale's cached menu read); "/" nudges the home route too.
 */
export const revalidateMenus = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await revalidateAndRecord(ctx, "menus", {
      paths: ["/"],
      tags: [CMS_TAGS.menus],
    })
    return null
  },
})

/**
 * Purge after site settings change. `defaultLocale`/`homePageId` change every
 * page's public URL and the locale prefixing, and `enabledLocales` changes what
 * renders — so this invalidates everything (`pages`, `menus`, `settings`).
 * Scheduled from `updateSettings`.
 */
export const revalidateSettings = internalAction({
  args: {
    languageVersion: v.optional(v.number()),
    currentLocale: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { languageVersion, currentLocale }) => {
    await revalidateAndRecord(ctx, "settings", {
      paths: ["/", ...(currentLocale ? [`/${currentLocale}`] : [])],
      layoutPaths: ["/(public)/[locale]"],
      tags: [CMS_TAGS.pages, CMS_TAGS.menus, CMS_TAGS.settings],
      ...(languageVersion !== undefined ? { languageVersion } : {}),
    })
    return null
  },
})

// F08c — required revalidation worker for Published Snapshot transitions.
//
// Publication inserts one `pagePublicationRevalidationIntents` row per
// Page+locale transition and never loads referrers. This cron-driven worker
// claims a bounded batch and walks each intent's saved phase/cursor: `self`
// purges the old/new locale paths, then `referrers` and `descendants` page
// through that locale's `current_public` reference rows targeting the Page.
// Each step posts before it advances, so a crash or failed POST retries the
// same step (revalidation is idempotent). Claims compare-and-set on
// `attempts`, so an overlapping or reclaimed run never advances a cursor it
// does not own.
export const PUBLICATION_REVALIDATION_CLAIM_LIMIT = 8
export const PUBLICATION_REVALIDATION_STEP_SIZE = 128
export const PUBLICATION_REVALIDATION_RETRY_DELAY_MS = 5 * 60 * 1000
export const PUBLICATION_REVALIDATION_LEASE_MS = 15 * 60 * 1000
const PUBLICATION_REVALIDATION_MAX_STEPS = 32

type RevalidationIntentPhase = "self" | "referrers" | "descendants" | "complete"
type RevalidationClaim = {
  intentId: Id<"pagePublicationRevalidationIntents">
  attempts: number
}
type RevalidationStep = {
  pageId: Id<"pages">
  phase: RevalidationIntentPhase
  cursor: string | null
  paths: string[]
  tags: string[]
  nextPhase: RevalidationIntentPhase
  nextCursor: string | null
}

const revalidationIntentPhaseValidator = v.union(
  v.literal("self"),
  v.literal("referrers"),
  v.literal("descendants"),
  v.literal("complete")
)
const revalidationClaimArgs = {
  intentId: v.id("pagePublicationRevalidationIntents"),
  attempts: v.number(),
}

export const claimPublicationRevalidationIntents = internalMutation({
  args: {},
  returns: v.array(v.object(revalidationClaimArgs)),
  handler: async (ctx): Promise<RevalidationClaim[]> => {
    if ((await readPublicationAuthority(ctx)) !== "snapshot_active") return []
    const now = Date.now()
    const limit = PUBLICATION_REVALIDATION_CLAIM_LIMIT
    const [pending, abandoned, failed] = await Promise.all([
      ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_status_and_updatedAt", (q) => q.eq("status", "pending"))
        .take(limit),
      ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_status_and_updatedAt", (q) =>
          q
            .eq("status", "running")
            .lt("updatedAt", now - PUBLICATION_REVALIDATION_LEASE_MS)
        )
        .take(limit),
      ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_status_and_updatedAt", (q) =>
          q
            .eq("status", "failed")
            .lt("updatedAt", now - PUBLICATION_REVALIDATION_RETRY_DELAY_MS)
        )
        .take(limit),
    ])
    const claims: RevalidationClaim[] = []
    for (const intent of [...pending, ...abandoned, ...failed].slice(
      0,
      limit
    )) {
      const sameOperation = await ctx.db
        .query("pagePublicationRevalidationIntents")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", intent.operationId)
        )
        .take(2)
      if (sameOperation.length !== 1) {
        // A duplicate operation identity is corrupt state; never pick a row.
        await ctx.db.patch(intent._id, {
          status: "failed",
          lastErrorCode: "REVALIDATION_INTENT_DUPLICATE",
          updatedAt: now,
        })
        continue
      }
      await ctx.db.patch(intent._id, {
        status: "running",
        attempts: intent.attempts + 1,
        updatedAt: now,
      })
      claims.push({ intentId: intent._id, attempts: intent.attempts + 1 })
    }
    return claims
  },
})

export const planPublicationRevalidationStep = internalQuery({
  args: revalidationClaimArgs,
  returns: v.union(
    v.null(),
    v.object({
      pageId: v.id("pages"),
      phase: revalidationIntentPhaseValidator,
      cursor: v.union(v.string(), v.null()),
      paths: v.array(v.string()),
      tags: v.array(v.string()),
      nextPhase: revalidationIntentPhaseValidator,
      nextCursor: v.union(v.string(), v.null()),
    })
  ),
  handler: async (
    ctx,
    { intentId, attempts }
  ): Promise<RevalidationStep | null> => {
    const intent = await ctx.db.get(intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== attempts ||
      intent.phase === "complete"
    ) {
      return null
    }
    const settings = await ctx.db.query("siteSettings").first()
    const defaultLocale = settings?.defaultLocale ?? "en"
    const localePath = (path: string) =>
      intent.locale === defaultLocale ? path : `/${intent.locale}${path}`
    const routePaths = (path: string) => [
      localePath(path),
      `/${intent.locale}${path === "/" ? "" : path}`,
    ]
    const cursor = intent.cursor ?? null

    if (intent.phase === "self") {
      const paths = [intent.oldPath, intent.newPath]
        .filter((path): path is string => path !== undefined)
        .flatMap(routePaths)
      return {
        pageId: intent.pageId,
        phase: "self",
        cursor,
        paths: [...new Set(paths)],
        tags: [CMS_TAGS.pages, CMS_TAGS.menus],
        nextPhase: "referrers",
        nextCursor: null,
      }
    }

    // Dependants come only from this locale's current-public reference arms;
    // `ancestry` rows are descendants, every other kind is a referrer.
    const descendants = intent.phase === "descendants"
    const references = await ctx.db
      .query("pagePublicationDocumentReferences")
      .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
        q
          .eq("targetId", intent.pageId)
          .eq("sourceKind", "current_public")
          .eq("locale", intent.locale)
      )
      .paginate({ numItems: PUBLICATION_REVALIDATION_STEP_SIZE, cursor })
    const sources = new Map<Id<"pages">, Id<"pagePublishedSnapshots">>()
    for (const reference of references.page) {
      if (reference.sourceKind !== "current_public") continue
      if ((reference.referenceKind === "ancestry") !== descendants) continue
      sources.set(reference.pageId, reference.sourceId)
    }
    const paths: string[] = []
    for (const [pageId, snapshotId] of sources) {
      const states = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", intent.locale)
        )
        .take(2)
      const state = states.length === 1 ? states[0]! : null
      if (
        !state ||
        state.currentSnapshotId !== snapshotId ||
        state.currentPath === undefined
      ) {
        continue
      }
      paths.push(...routePaths(state.currentPath))
    }
    return {
      pageId: intent.pageId,
      phase: intent.phase,
      cursor,
      paths: [...new Set(paths)],
      tags: [],
      nextPhase: references.isDone
        ? descendants
          ? "complete"
          : "descendants"
        : intent.phase,
      nextCursor: references.isDone ? null : references.continueCursor,
    }
  },
})

export const advancePublicationRevalidationIntent = internalMutation({
  args: {
    ...revalidationClaimArgs,
    fromPhase: revalidationIntentPhaseValidator,
    fromCursor: v.union(v.string(), v.null()),
    nextPhase: revalidationIntentPhaseValidator,
    nextCursor: v.union(v.string(), v.null()),
    unconfigured: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts ||
      intent.phase !== args.fromPhase ||
      (intent.cursor ?? null) !== args.fromCursor
    ) {
      return false
    }
    // No configured target means there is no cache to purge; like the legacy
    // `unconfigured` attempt this is terminal, not retryable.
    const complete = args.unconfigured || args.nextPhase === "complete"
    await ctx.db.patch(intent._id, {
      phase: complete ? "complete" : args.nextPhase,
      cursor: complete ? undefined : (args.nextCursor ?? undefined),
      status: complete ? "complete" : "running",
      ...(args.unconfigured
        ? { lastErrorCode: "REVALIDATION_UNCONFIGURED" }
        : {}),
      updatedAt: Date.now(),
    })
    return true
  },
})

export const failPublicationRevalidationIntent = internalMutation({
  args: {
    ...revalidationClaimArgs,
    errorCode: v.union(v.literal("http_error"), v.literal("network_error")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts
    ) {
      return null
    }
    await ctx.db.patch(intent._id, {
      status: "failed",
      lastErrorCode:
        args.errorCode === "http_error"
          ? "REVALIDATION_HTTP_ERROR"
          : "REVALIDATION_NETWORK_ERROR",
      updatedAt: Date.now(),
    })
    return null
  },
})

export const releasePublicationRevalidationIntent = internalMutation({
  args: revalidationClaimArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts
    ) {
      return null
    }
    await ctx.db.patch(intent._id, { status: "pending", updatedAt: Date.now() })
    return null
  },
})

async function runPublicationRevalidationIntent(
  ctx: ActionCtx,
  claim: RevalidationClaim
): Promise<void> {
  for (let step = 0; step < PUBLICATION_REVALIDATION_MAX_STEPS; step += 1) {
    const plan: RevalidationStep | null = await ctx.runQuery(
      internal.cms.revalidate.planPublicationRevalidationStep,
      claim
    )
    if (plan === null) return
    let unconfigured = false
    if (plan.paths.length > 0 || plan.tags.length > 0) {
      const result = await revalidateAndRecord(ctx, plan.pageId, {
        paths: plan.paths,
        tags: plan.tags,
      })
      if (result.status === "http_error" || result.status === "network_error") {
        const failed: null = await ctx.runMutation(
          internal.cms.revalidate.failPublicationRevalidationIntent,
          { ...claim, errorCode: result.status }
        )
        void failed
        return
      }
      unconfigured = result.status === "unconfigured"
    }
    const advanced: boolean = await ctx.runMutation(
      internal.cms.revalidate.advancePublicationRevalidationIntent,
      {
        ...claim,
        fromPhase: plan.phase,
        fromCursor: plan.cursor,
        nextPhase: plan.nextPhase,
        nextCursor: plan.nextCursor,
        unconfigured,
      }
    )
    if (!advanced || unconfigured || plan.nextPhase === "complete") return
  }
  // Hand a long fan-out back to the next tick instead of holding the lease.
  const released: null = await ctx.runMutation(
    internal.cms.revalidate.releasePublicationRevalidationIntent,
    claim
  )
  void released
}

/** Cron entry point: drain a bounded batch of publication revalidation intents. */
export const drainPublicationRevalidationIntents = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const claims: RevalidationClaim[] = await ctx.runMutation(
      internal.cms.revalidate.claimPublicationRevalidationIntents,
      {}
    )
    for (const claim of claims) {
      await runPublicationRevalidationIntent(ctx, claim)
    }
    return null
  },
})
