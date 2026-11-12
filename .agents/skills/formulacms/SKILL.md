---
name: formulacms
description: Guides implementation, maintenance, review, release work, and troubleshooting in formulacms source repositories and owner applications. Use for formulacms modules, admin or public behavior, Pages and Localized Content, typed content types and slices, generated starters, release projection, or formulacms project conventions.
---

# formulacms

Use this skill as the general entry point for formulacms work. Keep product,
artifact, and authority boundaries explicit, then route specialized work to the
narrowest available skill or repository reference.

## Start

1. Find the project root containing `package.json`, `CONTEXT.md`, and
   `CLAUDE.md`; read the nearest `AGENTS.md` first.
2. Read `CONTEXT.md` for current vocabulary and the relevant `CLAUDE.md`
   sections and accepted ADRs for implementation rules.
3. Classify the target as source repository, generated blueprint, or separately
   created owner application. Do not infer that identity from a similar name,
   sibling directory, environment file, or earlier task.
4. Inspect the working tree and preserve unrelated owner changes.
5. Define the actor, observable outcome, non-goals, authority boundary, and
   proportional proof before changing code.

In the FormulaCMS source repository, follow its current release plan, security
map, and execution ledger. Retained plans, handoffs, unchecked boxes, and
source presence are evidence or backlog, not execution authority. Generated
starters contain only the planning guidance explicitly selected for them.

## Route the Work

- For substantial code changes, planning, handoffs, or completion claims, load
  `goal-integrity` and keep the claim no broader than the evidence.
- For creating, seeding, theming, localizing, QAing, or handing off a separately
  created app, load `formulacms-app-creation-audit`.
- For Convex code, first read `convex/_generated/ai/guidelines.md`, then load
  the narrow Convex skill matching the task.
- For Next.js code, read the relevant installed guide under
  `node_modules/next/dist/docs/` before editing; this repository's Next.js
  version is not safely covered by generic remembered conventions.
- For a new content type, reusable entity, domain model, or slice, read and
  follow [AUTHORING.md](AUTHORING.md).
- For a design reference, first decide whether it maps to an existing Slice
  Type, a new structural Slice Type, or only token/CSS changes. A screenshot or
  Figma frame is evidence, not permission to copy another site's assets or
  create a new schema.
- For a hard bug, diagnose and reproduce before implementing a fix. Search
  current primary documentation and upstream issue trackers when the behavior
  may be version-specific.

For external documentation, use the repository order: installed skill,
provider documentation or MCP, then Context7 only as a fallback.

## Product and Artifact Model

- formulacms is a self-hosted, fair-source, full-stack Next.js + Convex CMS. It
  is not headless, SaaS, Prismic, or an open-source project.
- FormulaCMS has one generated distribution. `artifact: "community"` is a
  legacy-compatible internal release identity, not a second product variant.
  Team is later capability/module state, not another starter or lockfile.
- The source repository is for development and deterministic generation. Never
  deploy it or use it as an application target.
- A generated starter, release checkout, or temporary generated tree is an
  immutable blueprint. Never patch, install, build, run, seed, connect, or
  deploy it.
- Only a separately created, non-starter owner application may be a runtime or
  deployment target, and only after the owner explicitly names the directory,
  hosting project, backend project/deployment, domain, environment, and allowed
  operations required by the task.
- Keep source proof, generated-blueprint proof, created-app runtime proof,
  deployment, published release, and production proof separate in reports.

## Current Architecture

- Fresh Community has one durable installation owner and one fixed code-defined
  `admin` role. Authentication, a legacy admin assignment, and ownership are
  separate facts. Members, invitations, configurable roles, seats,
  entitlements, and collaboration are compatibility or later Team concerns,
  not fresh Community authority.
- The source contains required and optional first-party modules. Code presence,
  installation, enabled state, readiness, caller authorization, and active
  state are distinct. Never expose, enable, seed, or include an unfinished
  optional capability merely because its source exists.
- Core has one changeable public/content language and an independently selected
  admin language. Concurrent public languages come from the Multilingual
  module (M05). Internationalization is first-class (owner directive
  2026-09-22): M05 ships and is tightly integrated, is never excluded to
  shrink a release, and is activated by the owner.
