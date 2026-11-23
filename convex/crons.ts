// convex/crons.ts
// Scheduled background jobs. Keep one line per job; the handler bodies live
// next to their respective modules.
import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Revalidation attempts are operational telemetry, retained for 90 days.
// The internal mutation deletes in bounded batches and self-continues when
// necessary, so this nightly UTC entry point stays small.
crons.cron(
  "revalidation-attempts purge",
  "15 3 * * *",
  internal.cms.revalidate.purgeExpiredAttempts,
  {}
)

// F08c: the required post-commit revalidation worker. Publication transitions
// only insert a durable intent; each tick claims a bounded batch, purges the
// Page+locale path and its same-locale current referrers and descendants in
// bounded steps, and retries failed or abandoned intents from their cursor.
crons.interval(
  "publication revalidation intents",
  { minutes: 1 },
  internal.cms.revalidate.drainPublicationRevalidationIntents,
  {}
)

// M05 M17: the required lifecycle revalidation worker. Language and public-
// module lifecycle commits only insert a durable intent; each tick claims a
// bounded batch, posts its phases against the configured origin, and retries
// failed or abandoned intents.
crons.interval(
  "language lifecycle intents",
  { minutes: 1 },
  internal.cms.languageLifecycle.drainLanguageLifecycleIntents,
  {}
)

// M05 collection: nightly dispatcher for unreachable default-migration
// generations and stale or expired preview disclosure pages. Each step pages
// a bounded set of subjects and schedules bounded collection per subject.
crons.cron(
  "language continuity collection sweep",
  "45 3 * * *",
  internal.cms.languageLifecycle.sweepDefaultLanguageCollection,
  {}
)

// PERMANENT-DELETE: Delete in Trash only queues a purge request. This daily
// batch (08:07 UTC, about 3-4 am in Montreal) starts the worker, which then
// reschedules itself batch by batch until no queued purge is left. It also
// restarts a chain that was lost.
crons.cron(
  "page purge daily batch",
  "7 8 * * *",
  internal.cms.publication.startQueuedPagePurges,
  {}
)

// PERMANENT-DELETE: prepare the rich-text image usage index so permanent media
// delete never waits for it. Starts the backfill when it has not started or has
// failed; one small status read once it is complete.
crons.hourly(
  "rich-text image usage backfill",
  { minuteUTC: 25 },
  internal.lib.media.richTextBackfill.startRichTextImageBackfillIfNeeded,
  {}
)

// ADR-0037 amendment (2026-11-17): copy the old shared search, social and card
// values into each page's Working Drafts, once per page. Starts the migration
// when it has not started or has failed; one small status read once done.
crons.hourly(
  "per-language fields backfill",
  { minuteUTC: 40 },
  internal.lib.publishing.perLanguageBackfill
    .startPerLanguageFieldsBackfillIfNeeded,
  {}
)

// M05 C5a: the nightly sitemap partition check. It requests a first build
// when the live language version has no ready or building manifest, rebuilds
// a ready manifest whose partitions drifted or are oversized, and collects
// abandoned and expired superseded manifests, each in bounded steps.
crons.cron(
  "sitemap manifest sweep",
  "55 3 * * *",
  internal.cms.publication.sweepSitemapManifests,
  {}
)

crons.cron(
  "ai-audit-log purge",
  "0 3 * * *",
  internal.cms.aiAuditLog.purgeExpired,
  {}
)

// OpenRouter publishes model availability and per-token pricing. Refresh the
// bounded local snapshot daily so a new model has a price within a day; Action
// Retrier handles transient network and upstream failures while the previous
// valid snapshot remains active.
crons.cron(
  "openrouter model catalog refresh",
  "5 5 * * *",
  internal.cms.openRouterCatalog.enqueueWeeklyRefresh,
  {}
)

// The Anthropic and OpenAI model lists, fetched with the owner's own key.
// Providers without a key are skipped.
crons.cron(
  "vendor model catalog refresh",
  "10 5 * * *",
  internal.cms.vendorModelCatalog.enqueueDailyRefresh,
  {}
)

// Keys are deployment variables, so a new or changed key has no save event.
// Hourly: fetch a provider that was never fetched or whose key changed.
crons.interval(
  "vendor model catalog key check",
  { hours: 1 },
  internal.cms.vendorModelCatalog.ensureVendorRefresh,
  {}
)

// A new site has no OpenRouter prices until a refresh succeeds. Convex runs an
// interval job first when it is deployed; after the first success this no-ops.
crons.interval(
  "openrouter model catalog first refresh",
  { hours: 1 },
  internal.cms.openRouterCatalog.ensureFirstRefresh,
  {}
)

export default crons
