// Centralized rate-limiter policy table (ADR-0026 §3).
//
// Only the limits actively wired in each shipped phase are enabled here. The
// commented stubs are intentional documentation: keeping the entire policy in
// one file lets a reviewer see the abuse surface at a glance without grepping
// across phases. The owner-only operational email probe is keyed from the
// authenticated durable owner; its authorization remains in `convex/email.ts`.
//
// Distinct from `convex/lib/aiRateLimit.ts` — that file scopes per-user/per-
// deployment AI ceilings; this one covers the public-endpoint + delivery-test
// limits ADR-0026 mandates.

import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter"
import { components } from "../_generated/api"

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Phase 6 — public contact form. Per-IP token bucket + global ceiling.
  contactPerIp: {
    kind: "token bucket",
    rate: 5,
    period: 10 * MINUTE,
    capacity: 5,
  },
  contactGlobal: { kind: "fixed window", rate: 200, period: HOUR },
  // E04 — owner-derived operational delivery probe. Provider readiness is
  // checked before this budget is consumed; callers never choose a recipient.
  emailOwnerTestPerOwner: { kind: "fixed window", rate: 5, period: HOUR },
  // G0 — the public owner-account function (ADR-0056 rule 1). One wide
  // deployment-level window bounds code guessing; the grants themselves cannot
  // be guessed. Failed attempts return normally so the limiter writes commit
  // instead of rolling back with a thrown error.
  ownerClaimGlobal: { kind: "fixed window", rate: 300, period: HOUR },
  // Authenticated-but-costly endpoints. Both are already permission-gated, so
  // these are not anti-abuse gates against anonymous callers — they bound what
  // a single legitimate (or compromised) session can spend when each call has
  // a cost the deployment pays.
  //
  // `validateProductionConnection` reaches a paid vendor endpoint on every
  // call and is the one paid path outside `enforceAiRateLimit`.
  aiConnectionValidatePerUser: { kind: "fixed window", rate: 20, period: HOUR },
  // `importFromUrl` performs an outbound fetch and can store up to 10 MB per
  // call, so an authed `media:upload` holder could loop it into the file-storage
  // quota.
  mediaImportPerUser: {
    kind: "token bucket",
    rate: 30,
    period: HOUR,
    capacity: 30,
  },
})
