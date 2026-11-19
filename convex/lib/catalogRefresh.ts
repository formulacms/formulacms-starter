// Shared one-hour lock for the model catalog refreshes (OpenRouter and the
// direct Anthropic and OpenAI lists). Each source has one row in
// `openRouterCatalogSync`, keyed by provider.
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"

export const REFRESH_LOCK_MS = 60 * 60 * 1_000

/** The sync row's `error` after a 401/403 from a direct vendor. */
export const KEY_REFUSED_MESSAGE = "key refused"

type SyncKey = Doc<"openRouterCatalogSync">["key"]
type SyncState = Doc<"openRouterCatalogSync"> | null

export async function readSyncState(
  ctx: QueryCtx | MutationCtx,
  key: SyncKey
): Promise<SyncState> {
  return ctx.db
    .query("openRouterCatalogSync")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
}

/**
 * The two key identities of a direct provider's row: the key of the last
 * published list (`snapshot`, used by the shrink guard and the key-change
 * check) and the last key the vendor refused (`refused`). A row written
 * before `refusedKeyFingerprint` existed kept a refused attempt's fingerprint
 * in `keyFingerprint`; it is read as refused, with the snapshot key unknown.
 */
export function keyIdentity(state: SyncState): {
  snapshot?: string
  refused?: string
} {
  if (!state) return {}
  if (
    state.refusedKeyFingerprint === undefined &&
    state.error === KEY_REFUSED_MESSAGE
  ) {
    return state.keyFingerprint === undefined
      ? {}
      : { refused: state.keyFingerprint }
  }
  return {
    ...(state.keyFingerprint === undefined
      ? {}
      : { snapshot: state.keyFingerprint }),
    ...(state.refusedKeyFingerprint === undefined
      ? {}
      : { refused: state.refusedKeyFingerprint }),
  }
}

/**
 * Starts one refresh unless a run is still inside the lock window. `start`
 * enqueues the retried action and returns its run id; it receives this
 * attempt's time, which the run passes back so a stale run cannot write over
 * a newer one. The row keeps the last success, failure, count and both key
 * fingerprints while the new run is going.
 */
export async function startCatalogRefresh(
  ctx: MutationCtx,
  key: SyncKey,
  start: (attemptAt: number) => Promise<string>
): Promise<null> {
  const now = Date.now()
  const state = await readSyncState(ctx, key)
  if (
    state?.status === "running" &&
    now - state.lastAttemptAt < REFRESH_LOCK_MS
  ) {
    return null
  }

  const runId = await start(now)
  const { snapshot, refused } = keyIdentity(state)
  const update = {
    key,
    status: "running" as const,
    runId,
    lastAttemptAt: now,
    ...(state?.lastSuccessAt === undefined
      ? {}
      : { lastSuccessAt: state.lastSuccessAt }),
    ...(state?.lastFailureAt === undefined
      ? {}
      : { lastFailureAt: state.lastFailureAt }),
    ...(state?.modelCount === undefined
      ? {}
      : { modelCount: state.modelCount }),
    ...(snapshot === undefined ? {} : { keyFingerprint: snapshot }),
    ...(refused === undefined ? {} : { refusedKeyFingerprint: refused }),
  }
  if (state) {
    await ctx.db.replace("openRouterCatalogSync", state._id, update)
  } else {
    await ctx.db.insert("openRouterCatalogSync", update)
  }
  return null
}

/** Whether the run that started at `attemptAt` is still the current one. */
export function isCurrentAttempt(
  state: SyncState,
  attemptAt: number
): state is Doc<"openRouterCatalogSync"> {
  return state !== null && state.lastAttemptAt === attemptAt
}
