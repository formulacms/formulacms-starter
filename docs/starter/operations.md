# formulacms Starter Operations

This guide is the Phase 15 handoff for running, configuring, and upgrading the
starter without private project context.

> **Email successor notice (2026-09-21):**
> ADR-0054 is the current email authority in the private source repository.
> E01-E08 are source-integrated, the sole generated FormulaCMS starter
> projection is locally verified, and the capabilities present in the
> authorized Community owner application are runtime-verified. SDA01 retired
> the obsolete Team artifact and recipe lock.
> This does not prove inbox delivery, production-backend readiness, live
> migration or cleanup, a published release, or production promotion. Legacy
> SMTP setup is retired authority.

## Release Readiness Boundary

The generated starter is a bounded pilot for at most 499 total pages and 499
published pages. Keep that operating limit in every client handoff until
ROUTE-04 replaces the bounded route and sitemap reads and its release evidence
is green.

## Release and fork-transition policy

### Definitions

| Term                       | Meaning                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Release**                | One immutable, annotated SemVer Git tag. It is the sole release identity. Package, engine, schema, and release-recipe versions are component versions, separate from release identity. |
| **Update**                 | A compatible source-to-target transition that needs no data migration, mandatory configuration change, or administrator action.                                                        |
| **Guided upgrade**         | A source-to-target transition that requires a data migration, mandatory configuration change, or administrator action.                                                                 |
| **Breaking upgrade**       | A transition that removes or changes a supported contract, requires owner-code changes, or cannot support code-artifact rollback.                                                      |
| **Unsupported transition** | A target release has not declared and tested a path from the named source release. Stop; do not infer compatibility from a code diff or schema number.                                 |
| **Regeneration**           | Creation of a fresh starter artifact. It is never an update mechanism for an existing customer-owned fork.                                                                             |
| **Migration**              | An ordered data or state change that a declared guided or breaking upgrade requires. A code-artifact rollback never implies data rollback.                                             |
| **Fork applicability**     | The separate assessment of one owner fork: `clean`, `compatible divergence`, `manual integration`, or `blocked`. It does not change the upstream transition class.                     |

Classify a source-to-target transition with the first matching rule:
`unsupported` → `breaking upgrade` → `guided upgrade` → `update`. A declared
path must be verified by release CI; tooling must not infer its class from a
diff. Patch releases contain updates only; minor releases may contain updates
or guided upgrades; major releases may contain breaking upgrades. Before 1.0,
patch releases remain compatible updates and every minor release must declare
its class. Per-hop transitions may be non-composable.

`engine.manifest.json` records schema version 4 and supports schema version 3; schema version 2 remains unsupported.
The separate `starter.transitions.json` is the
machine-readable authority for exact tagged source-to-target paths. Validate a
named hop before merging it:

```bash
node --import tsx scripts/check-release-transition.ts \
  --source-tag v0.1.0 \
  --target-tag v0.1.1
```

Use `node --import tsx`, not `pnpm exec tsx`. Under pnpm 11, `pnpm exec`
first installs dependencies, which can start an install in the middle of a
merge.

