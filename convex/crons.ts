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

// ADR-0041 §9 path 4 — daily sweep of abandoned staging rows (>60 days
// idle by `updatedAt`). Two exemptions live inside the mutation:
// scheduled-for-a-future-time and never-published pages. The mutation
// paginates and self-reschedules so a burst of qualifying rows never
// pins one tick.
crons.cron(
  "page-staging abandoned sweep",
  "0 4 * * *",
  internal.cms.pages.sweepAbandonedStaging,
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
// bounded local snapshot once a week; Action Retrier handles transient network
// and upstream failures while the previous valid snapshot remains active.
crons.cron(
  "openrouter model catalog refresh",
  "0 5 * * 0",
  internal.cms.openRouterCatalog.enqueueWeeklyRefresh,
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