- A Page owns shared identity and structure. Localized Content owns one locale's
  Working Draft and publication lifecycle. Public delivery reads the selected
  immutable Published Snapshot; saving or restoring a draft must not change the
  public result.
- FormulaCMS owns the provider-neutral email contract. Console is a truthful
  non-delivering fallback, Resend is the sole bundled production adapter, and
  SMTP is retired from reachable paths. Providers are registered through
  reviewed code/build/release work, never installed at runtime. Provider
  acceptance is not inbox delivery.
- Compatibility validators and stored shapes may remain without being callable
  or authoritative. Never delete or narrow them without a separately reviewed
  migration boundary.

For legacy slice data, the owner's October 18, 2026 amendment supersedes this migration prerequisite. Removal still requires authorized scope and quality/review gates; parked Contact, Search and CTA may be deleted only if they block an approved unit. Existing guards and the A2 hold remain.

## Content and Presentation Invariants

- A slice is a code-first typed content block: Convex descriptor and validator,
  local React renderer, `aiHint`, manifest/registry entry, preview data, and
  thumbnail/reference evidence as applicable. Never introduce Slice Machine,
  `@prismicio/*`, or Prismic custom-type JSON.
- Run `docs/adr/0044-slice-scope-granularity-and-reuse-triage.md` before
  creating a Slice Type. Reuse a registered type unchanged only for an exact
  editorial-and-structural contract match; never extend an existing schema to
  absorb a different design.
- Never use `v.any()` for slice or document content.
- Put editor-controlled meaning and structural intent in fields; keep color,
  spacing, type scale, radius, shadows, and other styling in tokens/CSS.
- Runtime AI may change content within existing typed structures only. Schema
  and code generation belong to the developer/build loop with human review.
- Content types must earn independent document semantics. Shipped content types
  and slices are examples, not a closed catalog.
- User-facing admin copy must describe outcomes in plain language rather than
  exposing implementation jargon.

## Release and Change Workflow

1. Trace the real consumer from entry point through registration, module gates,
   authorization, persistence, rendering, release projection, and visible
   result as applicable.
2. Search for existing primitives, helpers, components, and precedent.
3. Implement the smallest coherent change without speculative infrastructure.
4. For content-model work, follow the complete projection checklist in
   [AUTHORING.md](AUTHORING.md); never stop after adding only a descriptor.
5. Do not hand-edit generated Convex bindings or generated release trees. Use
   an authorized generator and review its diff.
6. For release work, use the sole distribution manifest, overlay, ship list,
   and canonical release lock. Do not add artifact selection, a Team projection,
   or a second recipe lock.
7. Verify at the public boundary of the actual claim. Use Chrome DevTools for
   browser inspection.

Useful source checks, selected in proportion to the change:

```sh
corepack pnpm slices:sync --check
corepack pnpm vitest run path/to/focused.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

Convex codegen, a development backend, environment changes, real sends,
generated-app runtime work, builds, deployments, commits, pushes, and releases
need their own applicable authority; do not infer it from a source-edit request.
Run the full suite when shared infrastructure or risk warrants it. Report newly
added tests separately from the existing suite and disclose inherited failures
and anything not run.

## Catalog Discovery

The catalog retains its historical `nextcms-catalog` MCP namespace. When that
server is available:

1. Read `nextcms://catalog` or call `search_catalog`.
2. Inspect a candidate with `get_catalog_asset` or its asset resource.
3. Treat results as metadata only. Never infer installation, entitlement, or
   write authority that the result does not explicitly provide.

When MCP is unavailable, inspect `lib/slices/slices.manifest.json` and
`convex/lib/slices/index.ts`. Do not copy catalog entries into this skill.

## Examples

- “Build this Figma section” -> reuse triage, typed slice or token/CSS decision,
  a check of the rendered page, and human review.
- “Add events with dates, venues, and detail URLs” -> content-type triage, then
  the complete typed Event projection only when justified.
- “Enable Team in the starter” -> reject the second-distribution framing and
  inspect the reviewed Team capability/module authority instead.
- “Add another email provider” -> register it behind the FormulaCMS contract;
  do not add runtime installation, fallback routing, or provider-specific
  consumers.
- “Deploy this starter” -> stop: a starter is an immutable blueprint; require
  an explicitly identified separately created owner application.