During an upgrade, the content-type registry holds your entries and
formulacms entries; follow the shared-registry rule in step 4 of the
[Fork Upgrade Playbook](#fork-upgrade-playbook).

### What is and is not shipped for existing forks

| Surface                                                                    | Current contract                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh starter generation                                                   | Shipped for new projects. It creates a new artifact only.                                                                                        |
| Engine fixes and compatible dependency changes                             | May be proposed through a reviewed manual fork upgrade after the target release declares its transition. They are never silently applied.        |
| New presentation, Pages, media, and reference Slice Types                  | New-install or optional adoption only. They do not enter existing forks automatically.                                                           |
| Migrations and required administrator actions                              | Only part of a declared guided or breaking upgrade; never run automatically.                                                                     |
| Owner code, dependencies, integrations, content, assets, and configuration | Owner-controlled. formulacms never silently replaces them.                                                                                       |
| Release tags and exact transition manifests                                | Shipped for declared Community hops. The manual workflow rehearses a clean fork and records evidence; it never deploys or updates an owner fork. |
| Compatibility planner, PR generation, and automated integration            | Deferred. Unknown and skipped paths stop explicitly.                                                                                             |
| Plugin/extension architecture and integration-aware automation             | Deferred. Valid framework divergence and owner integrations are preserved; the merge model remains under design.                                 |

## Pilot capacity signal

The count-free `cms/pages:getBoundedPilotEnvelope` API reports separate boolean
warnings for total and published pages. A warning begins at 400 of the 499-page
pilot maximum (80%), before a normal write would be rejected. It exposes no
page titles, URLs, or counts.

- `pnpm check:pilot-envelope` is the hard release gate. It fails only after a
  bounded route or sitemap read reaches the 500-row sentinel.
- `pnpm check:pilot-envelope:capacity` is the early-warning signal. Run it on
  the exact deployment on a schedule and route its nonzero result to the
  Deployment Owner; it fails when either total or published pages reaches 400.

On an early warning, stop planned page growth in the indicated scope, confirm
the deployment and release identity, and schedule ROUTE-04 before the hard
limit. The source release does not configure an alert destination, provider,
or deployment schedule. At the hard limit, the existing admin create/publish
flows show the bounded-pilot rejection from the API: no 500th total or
published page is accepted.

## Operations and recovery contract

This contract tells the named deployment owner what to capture, alert on, back up, and rehearse for a generated starter. It is provider-neutral and describes required coverage, not an active monitoring, alerting, backup, or recovery service.

### Separate source evidence from deployment coverage

The repository contains bounded operational signals. It does not prove that a deployment has configured a monitoring destination, an alert route, a backup destination, or a successful restore.

| Surface             | Verified in source                                                                                                                                                                                                                                                                                                                  | Coverage boundary                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Next.js errors      | The public error boundary logs the thrown error and shows generic copy. The admin boundary logs the error and can show its digest. `instrumentation.ts` validates Node runtime environment values.                                                                                                                                  | No centralized error capture, alert route, or production error coverage is configured by this repository. |
| Convex revalidation | Revalidation attempts record a target, bounded counts, status, HTTP status, a sanitized error snippet, and a timestamp. Transient delivery failures receive bounded retries, and terminal failures emit `formulacms.revalidation.failed`. The permission-gated health query returns recent attempts and the current failure streak. | This is a revalidation signal, not whole-deployment Convex health. No external alert route is configured. |
| Retained records    | Scheduled jobs in `convex/crons.ts` purge revalidation records after 90 days. That file lists every other retention purge the app runs.                                                                                                                                                                                             | Retention is not a backup. No database or file-storage restore is proven here.                            |
| Release identity    | Release documentation records the exact annotated SemVer starter tag and generated-tree digest before promotion.                                                                                                                                                                                                                    | No release rollback or recovery drill is executed by this contract.                                       |

The source evidence above is implemented in `app/(public)/[locale]/error.tsx`, `app/(core)/admin/(authenticated)/error.tsx`, `instrumentation.ts`, `convex/cms/revalidate.ts`, and `convex/crons.ts`. Treat production coverage as unverified until a deployment record contains the configured target, named owners, and dated evidence.

### Recover a failed public cache invalidation

Each page, menu, or routing-settings invalidation has a 10-second request
deadline. Network failures and HTTP 408, 429, or 5xx responses receive at most
two more attempts, scheduled 5 seconds and then 30 seconds after the preceding
failure. Success stops the chain; permanent HTTP errors and missing endpoint or
secret configuration stop immediately.

Retries carry only the original paths and cache tags. They resolve the current
site origin and shared secret on every attempt, never replay the publication or
settings change, and never include draft content or credentials in scheduled
arguments. A terminal failure writes the fixed, content-free
`formulacms.revalidation.failed` event to the existing Convex log. It is a
signal for the deployment's configured monitoring route, not an alerting
service.

Settings **Test public-site updates** remains one empty connectivity probe. Its
result does not retry or prove recovery of a particular invalidation. For a
failed delivery, repair the endpoint/secret or server condition, then use the
authorized deployment's existing revalidation action to invalidate the
affected paths and tags once. Confirm a later successful attempt and fresh
public output; a 2xx response alone is not proof that rendered output refreshed.

### Capture structured errors and health signals

Every adapter must emit one structured event for a failure or health result. Use UTC timestamps and a correlation ID that does not contain a secret or personal information. Include these fields:

| Field                            | Required value                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `eventId` and `occurredAt`       | A unique event ID and an ISO 8601 UTC timestamp                                          |
| `environment` and `deploymentId` | The environment name and non-secret deployment identity                                  |
| `releaseId`                      | The annotated SemVer starter tag and generated-tree digest                               |
| `component` and `operation`      | `nextjs`, `convex`, `revalidation`, `backup`, or `release`, plus the operation name      |
| `status` and `durationMs`        | The observed result and elapsed time when measured                                       |
| `errorCode` and `errorDigest`    | A stable category and opaque digest; never use a raw exception message as the identifier |
| `correlationId`                  | A request or job identifier safe to share with the incident team                         |

Capture Next.js request, render, and route-handler failures with the route template, method, response status, error digest, and release ID. Capture Convex query, mutation, action, and health failures with the function name, error category, response status when available, latency, and release ID. Do not record function arguments, query results, request bodies, or generated content.

A synthetic check is a scheduled, read-only request that measures availability without changing site data. The deployment contract must check a supported public route, a read-only Convex path, revalidation health, backup freshness, and the current release smoke path. Record the expected result, observed result, latency, and check timestamp. A check must fail closed when it cannot distinguish an unavailable dependency from a healthy response.

### Redact sensitive data before logging or alerting

The adapter must redact these values before an event reaches an alert, routine log, incident ticket, or chat notification:

- **Secrets**: environment values, API keys, `BETTER_AUTH_SECRET`, `CONTACT_IP_PROOF_SECRET`, `REVALIDATE_SECRET`, provider credentials, owner setup codes, webhook signing secrets, and private keys. During the gated legacy migration this also includes `CMS_SECRET_KEY`, SMTP passwords, and stored SMTP ciphertext.
- **Tokens**: cookies, bearer values, password-reset tokens, invitation tokens, signed proofs, and URLs that contain tokens or query parameters
- **Authentication data**: passwords, email addresses, auth subjects, session IDs, reset addresses, and identity-provider responses; use a role or an internal event count when needed
- **User content**: page text, rich-text bodies, form fields, submissions, media payloads, AI prompts and outputs, email bodies, and storage URLs with access signatures
- **Request metadata**: raw IP addresses, full URLs, query strings, `Authorization`, `Cookie`, `Referer`, request or response bodies, and unrestricted user-agent strings

Alerts may include a route template, HTTP method, status, duration, error code, error digest, deployment identity, release identity, and correlation ID. Keep any diagnostic stack trace in a separate access-controlled store only after sanitization and only for the shortest approved retention period.

### Route alerts to named owners

Before enabling an alert, write the person assigned to each role in the deployment record. A role label alone is not an assignment. The primary owner routes the alert to the backup owner, then to the incident commander when the stated escalation time expires.

Assign these named roles before enabling alerts:

- **Deployment Owner**: approves operational changes and owns service availability
- **Release Owner**: owns generated release identity, smoke checks, and rollback
- **Data Recovery Owner**: owns backup artifacts, restore access, and RPO evidence
- **Security Owner**: owns secret inventory, rotation, and exposure response
- **Backup Owner**: receives the primary owner's escalation when the owner does not acknowledge
- **Incident Commander**: coordinates SEV1 response and decides when recovery work begins

| Alert class                              | Owner               | Severity | Trigger or signal                                                                                              | Required action                                                                                                          | Escalation path                                                                                              |
| ---------------------------------------- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Public availability                      | Deployment Owner    | SEV1     | Two consecutive read-only synthetic failures or at least 5% public 5xx responses in 5 minutes                  | Declare an incident, freeze promotion, and compare Next.js, Convex, and release signals                                  | Backup Owner at 15 minutes, Incident Commander at 30 minutes, Data Recovery Owner when restore is considered |
| Next.js error surge                      | Release Owner       | SEV2     | At least 10 matching error codes in 5 minutes or at least 1% public 5xx responses in 5 minutes                 | Correlate by release and error digest, inspect the failing route, and roll back a release-local regression               | Deployment Owner at 1 hour, Incident Commander at 2 hours                                                    |
| Convex data-plane failure                | Data Recovery Owner | SEV1     | Three consecutive authorized read-only probe failures or at least 5% Convex function failures in 5 minutes     | Declare a data-plane incident, pause destructive maintenance, and preserve redacted evidence                             | Incident Commander immediately, Deployment Owner at 15 minutes                                               |
| Revalidation health failure              | Deployment Owner    | SEV2     | Three consecutive failures or an `unconfigured` health result                                                  | Check the paired secret and endpoint configuration, then rerun the read-only health check                                | Release Owner at 1 hour, Data Recovery Owner at 2 hours                                                      |
| Backup freshness or verification failure | Data Recovery Owner | SEV1     | No completed daily backup by 02:00 UTC, a checksum mismatch, or failed row/file verification                   | Block destructive changes, create a replacement backup, and assess whether the 24-hour RPO is still met                  | Incident Commander immediately, Deployment Owner at 15 minutes                                               |
| Restore drill failure                    | Data Recovery Owner | SEV2     | The monthly drill is late, the target cannot be restored, or row/file checks do not match                      | Mark the backup class unverified, open corrective work, and do not restore production from that artifact                 | Deployment Owner at 1 business day, Release Owner before the next release                                    |
| Secret exposure or missed rotation       | Security Owner      | SEV1     | A secret reaches logs or alerts, or a required rotation misses its due date                                    | Revoke and rotate the affected secret within 24 hours, then run the paired-consumer checks                               | Incident Commander immediately, Deployment Owner at 15 minutes                                               |
| Release health regression                | Release Owner       | SEV2     | A post-release smoke or health check fails before promotion or within the release watch window                 | Stop promotion, select the previous verified artifact, and run the staged rollback procedure                             | Deployment Owner at 15 minutes, Data Recovery Owner for schema or data symptoms                              |
| Pilot capacity warning                   | Deployment Owner    | SEV3     | `pnpm check:pilot-envelope:capacity` returns nonzero because total or published pages reached 400 of 499 (80%) | Stop planned growth in the indicated scope, confirm the deployment identity, and schedule ROUTE-04 before the hard limit | Release Owner at 1 business day, Incident Commander if availability is at risk                               |
| Other capacity or quota warning          | Deployment Owner    | SEV3     | A deployment reaches 80% of another documented planning target or approaches a disable threshold               | Record the measured usage, reduce avoidable work, and schedule capacity review                                           | Release Owner at 1 business day, Incident Commander if availability is at risk                               |

SEV1 means an outage, data-loss risk, or credential exposure. Acknowledge it within 15 minutes. SEV2 means a material degradation or failed recovery control. Acknowledge it within 1 hour. SEV3 means a forecast or planning warning. Acknowledge it within 1 business day.

### Prove provider acceptance without claiming alert coverage

After a registered provider is ready, the signed-in owner may use the
owner-restricted test in Settings -> Email. The action accepts no recipient;
the server derives the durable owner's current account email. Apply the
owner-derived rate limit, and keep credentials, deployment URLs, customer data,
message bodies, and tokens out of visible status and logs.

A `provider_accepted` test result proves only that the tested registered provider accepted
that one probe. It does not prove final inbox delivery or configure an alert
destination, escalation recipient, backup automation, or automatic runtime-
error monitoring. `queued`, `provider_accepted`, `failed`, and `unknown` remain
distinct states.

### Back up data, releases, and recovery configuration

The deployment record must name the owner and destination before the first backup. Backup encryption must use TLS in transit and encrypted storage at rest. Keep encryption keys or secret-manager access separate from the backup artifact, and never place secret values in a backup.

| Backup class                  | Owner               | Scope                                                                                                                                       | Retention                                                    | Encryption                                                                             | Restore procedure                                                                                                                                                                                      | Verification method                                                                                            |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Convex data export            | Data Recovery Owner | All Convex tables and file storage required by the starter                                                                                  | At least one completed artifact per day for 35 calendar days | TLS in transit; encrypted destination storage at rest; keys separate from the artifact | Restore into a throwaway non-production target, check critical row counts and real-record samples, check representative files, then restore a named production target only with explicit authorization | Record source deployment, backup timestamp, checksum, row/file counts, restore duration, and smoke result      |
| Generated release artifact    | Release Owner       | The exact generated tree, `starter.release-lock.json`, package lock, manifests, and release evidence; exclude environment files and secrets | The last 12 release identities and at least 12 months        | Restricted access with encrypted storage at rest and TLS in transit                    | Select the previous verified artifact, create a staged deployment without assigning production domains, run smoke checks, and promote only with target authorization                                   | Compare the artifact checksum and generated-tree digest, then record the staged deployment ID and smoke result |
| Recovery configuration record | Security Owner      | Secret names, consumers, owners, rotation dates, release identities, and verification results; never secret values                          | At least 12 months and the last four rotation records        | Restricted access with encrypted storage at rest and TLS in transit                    | Reissue values from the approved secret source, update every consumer, and run preflight and read-only health checks                                                                                   | Record the change ticket, consumer checks, old-value revocation time, and post-rotation health result          |

### Measure recovery objectives

The recovery time objective (RTO) is the maximum allowed time from an authorized recovery decision to a healthy result. The recovery point objective (RPO) is the maximum accepted age of restored data. These are targets, not production measurements, until a dated drill proves them.

| Recovery scope                                   | RTO target | RPO target                                                                           | Measurement boundary                                                          |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Release rollback after an application regression | 30 minutes | 0 minutes for the immutable release artifact; this says nothing about content writes | From incident declaration to the staged artifact passing smoke checks         |
| Convex tables and file storage                   | 4 hours    | 24 hours, only when the daily backup completed on schedule                           | From restore authorization to verified row, file, and read-only public checks |

If the daily backup is late or missing, the Convex RPO is not met. Record the actual RTO and RPO after every drill and revise the schedule or target when the measured result misses the objective.

### Rotate secrets on a defined schedule

The Security Owner rotates each secret at least every 90 days and within 24 hours of suspected exposure. The Deployment Owner owns the paired-consumer checks. Never print a secret, pass it as a command argument, or include it in a diagnostic value.

Use this sequence:

1. Inventory the secret's consumers, owner, last rotation, expiry, and operational consequence. Record names only.
2. Create the replacement value in the approved secret source, then update every consumer in one change window. Assume no dual-key overlap unless the implementation documents it.
3. Run environment preflight, the relevant read-only health check, and an authenticated smoke path. Check that errors and alerts contain no secret values.
4. Revoke the old value and record the revocation time. Plan reauthentication when rotating `BETTER_AUTH_SECRET`. Rotating an active email provider credential, initially `RESEND_API_KEY`, makes readiness fail until the server detects the replacement; re-run the owner test and activation flow. Treat `CMS_SECRET_KEY` and stored SMTP ciphertext only as legacy migration inventory until separately authorized cleanup proves no remaining consumer.
5. Record the owner, change reference, consumer results, and post-rotation release identity.

### Roll back a release without hiding data changes

The Release Owner may roll back only to a previous verified artifact with a recorded annotated SemVer starter tag and generated-tree digest. A code-artifact rollback does not reverse Convex writes, schema changes, or published content. Route those symptoms to the Data Recovery Owner instead of assuming that an older application artifact restores data compatibility.

1. Declare the release incident, freeze further promotion, and preserve the redacted error and health evidence.
2. Select the previous verified artifact and confirm its release identity, digest, and compatibility with the named target.
3. Create a staged deployment without assigning production domains. Run public route, authentication, read-only Convex, revalidation, and release smoke checks.
4. Promote the same verified artifact only after the named deployment owner authorizes the target operation.
5. Record the incident time, artifact identity, staged deployment ID, checks, promotion result, and any data symptoms for a separate recovery decision.

### Run and verify restore drills

Run a restore drill monthly and after a backup-format, schema, deployment, secret-storage, or ownership change. The drill target must be disposable and separate from production. The first executed drill is a separately authorized operation; this contract does not run one.

1. Select the most recent completed backup and record its source deployment, timestamp, checksum, and release identity.
2. Create a throwaway non-production recovery target from the reviewed starter revision and restore the database and required file storage into it.
3. Compare critical table counts, a sample of real records, representative file reads, and read-only public/admin smoke paths with the source evidence.
4. Measure restore duration and record pass or fail, mismatches, missing files, and every command or console action needed to reproduce the result. A restore that completes with zero rows or missing critical files fails.
5. Remove the disposable target and any local backup copy after the evidence is stored under the approved retention policy.

This contract is complete when the documentation and release claim checks pass. It does not claim that automatic monitoring, automatic alert routing, backups, restore drills, secret rotation, or rollback have been configured or proven. Provider selection, an exact generated-starter target, and explicit authorization remain required before any execution.

## Controlled Vercel Releases

The generated `vercel.json` disables automatic Git deployments from `main`.
Unspecified branches remain enabled, so pull requests still receive preview
deployments without releasing every merge to production.

Treat production as a separate, explicitly authorized operation:

1. Push the release branch and verify its Vercel preview.
2. Merge the reviewed starter commit into `main`; this must not create a new
   deployment.
3. From the exact clean starter revision approved for release, create a staged
   production deployment without assigning the production domains:

   ```bash
   vercel --prod --skip-domain
   ```

4. Inspect that deployment, run the required smoke and error checks, then
   promote the same artifact only with explicit production authority:

   ```bash
   vercel promote <deployment-url-or-id> --yes
   ```

Record the deployment ID, exact annotated SemVer starter tag, generated-tree digest,
verification result, and promotion outcome in the release log. Do not deploy
the `formulacms` source-engine repository or mutate production Convex state as
part of starter publication.

## Required Environment

On your computer, you set none of these by hand, and you do not copy
`.env.local.example`. On the first start, `pnpm dev` writes the Convex
addresses, the three secrets and `BETTER_AUTH_URL` to `.env.local`. It copies
the secrets to the Convex development backend and makes the owner setup code.
See [Quickstart](#quickstart). For a hosted site, follow
[Put your site online](hosting.md).

Required for the Next.js runtime:

| Variable                      | Where                     | Purpose                                  |
| ----------------------------- | ------------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`      | `.env.local` / deploy env | Convex client and server queries.        |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | `.env.local` / deploy env | Convex HTTP actions used by Better Auth. |
| `BETTER_AUTH_SECRET`          | `.env.local` / deploy env | Auth secret; generate per environment.   |

Next.js validates these on Node server startup via `instrumentation.ts`, and
the auth helpers validate them before wiring Better Auth. Missing or placeholder
values fail fast.

Required public-request proof pairing:

| Variable                  | Where                   | Purpose                                                                    |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `CONTACT_IP_PROOF_SECRET` | Next env and Convex env | Proves trusted client keys for contact, password reset, and account setup. |

Password reset fails closed when this pairing is absent or mismatched. The
generated starter preflight compares `.env.local` with the active Convex
deployment without printing either value.

Optional but recommended:

Compatibility notice (2026-08-12): existing installations may continue using
the corresponding `NEXTCMS_*` variables during the migration window. New setup
commands use `FORMULACMS_*`, and supported readers resolve the canonical name
before the legacy fallback without changing each setting's blank-value semantics.

| Variable                 | Where                   | Purpose                                                               |
| ------------------------ | ----------------------- | --------------------------------------------------------------------- |
| `FORMULACMS_OWNER_CLAIM` | Convex env only         | One-time owner setup code; never save it in `.env.local` or metadata. |
| `REVALIDATE_SECRET`      | Next env and Convex env | Shared secret for publish-time ISR cache purge.                       |
| `NEXT_PUBLIC_SITE_URL`   | Next env                | Canonical URL and Open Graph origin fallback.                         |
| `RESEND_API_KEY`         | Convex env              | Enables readiness for the bundled Resend email adapter.               |

`BETTER_AUTH_SECRET`, `CONTACT_IP_PROOF_SECRET`, and `REVALIDATE_SECRET` are
each set in the Next.js environment and in Convex, and the two values must be
equal. If you set one by hand, send the same value to Convex over stdin, never
as a command argument. `pnpm check:preflight` fails when either side is
missing or the values differ.

The owner setup code (`FORMULACMS_OWNER_CLAIM`) lives in Convex only. Never put
it in a URL, a file or a command argument. Until the site has an owner,
`pnpm dev` shows the code in the terminal. Setup uses the code once.

Rotating `FORMULACMS_OWNER_CLAIM` enables the deployment-owner replacement
path. To make a new code, follow step 3 of "By hand" in
[Local setup](local-setup.md), or step 12 of [Put your site online](hosting.md)
for a hosted site. Then open `/setup`, choose
**Replace owner account**, and enter the new code with the successor account's
details. The replacement rebinds the same installation-owner record, removes
the outgoing account's owner authority in the binding transaction, and schedules
fixed-size cleanup of its Better Auth sessions. A competing signup may create
an ordinary Better Auth account, but only the account that completes the
replacement receives CMS access.

## Quickstart

Follow the [Quickstart in the README](../../README.md#quickstart): get the
code, run `pnpm install` and `pnpm dev`, then complete the setup screen.
`pnpm dev` does the local setup by itself. [Local setup](local-setup.md) says
what it does, and how to do the same work by hand when it does not run.

## Convex Quota Envelope

_Checked against the current Convex plan and limits documentation on
2026-07-20._

Free and Starter include the same resource amounts. Free treats them as hard
caps; Starter continues with usage-based charges after the included amounts.
Included usage is measured across the entire Convex team, as the sum of all its
projects.

For at most four active sites in one team, use this 80% planning target. It
leaves 20% shared headroom for uneven traffic and temporary work; it is an
aggregate operating model, not a per-site guarantee.

| Resource         |     Team included | Equal ceiling per site | 80% target per site |
| ---------------- | ----------------: | ---------------------: | ------------------: |
| Database I/O     |        1 GB/month |          0.25 GB/month |       0.20 GB/month |
| Function calls   |          1M/month |             250k/month |          200k/month |
| Data egress      |        1 GB/month |          0.25 GB/month |       0.20 GB/month |
| Database storage |            0.5 GB |               0.125 GB |             0.10 GB |
| File storage     |              1 GB |                0.25 GB |             0.20 GB |
| Action compute   | 20 GB-hours/month |       5 GB-hours/month |    4 GB-hours/month |

Count every production, development, and preview deployment for a site inside
that site's target. Convex usage-limit warning and disable thresholds are set
per deployment, so the thresholds across all deployments must add up to less
than the team objective; assigning the full site target to every deployment
would over-allocate the shared quota.

On Starter, a team spending-limit warning is informational, while its disable
threshold stops every project in the team after overage crosses that amount. A
`$0` disable threshold therefore preserves the included-resource cost ceiling
at the expense of availability.

Database I/O is not the only meter to watch. Convex query-cache hits avoid
database-I/O charges, but explicit function calls and subscription updates
still count as function calls, and bytes sent to clients contribute to data
egress. Review the current [pricing](https://www.convex.dev/pricing),
[limits](https://docs.convex.dev/production/state/limits),
[per-deployment usage limits](https://docs.convex.dev/production/usage-limits),
and [team spending limits](https://docs.convex.dev/dashboard/teams/teams)
before changing thresholds or adding sites.

## Email Setup

Fresh onboarding collects no provider, sender, credential, or test-email data
and creates no email settings row. Absence resolves to the **Console fallback**.
Console sends nothing, returns `not_configured`, and is not production-ready;
it must not log recipients, subjects, bodies, URLs, reset tokens, or invitation
tokens.

FormulaCMS owns the provider contract and build-time static registry:

- a **bundled provider** ships in the official starter; initially this is only
  Resend;
- a **registered provider** has reviewed metadata, server factory, typed non-
  secret configuration, readiness instructions, and contract tests in the
  current application build; and
- exactly one registered provider may be the **active provider** for real
  delivery.

For the bundled Resend adapter, place `RESEND_API_KEY` only in the Convex
deployment environment. Never enter it in Settings, persist it in Convex, or
return any part of it to the browser:

```bash
npx convex env set RESEND_API_KEY
```

The command reads the value from its interactive input. After the server reports
the key as detected, set the sender identity in Settings -> Email, check the
configuration, send the owner-restricted test, and activate Resend only with a
current provider/configuration-version receipt. Changing the provider or a
bound non-secret field invalidates that receipt and requires a new test. Every
send rechecks readiness.

Configure the sending domain according to the registered provider's reviewed
instructions. SPF, DKIM, DMARC, or other required records are provider-specific
and are not inferred by FormulaCMS. A provider-accepted test is not final inbox
delivery.

**Add this provider** opens developer documentation for registering an
OpenCore-supported adapter or private implementation through reviewed
application code, tests, and a release. It does not download packages, change
schema, mutate the running application, or promise that FormulaCMS will bundle
the provider. SMTP is not registered and is not a production fallback.

### Register another email provider

Provider registration is a developer-owned release change, never a dashboard
installation:

1. Add browser-safe metadata in
   `convex/lib/email/providerMetadata.ts`. Keep credentials, environment names,
   factories, SDK clients, and raw provider results out of that module.
2. Add a server-only definition in
   `convex/lib/email/providerRegistry.node.ts` with a typed non-secret
   configuration parser, environment-readiness check, and FormulaCMS adapter
   factory. An Email SDK adapter must keep telemetry disabled, make one SDK
   attempt, and configure no fallback; a private implementation must satisfy
   the same `EmailProviderAdapter` contract and delivery-truth rules.
3. Extend the provider ID and configuration validators in
   `providerState.ts` and the bounded owner API/UI projections. Never use an
   untyped options object or return credential metadata to the browser.
4. Add deterministic registry, state, delivery, authorization, privacy, and
   failure-path tests. Prove the new provider uses the existing FormulaCMS
   consumer boundary and stable event idempotency key, while unknown and
   unregistered IDs still fail closed.
5. Review, build, and release the application. Only then may Settings select
   the registered provider. Do not add runtime package installation, a second
   queue/retry owner, cross-provider fallback, or caller-selected SDK adapters.

## Admin Password Recovery

If reset email is unavailable, a deployment owner can replace a built-in
owner's password from a trusted terminal. The recovery action is internal: it
is callable through the authenticated Convex CLI, but it is not exposed to the
browser or the public Convex API. It refuses every account except the current
durable owner, creates a credential login for an OAuth-only owner when needed,
and revokes all existing sessions in bounded database batches before reporting
success.

Run the dedicated interactive command from the starter directory:

```bash
pnpm admin:reset-password
```

The command explicitly targets the project's personal development deployment
by default, so an inherited production deploy key cannot silently change the
target. Use `pnpm admin:reset-password --prod` for production, or add
`--deployment <selector>` for another deployment. Production and explicit
deployment targets require an exact typed confirmation before the command asks
for the admin email or password.

The password is entered twice without terminal echo. The command refuses piped
or unattended input and does not place the password in shell history, an
environment variable, a temporary file, or the operating system's process
arguments. It invokes the pinned Convex CLI in-process so Convex still applies
its normal authenticated deployment selection. JavaScript necessarily retains
the password briefly in process memory until the command exits; run it only on
a trusted machine and terminal.

A successful result is `{"reset":true,"sessionsRevoked":<count>}`. The count
is the total removed before the command returned; sign in again with the new
password. Treat terminal access to this command as deployment-admin access.

## Author and member identity

Authors are editorial content documents. Their names, localized bylines, body
content, publication, trash, and restore lifecycle are independent of member
accounts, so the installation owner may create and maintain multiple Authors
without creating or selecting a member.

The private `authorMemberLinks` table is retained only as inert migration
evidence for future Team membership work. Community Author creation, editing,
publication, restore, and Post byline defaults do not read or write those rows.
Existing rows must not be inferred from names or email addresses, rewritten by
normal Author operations, or deleted as a side effect of Author removal.

## Locale Setup

The installation owner selects the initial public/content language during
setup. A new site starts with one public language and the Multilingual module
off. The admin interface language is a separate account preference; changing
it does not change Page content or the public language.

Changing the language of a site that operates in one language is not offered
in the admin yet; **Settings → Languages** shows no **Change language…** item
while Multilingual is off. A change that was left unfinished stays open: the
Languages screen offers **Continue**, which reopens the step-by-step workflow
with the Page decisions, preview and **Check if ready**, so it can be finished
or stopped. Stopping a
change leaves the current public site in place. The stop dialog lets the owner
keep target drafts or delete drafts made by that change. It does not silently
delete an earlier retained target Working Draft. If the Languages screen names
a Page blocked by such a draft, stop the change, open that Page from the
blocker, and use **Delete {language} Working Draft** only if the guarded action
is offered. That action deletes the named private draft, not a Published
Snapshot.

To offer several public languages, enable **Multilingual** in **Settings →
Modules**, then adopt it in **Settings → Languages**. There the owner can add a
language, review the impact before revealing a previously used language,
publish each Page language separately, and review the impact before removing a
non-default language. Use **Make default** to start the guarded Default Locale
Migration; the default language cannot simply be disabled or removed. Removing
a language takes its public URLs out of routing, sitemaps, hreflang, and the
language switcher after revalidation, while retaining its content and
publication history. Page publication selects an immutable Published Snapshot
for that Page and language; saving a Working Draft does not change it. Menu
text is saved live for eligible languages, and untranslated Menu nodes are
omitted from that language's public navigation rather than filled from another
language.

To leave multilingual operation, remove extra languages through their guarded
reviews until one remains, choose **Return to one language** in **Languages**,
then disable **Multilingual** in **Modules**. Module disable is refused while
multilingual authority or a language operation is active. These controls do
not edit the code-owned locale definitions or provide an owner-managed editor
for site-wide public strings.

## Privacy And Legal Posture

The starter ships with a zero-cookies public posture: no analytics, trackers,
marketing opt-in, CAPTCHA, or visitor auto-reply are added by default. Auth
cookies are limited to the admin/auth surface.

Legal copy remains site-owner-owned. Add privacy, terms, cookie, consent, or
jurisdiction-specific language only for the deployed site's actual practices.

## Fork Upgrade Playbook

This is the manual procedure for a customer-owned fork. Regeneration creates a
fresh starter and never updates the fork. Treat paths as engine, starter, or
client owned before resolving conflicts.

For a specific release, follow its upgrade file in `upgrades/`; it takes precedence over this general playbook.

Before integrating, record the exact source and target annotated SemVer starter
tags and generated-tree digests for both sides. An untagged checkout is not a
release transition. Stop if the target release declares the path unsupported;
do not infer a supported path from a schema number. Read the exact hop from
`starter.transitions.json` and validate it with:

```bash
node --import tsx scripts/check-release-transition.ts \
  --source-tag <source-tag> \
  --target-tag <target-tag>
```

`engine.manifest.json` separately says schema version 4 is the fresh-install
baseline and supports schema version 3, while schema version 2 is unsupported.

1. Create an upgrade branch from the fork's main branch:

```bash
git switch -c upgrade/<version>
```

2. Read the target release's declared transition class. An **update** needs no
   migration or mandatory action. A **guided upgrade** requires every named
   migration, configuration change, and administrator action. A **breaking
   upgrade** also requires the documented owner-code changes and rollback
   boundary.

3. Merge the upstream `formulacms-starter` release tag. Keep the `starter`
   remote fetch-only and disable its push URL before rehearsing the merge.

4. Resolve conflicts by ownership:

| Tier                         | Rule                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Engine paths                 | Prefer upstream. Conflicts here usually mean the release needs a migration note.                      |
| Starter paths                | Three-way merge deliberately; preserve starter rendering behavior unless release notes say otherwise. |
| Client paths                 | Preserve the fork. On a conflict, keep yours; review upstream changes that merged without a conflict. |
| Shared content-type registry | Keep both sides' entries, then regenerate. Never take the whole file from one side.                   |

The content-type registry is shared: it holds entries from formulacms and
from you. The rule "Engine paths: prefer upstream" does not apply to it. The
registry is the manifest
`convex/lib/contentTypes/content-types.manifest.json` and the files generated
from it: `convex/schema.ts`, `convex/lib/contentTypes/index.ts`,
`convex/lib/contentTypes/inputShapes.ts`,
`convex/lib/contentTypes/starterSelection.ts`, `convex/lib/pages/types.ts`
and `components/content-types/index.ts`. On a conflict in the manifest, keep
the entries from both sides. Do not edit the generated files by hand. Run
`pnpm content-types:sync` to regenerate them, then run
`pnpm content-types:sync --check` and the checks in step 7. If you take the
starter's manifest, regeneration deletes your own content types without an
error. Every other engine path keeps the rule "prefer upstream".

5. Record fork applicability separately as `clean`, `compatible divergence`,
   `manual integration`, or `blocked`. A customized fork can require manual
   integration without changing an upstream update into an upgrade.

6. Treat new presentation, Pages, media, and reference Slice Types as
   optional adoption. They never enter an existing fork automatically.

7. Verify the upgraded fork; do not regenerate it:

```bash
pnpm typecheck
pnpm lint
pnpm test:run
pnpm slices:sync --check
pnpm check:tokens
```

Run the browser services in one terminal. Bind the production server to
`localhost` so the local serving origin matches Next's loopback URL handling:

```bash
pnpm exec playwright install chromium
pnpm exec convex dev --tail-logs disable --start "pnpm exec next start --hostname localhost -p 3001"
```

Install Chromium once for the Playwright version pinned in the project before a
browser gate. `pnpm check:preflight` reports the same command when its managed
Chromium executable is missing; package installation intentionally does not
download a platform-specific browser.

Then run the browser checks in another terminal:

```bash
pnpm check:public
PUBLIC_BASE_URL=http://localhost:3001 pnpm check:e2e
```

`PUBLIC_BASE_URL` is the local server under test.

The credential-free production routing regression exercises the real proxy in
a temporary fixture with fixed EN/FR data and no Convex or environment-file
access:

```bash
pnpm check:public:routing
```

The optional `--hostname 127.0.0.1` mode is a version-scoped diagnostic for
the loopback-origin behavior of the installed Next version; it is not a
permanent assertion that every future Next version must fail that bind.

`convex dev --once` is enough to initialize a disposable deployment,
but browser verification needs the local Convex HTTP endpoints to stay alive.

8. Run the manual browser backstop from the implementation plan before tagging
   the upgraded fork.

## Development performance baseline

Use this protocol before proposing a development-performance budget, changing
bundlers, or attributing slow work to formulacms. It produces comparable
evidence; it does not define a universal target.

Run it only in a separately named, disposable customer application with a local
Convex deployment. Never run it in the canonical source or a generated starter
blueprint. Do not include secrets, `.env.local` values, session cookies, user
content, or deployment URLs in the report. Record the machine name, date,
operating system, CPU and core count, physical RAM, free disk space, host memory
pressure, Node/pnpm/Next/Convex/Playwright versions, lockfile revision,
application revision, local/dev backend class, frontend origin, authentication
state, fixture state, selected routes, and secret-free commands.

Measure one boundary at a time:

1. Start one lifecycle with `pnpm dev`. Record command-to-ready as separate
   Convex-preparation and Next-readiness intervals, then confirm only one live
   Convex watcher remains.
2. On a cold run, request each applicable route once and report first-request
   compilation apart from application or backend time. Do not call that total a
   warm response time.
3. After compilation, collect at least five warm HTTP samples for each route,
   retain every raw sample, and report the median. Use the closest applicable
   set: `/`, `/sign-in`, unauthenticated `/admin`,
   `/api/auth/get-session`, `/robots.txt`, and `/sitemap.xml`. State redirects
   and authentication behavior explicitly.
4. In a browser, measure route-visible readiness with a route-specific selector,
   navigation timing, and the network waterfall. Do not use `networkidle` alone
   as the readiness signal.
5. Record relevant process footprints and OS memory-pressure, compression, and
   swap deltas before and after cold compilation. Treat host pressure as a
   separate observation, not application latency.

Store the raw samples, medians, boundaries, sample count, environment record,
and limitations together. Compare only runs with matching route, fixture,
authentication state, origin, runtime versions, and measurement boundary.
Reproduce any Next cache or Turbopack workaround before considering a bundler
change, then supply like-for-like before-and-after data. This protocol sets no
budget: establish at least two comparable clean-machine baselines and obtain an
explicit owner decision about the supported environment first.

## AI setup

AI is off by default. Switch it on in Settings › Modules, then configure the
assistants in Settings › AI. Set `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` in the Convex environment for the provider you use.
