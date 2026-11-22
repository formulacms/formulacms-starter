# Content-model authoring

formulacms ships examples, not a closed catalog. Site owners can add any
domain-specific content type or Block Type their project needs through
reviewable code changes.

## Choose the model first

Create a content type when an item needs at least one of:

- its own URL;
- reuse where edits must propagate;
- set queries such as sorting, filtering, pagination, search, or feeds;
- an independent publication or permission lifecycle.

Otherwise, keep the content in a Block. Menus, redirects, settings, users,
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
5. Restart `pnpm dev`: stop it with Ctrl+C, then start it again. Until it
   restarts, the admin can show raw label keys, such as
   `sidebar.contentType.<type>.plural`, instead of the new type's labels.

Fields use the same code-first primitives as blocks: text, rich text, image,
link, boolean, select, number, date, datetime, geopoint, embed, table,
relation, group, and list. Public exposure is fail-closed; mark a field public
only when it may cross the public rendering, search, export, or metadata
boundary.

A deterministic generator can do steps 1–4 from a JSON specification
instead. Restart `pnpm dev` after it too (step 5).

Write a JSON specification. Event is used here only to demonstrate the generic
format:

```json
{
  "type": "event",
  "labels": {
    "en": { "singular": "Event", "plural": "Events" },
    "fr": { "singular": "Événement", "plural": "Événements" }
  },
  "routing": { "pathPrefix": "events" },
  "capabilities": {
    "blockBody": true,
    "revisions": true,
    "scheduling": true,
    "presence": true,
    "requiresBodyContent": false
  },
  "sharedFields": {
    "startsAt": { "kind": "datetime", "public": true },
    "venue": {
      "kind": "relation",
      "optional": true,
      "public": true,
      "config": { "pageTypes": ["page"] }
    }
  },
  "localizedFields": {
    "title": { "kind": "text", "public": true },
    "summary": {
      "kind": "text",
      "optional": true,
      "public": true,
      "config": { "multiline": true }
    }
  },
  "referenceCard": {
    "title": { "scope": "localized", "field": "title" },
    "subtitle": { "scope": "localized", "field": "summary" }
  },
  "seo": { "schemaOrgType": "Event", "ogType": "website" }
}
```

Every spec requires a non-optional localized `title` text field and translated
labels for every shipped admin locale. Fields use the same code-first
primitives as blocks: text, rich text, image, link, boolean, select, number,
date, datetime, geopoint, embed, table, relation, group, and list. Public
exposure is fail-closed; add `"public": true` only when a field may cross the
public rendering, search, export, or metadata boundary.

Preview and generate:

```sh
pnpm content-type:new -- --spec path/to/content-type.json --dry-run
pnpm content-type:new -- --spec path/to/content-type.json
```

The deterministic generator is create-only. It writes the descriptor and
updates the manifest, registry, type validators, live/staging schema arms,
draft-input union, admin selection, default renderer registration, and
translated labels. It never edits an existing type.

If a run stops part way, the next run refuses and `pnpm check:factories`
fails until you run `pnpm content-type:new -- --recover`. Recovery removes
the half-created type, keeps each file you changed after the run and names
it.

The coding agent must then complete any behavior the domain genuinely needs:
specialized queries or indexes, a specialized renderer, deletion rules,
migrations, seed content, and focused lifecycle tests. A routable pure-form
type (`blockBody: false` with `routing`) needs a custom public renderer.

The default public page of a new type shows only its title and its blocks.
To show the type's own public fields, add `"renderer": "custom"` to the specification before you generate the type; the generator then writes and registers `components/content-types/<type>.tsx`.
For a type that exists already, use the shipped `author` type as the model: write a renderer like `components/content-types/author.tsx`, set `renderer`, `rendererModule` and `rendererExport` in the type's entry in `convex/lib/contentTypes/content-types.manifest.json` as the `author` entry does, then run `pnpm content-types:sync` and `pnpm typecheck`.

Verify:

```sh
pnpm exec convex codegen --typecheck disable
pnpm content-types:sync -- --check
pnpm typecheck
pnpm lint
```

