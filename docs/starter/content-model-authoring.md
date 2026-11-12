# Content-model authoring

formulacms ships examples, not a closed catalog. Site owners can add any
domain-specific content type or Slice Type their project needs through
reviewable code changes.

## Choose the model first

Create a content type when an item needs at least one of:

- its own URL;
- reuse where edits must propagate;
- set queries such as sorting, filtering, pagination, search, or feeds;
- an independent publication or permission lifecycle.

Otherwise, keep the content in a Slice. Menus, redirects, settings, users,
media, and form submissions are system structures rather than content types.

## Create a content type

Hand-author the type as reviewable code:

1. Add a descriptor file under `convex/lib/contentTypes/`. Use the shipped
   `page` and `post` descriptors as the model. Every descriptor needs a
   non-optional localized `title` text field.
2. Add its entry to `convex/lib/contentTypes/content-types.manifest.json`.
3. Run `pnpm content-types:sync`. It regenerates the registry, page types,
   live and staging schema arms, draft input, starter selection, and renderer
   registration from the manifest.
4. Add translated labels for every shipped admin locale.

Fields use the same code-first primitives as slices: text, rich text, image,
link, boolean, select, number, date, datetime, geopoint, embed, table,
relation, group, and list. Public exposure is fail-closed; mark a field public
only when it may cross the public rendering, search, export, or metadata
boundary.


The coding agent must then complete any behavior the domain genuinely needs:
specialized queries or indexes, a specialized renderer, deletion rules,
migrations, seed content, and focused lifecycle tests. A routable pure-form
type (`sliceBody: false` with `routing`) needs a custom public renderer.

Verify:

```sh
pnpm exec convex codegen --typecheck disable
pnpm content-types:sync -- --check
pnpm typecheck
pnpm lint
```


Convex code generation refreshes the derived data-model and API types after
the generated schema union changes.

## Review and edit Slice Types locally

First-release Slice authoring uses the deterministic command-line tool,
`scripts/author-slices.ts`, and the development editor and simulator. The
catalog at `/admin/slices` opens each Type’s editor at `/admin/slices/<type>`;
`/slice-sim/<type>` shows the same editor and sample render. Production keeps
these authoring routes unavailable. Page content editing remains part of the CMS.

Read the command interface without authentication or writes:

```sh
node --import tsx scripts/author-slices.ts --help
```

Run authoring commands only in a separately created local application. Supply
its app root, local app and backend URLs, and protected owner-session cookie
file explicitly. Review model or renderer changes first; apply them with the
exact reviewed revision. `review-create` and `create` use a developer-authored
specification and the current catalog revision. Writes check owner access,
retained content compatibility, current source and installed gates, with
rollback on failure. Archive/reactivate, deletion and cleanup retry use the
same interface. Inspect the result before another command.

The editor retains manual model editing, styling controls, source-image
comparison and snapshot capture. In-admin candidate creation, AI proposals and
the deferred AI workbench are outside this first-release workflow. Source-only
experiments do not make those capabilities available in a generated application.

## Create a Slice Type

Run the [Slice Type reuse triage](slice-reuse-triage.md)
first. Reuse a registered Slice Type only when its editorial job and structural
contract already match exactly; otherwise create a new typed Slice Type by hand:

1. Add the typed descriptor under `convex/lib/slices/`, including its
   validator, defaults, and `aiHint`.
2. Add the local React renderer under `components/slices/`.
3. Add the manifest entry in `lib/slices/slices.manifest.json`.
4. Run `pnpm slices:sync` to regenerate registration.

Then run the slice checks:

```sh
pnpm slices:sync --check
pnpm typecheck
pnpm lint
```


Product, Event, Location, Course, Property, Team Member, and Case Study are
examples only. The user's actual domain requirement determines what gets
created.
