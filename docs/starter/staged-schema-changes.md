# Staged schema changes

Use Convex's built-in `TableDefinition.staged()` to prepare a narrowing change
without making deployment wait for a large existing-table scan. This procedure
uses Convex 1.48.0 and the already installed `@convex-dev/migrations` 0.3.7.
It changes one application-owned table at a time, with an operating scope of
roughly one million documents. That scope is not a validation-time guarantee;
measure progress on the authorized application.

**Convex staged validators are unrelated to formulacms ADR-0041 staged
publication overlays**, `convex/lib/publishing/staging`, or `stagedOverlayExtras`.
They do not create drafts, publish content, or backfill documents.

## Before starting

Work in a separately created owner application with explicit authority for its
exact backend. The formulacms source repo and generated starters are not
runtime targets. This document grants no production, cloud, hosting or migration
authority. Verify the target before every deploy or migration invocation; bare
`npx convex deploy` can select production. The commands below assume the target
has already been explicitly authorized and selected. SSV-1 rehearses them only
against a seat-owned throwaway loopback backend, using child-process-only
self-hosted selection and freshly generated in-memory credentials.

Inventory all writers, including scheduled workers, imports, admin actions,
legacy clients and backfills. Keep readers compatible with both stored shapes
until promotion. Keep a recovery plan and before-images appropriate to the
actual content change: relaxing a validator cannot restore deleted fields.
Do not automatically run migrations during deployment.

For generator-owned tables, follow the `@content-type-codegen` markers in
`convex/schema.ts` back to their generator inputs. Never hand-edit between
those markers. The current content-type registration generator rebuilds union
validators from registered descriptors; its input format has **no staged
validator setting**. Changes to descriptor validators can widen the enforced
shape, but cannot represent an independent staged target. Staging such a table
requires a separately reviewed generator-input extension first. This runbook
does not authorize that extension or a hand-written staged union alongside
generated output. Ordinary application-owned tables can use the steps below.

## 1. Widen, then switch writers

The example table is illustrative; SSV-1 adds no real `documents` table. Suppose
old documents contain string `value`s and an optional `legacy` field. First
make the enforced validator accept old and new values:

```ts
// convex/schema.ts — illustrative application-owned table
import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  documents: defineTable({
    label: v.string(),
    value: v.union(v.string(), v.number()),
    legacy: v.optional(v.string()),
  }),
})
```

Deploy the widening before writers rely on it:

```sh
npx convex deploy
```

Update every writer to store numeric values and omit `legacy`; retain tolerant
reads for existing strings. Deploy the compatible writers. The validator in
`defineTable` remains the enforced contract: it must accept every intermediate
backfill write. For a new required field, introduce it as optional before
writers populate it. For removal of a required field, make it optional first.
Never turn off `schemaValidation` to make an intermediate write succeed.

## 2. Backfill through the existing migrations component

The application config already registers the migrations component. Reuse that
registration; do not add another component or a custom migration runner. Define
a developer-owned module such as `convex/schemaMigration.ts`. Use the
application's mutation wrappers where they preserve CMS write invariants;
Pages/publication changes require their own reviewed migration plan.

This example uses the existing `Migrations` client and its internal runner:

```ts
import { Migrations } from "@convex-dev/migrations"
import { components, internal } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { internalMutation } from "./_generated/server"
import schema from "./schema"

const migrations = new Migrations<DataModel, typeof schema>(
  components.migrations,
  { internalMutation, schema }
)

export const normalizeValues = migrations.define({
  table: "documents",
  migrateOne: async (ctx, doc) => {
    if (typeof doc.value === "string" && doc.value.trim() === "") {
      throw new Error("Empty numeric value needs a content decision")
    }
    const value = typeof doc.value === "string" ? Number(doc.value) : doc.value
    if (!Number.isFinite(value)) throw new Error("Invalid numeric value")
    if (doc.value !== value || doc.legacy !== undefined) {
      await ctx.db.patch(doc._id, { value, legacy: undefined })
    }
  },
})

export const run = migrations.runner(internal.schemaMigration.normalizeValues)
```

`run` is an **internal mutation**, callable by a trusted deployment
administrator through the CLI/dashboard, not an anonymous application client.
Do not expose an unguarded public runner. If starting it from an application
button, use the application's existing administrator permission guard before
calling the internal runner; the source membership-backfill entry point uses
`requirePermission(ctx, "members:manage")` before `ctx.runMutation(...)`.
The starter excludes that source migration module, so implement the guarded
entry point in owner code when needed. Nothing starts on deploy.

Deploy the definitions, preview a batch, then explicitly start the migration:

```sh
npx convex deploy
npx convex run schemaMigration:run '{"dryRun":true}'
npx convex run schemaMigration:run '{}'
npx convex run --component migrations lib:getStatus '{}'
```

