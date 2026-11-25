import { ConvexError } from "convex/values"
import type { Doc } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { assertOrdinaryLocale } from "../language/state"
import { assertNoPagePurge } from "../publishing/pagePurge"
import {
  assertPageIdTranslatedIn,
  CONTENT_TYPE_TRANSLATION_OFF,
} from "../publishing/translationSwitch"

// Server-only eligibility checks; keep the shared translation predicate client-safe.
/** Expected target refusals stop work; invalid language authority still throws. */
export function isPageJobEligibilityRefusal(error: unknown): boolean {
  return error instanceof ConvexError && [
    "AI_JOB_SOURCE_UNAVAILABLE",
    "PAGE_PURGE_IN_PROGRESS",
    "LOCALE_NOT_ENABLED",
    CONTENT_TYPE_TRANSLATION_OFF,
  ].includes(error.data as string)
}

/**
 * Live target eligibility for every execution boundary, independent of the
 * generation pinned at Start. Restore can make a stopped job eligible again.
 * The optional transaction-local cache keeps the progress list's locale
 * checks bounded by distinct target languages, rather than by its 100 jobs.
 */
export async function assertPageJobEligible(
  ctx: QueryCtx | MutationCtx,
  job: Pick<Doc<"aiJobs">, "kind" | "pageId" | "locale">,
  localeChecks?: Map<string, Promise<unknown>>
): Promise<void> {
  const page = await ctx.db.get("pages", job.pageId)
  const states = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", job.pageId))
    .take(2)
  if (!page || states.length !== 1 || states[0]!.lifecycleState !== "active")
    throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  await assertNoPagePurge(ctx, job.pageId)
  let localeCheck = localeChecks?.get(job.locale)
  if (!localeCheck) {
    localeCheck = assertOrdinaryLocale(ctx, job.locale)
    localeChecks?.set(job.locale, localeCheck)
  }
  await localeCheck
  // Retain the separate content-type translation-switch contract.
  if (job.kind === "translation")
    await assertPageIdTranslatedIn(ctx, job.pageId, job.locale)
}