Then run `pnpm content-type:verify -- <type-slug>`. It checks the structure.
It rejects registration drift, missing validators or reference-card logic,
`v.any()` in live descriptors, field-manifest drift, missing labels,
duplicate URL prefixes and definition problems such as a reserved field name.
Similar field sets and more than twelve registered types produce review
warnings rather than hard blocks. The checks of the public renderer contract
run only in the formulacms source repository.

Convex code generation refreshes the derived data-model and API types after
the generated schema union changes.

## Review and edit Block Types locally

First-release Block authoring uses the deterministic command-line tool,
`scripts/author-blocks.ts`, and the development editor and simulator. The
catalog at `/admin/blocks` opens each Type’s editor at `/admin/blocks/<type>`;
`/block-sim/<type>` shows the same editor and sample render. Production keeps
these authoring routes unavailable. Page content editing remains part of the CMS.

Read the command interface without authentication or writes:

```sh
node --import tsx scripts/author-blocks.ts --help
```

Run authoring commands in your own site (the clone you made), on a local
backend. They never run in production or in the formulacms source repository.
Sign the CLI in once with the owner's username and password:

```sh
pnpm blocks:author login --app-root <app> --backend-url http://127.0.0.1:3210
```

The CLI keeps its own session in `<app>/.block-authoring-session.json`
(git-ignored, readable only by you) and renews it by itself, so it does not
sign the browser out. `logout` with the same options ends it. Each command
then takes the app root and the local app and backend URLs. Review model or renderer changes first; apply them with the
exact reviewed revision. `review-create` and `create` use a developer-authored
specification and the current catalog revision. Writes check owner access,
retained content compatibility, current source and installed gates, with
rollback on failure. Archive/reactivate, deletion and cleanup retry use the
same interface. Inspect the result before another command.

The editor retains manual model editing, styling controls, source-image
comparison and snapshot capture. In-admin candidate creation, AI proposals and
the deferred AI workbench are outside this first-release workflow. Source-only
experiments do not make those capabilities available in a generated application.

## Create a Block Type

Run the [Block Type reuse triage](block-reuse-triage.md)
first. Reuse a registered Block Type only when its editorial job and structural
contract already match exactly; otherwise create a new typed Block Type by hand:

1. Add the typed descriptor under `convex/lib/blocks/`, including its
   validator, defaults, and `aiHint`.
2. Add the local React renderer under `components/blocks/`.
3. Add the manifest entry in `lib/blocks/blocks.manifest.json`.
4. Run `pnpm blocks:sync` to regenerate registration.
5. Restart `pnpm dev`: stop it with Ctrl+C, then start it again. Until it
   restarts, the block simulator can answer 404 for the new block and the
   block library can leave it out.

Then run the block checks:

```sh
pnpm blocks:sync --check
pnpm check:blocks:coverage
pnpm typecheck
pnpm lint
```

`pnpm check:blocks:coverage` renders each registered block once with sample
content. It checks that every text, rich text and image field carries the click
marker that the page editor uses. Bind each such field with `<Text>`,
`<RichText>` or `<KitImage>` from `@/components/block-kit`. `pnpm build` runs
this check after `pnpm check:factories` and stops when a field has no marker.
The message names the renderer file, the field and the repair. A block that
cannot render is reported as unverified, and the build continues.

`pnpm check:blocks:render` opens each registered block in the block simulator
in a real browser and clicks every visible text field. One click must put the
caret on the clicked letter, a double click must select the word and a triple
click the paragraph, and the field must not move or scroll. The check also
fails on accessibility (axe) errors, images without alt text, a missing focus
style, sideways overflow and browser console errors. The failure names the
block and the field. GitHub CI runs this check on every pull request. To run
it locally, start `pnpm dev`, then run `pnpm check:blocks:render` in a second
terminal.

The same marker lets the owner edit the field in the page preview. A title,
an inline or basic rich-text field and a one-line `text()` field open in
place: the owner clicks the text and types. A `<Text>` host holds only the
field's text, so put an icon or an arrow next to it, never inside it. A
multiline text field, a full rich-text field, an image and a row of a primary
list (such as the block's own `<Buttons>` labels) are edited in the form.


Product, Event, Location, Course, Property, Team Member, and Case Study are
examples only. The user's actual domain requirement determines what gets
created.