The preview rolls back its batch; read its result before starting real work.
The component tracks cursors and batches. Check status until this migration is
`success`, and investigate `failed` or `inProgress` instead of treating the
initial runner response as completion. Verify the intended postcondition as
well: no strings and no `legacy` fields remain. Do not replace the component
with an unbounded table scan inside one mutation. Fix invalid content explicitly
rather than silently coercing blank strings or inventing replacement values.

`Doc` and the document passed to `migrateOne` still describe the **enforced**
validator. Staging later does not narrow their TypeScript types. Keep the
backfill compatible with that enforced type and idempotent so retries are safe.

## 3. Stage the narrow target and wait

Keep the widened `defineTable` body unchanged. Add only the staged changes:

```ts
  documents: defineTable({
    label: v.string(),
    value: v.union(v.string(), v.number()),
    legacy: v.optional(v.string()),
  }).staged({
    value: v.number(),
    legacy: undefined,
  }),
```

Omitting `label` keeps its current validator. Setting `legacy` to `undefined`
requires its absence; it does not delete data. To allow a field to remain,
use an optional validator. For nested objects, restate the **whole desired
object**, including fields to retain. A supplied field validator replaces that
entire field's validator.

For a union table, supply a **complete** `v.union(...)` staged validator,
including every retained arm and field; a per-variant partial field map is
unsupported. A full `v.object(...)` also describes an entire target rather than
a field patch. Do not introduce `v.any()` as an escape hatch.

```sh
npx convex deploy
npx convex deploy --dry-run
```

Read the table's staged status: **validating** (with progress), **validated**, or
**failed** (with its first error). A small table may reach validated before the
first check. Wait for validated; there is no fixed sleep duration for a large
table. The dry run observes status and previews a push; it does not promote or
repair data.

During this period, writes still enforce the widened validator. A legacy write
can succeed and mark staged validation failed, even after a successful scan.
Stop such writers and repair **all** offending documents. The first reported
error is not an inventory. A one-time migration already marked successful will
not automatically revisit later bad writes: after fixing the writer, explicitly
restart the idempotent migration when appropriate:

```sh
npx convex run schemaMigration:run '{"reset":true}'
npx convex run --component migrations lib:getStatus '{}'
npx convex deploy
npx convex deploy --dry-run
```

Keep the same `.staged()` target when retrying: redeployment retries a failed
validation from the start. Wait for validated again. Keep writers stable between
that check and promotion; later invalid writes can revoke the successful result.

## 4. Promote the validated target

Immediately recheck with `npx convex deploy --dry-run`. Replace the enforced
body with the complete validated target and remove `.staged()`:

```ts
  documents: defineTable({
    label: v.string(),
    value: v.number(),
  }),
```

In that same promotion change, retire the completed example migration and its
runner (and any app entry point), or adapt retained migration code to the new
enforced types. The example's `doc.legacy` access and `legacy` patch are invalid
once that field is removed. Do not leave an old backfill callable against a
narrowed schema. Regenerate application bindings and typecheck all consumers
before deploying; remove legacy read branches when they are no longer needed.

```sh
npx convex deploy --dry-run
npx convex deploy
```

The promotion preview should report that it applies the staged schema **without
scanning the table**. Deploy reuses completed validation when the enforced
target accepts every document accepted by the validated staged target; exact
promotion is the clearest case. Confirm the outcome, then verify that new writes
meet the narrow contract. Do not ship a permanent `.staged()` after promotion.

A pending or failed result cannot justify skipping validation. Early promotion
may block on a full scan or fail. Removing or changing staging can discard its
progress and prompt for confirmation. Do not blindly add
`--allow-unstaging-schema` to suppress that warning. Repeating an unchanged
running/validated staged definition preserves its progress; other changes may
restart validation. Review a changed target and its new status before promotion.
If deferring promotion, retain compatible code and document the outstanding
staged validation; removing staging later is an explicit decision.

## Limits and evidence

This procedure covers one application-owned table at a time. Coordinated
multi-table narrowing, component-owned `components.*` tables, and partial
per-variant union staging require separate plans. Roughly one million documents
is a planning scope, not a claim that SSV-1 loaded or timed that many rows.

The seam tests prove compilation of object/union staging, enforced document and
migration types, and unchanged write enforcement in convex-test 0.0.65.
Convex-test does not implement background staged validation. Only the isolated
real-backend rehearsal supplies status/failure/retry/promotion evidence; those
backend internals are not reproduced in tests.

Prior art checked on 2026-10-28: [Convex staged validators](https://docs.convex.dev/database/schemas#staged-validators)
and the existing [migrations component](https://www.convex.dev/components/migrations).
The [convex-js issue search](https://github.com/convex/convex-js/issues?q=is%3Aissue+staged)
returned no staged issues; the [convex-backend search](https://github.com/convex/convex-backend/issues?q=is%3Aissue+staged)
returned only an unrelated sensitive-data discussion. No upstream workaround is
needed for this built-in mechanism. Searches are time-bound, not a guarantee
that no issue exists. Recheck upstream when upgrading the pinned libraries.
