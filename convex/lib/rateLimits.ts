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
  // Phase 9 — forgot-password endpoint. The deployment-wide fixed window is
  // the hard delivery ceiling. Per-email caps how often one inbox can be targeted;
  // per-IP caps how fast one client can sweep addresses. All are enforced
  // silently — a hit never reveals limiter state to the caller.
  forgotPasswordGlobal: { kind: "fixed window", rate: 100, period: HOUR },
  forgotPasswordPerEmail: { kind: "fixed window", rate: 3, period: HOUR },
  forgotPasswordPerIp: {
    kind: "token bucket",
    rate: 10,
    period: HOUR,
    capacity: 10,
  },
  // E04 — owner-derived operational delivery probe. Provider readiness is
  // checked before this budget is consumed; callers never choose a recipient.
  emailOwnerTestPerOwner: { kind: "fixed window", rate: 5, period: HOUR },
  // Phase 10 — admin invitations. Per-inviter cap blocks a single admin (or a
  // compromised session) from blasting many invites; global cap bounds the
  // whole deployment's outbound invite volume independent of who's issuing.
  // Accept attempts use a global ceiling. A per-token hash key does not help
  // blind scans because every guessed token hashes to a different key; the
  // 256-bit token space remains the primary defense.
  inviteCreatePerUser: { kind: "fixed window", rate: 5, period: HOUR },
  inviteCreateGlobal: {
    kind: "token bucket",
    rate: 50,
    period: HOUR,
    capacity: 50,
  },
  inviteAcceptGlobal: { kind: "fixed window", rate: 100, period: HOUR },
  // G0 — the authenticated owner-claim mutation. The identity bucket slows
  // repeated guesses from one session; the deliberately wide deployment
  // backstop bounds aggregate work without becoming the primary signup
  // perimeter. Failed attempts return normally so these transactional limiter
  // writes commit instead of rolling back with a thrown claim error.
  ownerClaimPerIdentity: {
    kind: "token bucket",
    rate: 5,
    period: 10 * MINUTE,
    capacity: 5,
  },
  ownerClaimGlobal: { kind: "fixed window", rate: 300, period: HOUR },
  // G0-B — public account-creation perimeter. The per-client bucket is keyed
  // by a one-way hash of the trusted client identity for each transport
  // origin. A deliberately wide deployment backstop also bounds aggregate
  // claim guessing without making a small site easy to lock out globally.
  authSignupPerClient: {
    kind: "token bucket",
    rate: 5,
    period: 10 * MINUTE,
    capacity: 5,
  },
  authSignupGlobal: { kind: "fixed window", rate: 300, period: HOUR },
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
