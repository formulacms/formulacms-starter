# Content-Type and Slice Authoring

Use this reference whenever a request adds or changes formulacms content-model
vocabulary. Read `docs/starter/content-model-authoring.md` before deciding.
That document owns the current generic spec and CLI contract.

## Choose the Right Model

The default answer to “should this be a content type?” is “make it a slice.”
A new content type is justified when at least one is true:

1. Each item needs its own URL.
2. It is reused in at least two places and edits must propagate.
3. It is queried as a set: sorted, filtered, paginated, searched, or fed.
4. It has an independent publish, schedule, or permission lifecycle.

Return one explicit verdict before coding:

- **Slice** — page-owned content or presentation.
- **Extend an existing content type** — the entity already exists and only its
  schema needs a legitimate field.
- **Vendor a recipe** — reusable owned code should be copied into the repo.
- **New content type** — a distinct document passes the test.

Warn when the proposed type substantially overlaps an existing type or pushes
the registry beyond roughly twelve types. A user may explicitly override the
warning; the owner remains the modeler of record.

Forms and system structures are never registry content types. Menus, redirects,
settings, submissions, users, and media keep their bespoke models.

## Author a Content Type

Content types are code-first documents on the `pages` table. There is no
runtime type builder or plugin system. The owner may add any justified domain
model; the starter's shipped types are examples, not a closed catalog.

Before coding, define:

- immutable kebab-case type slug and singular/plural labels;
- routable document or non-routable reference document;
- unique path prefix when routable;
- shared locale-agnostic fields versus localized fields;
- public fields (`.public()`) versus fail-closed admin-only fields;
- capabilities: slice body, revisions, scheduling, presence, required body;
- reference-card identity and published URL behavior;
- set queries, indexes, relations, and deletion constraints;
- migration or seed impact for existing deployments.

Then trace and update every live projection:

In a starter application, add the descriptor and its mechanical projections by
hand, as described in `docs/starter/content-model-authoring.md`.


4. Trace `convex/cms/pages.ts` create, duplicate, update, staging, publish,
   restore, and shared-field paths. Remove hard-coded assumptions or add the
   new discriminant branch; a descriptor alone is not sufficient.
5. Add bespoke queries, indexes, deletion constraints, rendering, or seed
   behavior required by the actual domain. Routable slice-bodied types use the
   default Slice renderer unless the domain needs a specialized renderer.
   A routable pure-form model is scaffolded too, but verification stays red
   until a deliberate custom public renderer is registered.
6. Confirm the generic editor, sidebar, picker, list filters, command palette,
   and current-profile authorization derive from the selected registry entry.
7. Trace search, sitemap, canonical/SEO, revalidation, references, media,
   revisions, scheduling, publishing checks, and indexes according to the
   contract defined above.
8. Add seed or sample content only when the app contract requires it.
9. Run:

```sh
corepack pnpm exec convex codegen --typecheck disable
corepack pnpm content-types:sync -- --check
corepack pnpm typecheck
corepack pnpm lint
```

Convex codegen requires explicit task authority. When it is not authorized,
complete the source work that can be proved without it and report generated
bindings and downstream checks as pending rather than editing them by hand.

Search the tree for every existing type slug and compare the closest matching
routable or reference type. Compile-time drift guards help, but do not replace
consumer tracing.

Minimum proof includes:

- descriptor/schema arm accepts valid data and rejects cross-type fields;
- create, edit, language-transition, publish, duplicate, and restore paths as
  applicable to the selected core or Multilingual profile;
- permission enforcement for the new type;
- route, canonical metadata, renderer, and unpublished behavior if routable;
- relation resolution and no draft leakage if referenceable;
- public exposure includes only fields marked `.public()`;
- if the renderer formats numbers, currency, or dates, test with a
  non-default `renderLocale` — a test that only exercises the runtime's
  default locale can pass while the renderer silently ignores it;
- focused tests, `corepack pnpm typecheck`, and `corepack pnpm lint`;
- full suite for schema or shared CRUD changes.

## Examples Are Not Catalog Entries

Treat Event, Product, Location, Team Member, Course, Property, and Case Study as
equally ordinary examples. None has privileged system behavior. Start from the
user's domain contract, choose fields and capabilities from evidence, and
create the type only when it passes the document test.

For example, a Product may need SKU and minor-unit price as shared fields plus
localized title/description; an Event may need a shared start instant and
venue relation plus localized title/summary. Those examples demonstrate field
placement. They do not constrain what formulacms can model.

## Author a Slice

Run ADR-0044 reuse triage before creating a Slice Type: reuse a registered type
unchanged when its editorial job and structural contract match exactly; never
mutate an existing schema to absorb a different design; only a structural
sibling or genuinely new reusable contract earns a new type. Keep pure styling
out of the descriptor.

- A Slice is one independently placeable section with one editorial job; a
  multi-section design is a page to decompose.
- Styling-only differences stay in tokens/CSS. Structural differences become
  sibling Slice Types that may share descriptor groups.
- A Slice reference depicts that section only, never a full page.

1. Inspect field primitives, shared fields, render helpers, tokens, and similar
   slices for vocabulary and implementation precedent.
2. Add the typed descriptor under `convex/lib/slices/`, including validator,
   defaults, and `aiHint`.
3. Add the local React renderer under `components/slices/`.
4. Add the manifest entry in `lib/slices/slices.manifest.json`.
5. Run `corepack pnpm slices:sync` to regenerate registration.
6. Align sample data, thumbnail, and picker metadata.
7. Run:

```sh
corepack pnpm slices:sync --check
corepack pnpm typecheck
corepack pnpm lint
```

Generated slices require human review before acceptance.
