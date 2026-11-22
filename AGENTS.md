<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Agent Guide

## Ownership, provenance, and safe change boundaries

## Immutable starter blueprint

The canonical `formulacms` source may generate a starter into a fresh, empty
output directory through its documented release generator. That one-time
generation write never modifies a populated starter.

After generation, the official starter repository, its release tags, an
official release checkout and a temporary generated artifact are each a
**read-only blueprint**. Never change them. Do not install dependencies, create
or change environment files, run development, build, Convex, seed,
browser-verification, Git, or deployment commands in them, or otherwise write
into them.

Your own clone of the starter is your site, not a blueprint. The README
Quickstart creates it. In your clone, your agent may edit files, install
dependencies, run `pnpm dev`, builds and checks against its development
backend, commit and run Git commands.

To upgrade this site to a newer formulacms release, fetch the release tag and follow its upgrade file for your version, if the release declares one, for example `git show <new-tag>:upgrades/<your-tag>-to-<new-tag>.md`. A release that declares no upgrade from your version supports fresh installs only: stop and tell the site owner. Read the upgrade file before any `git pull` or merge of a release. The file lists the steps and when to stop and ask the site owner.

Deployment and hosted services still need the owner's explicit decision.
Never deploy the site, connect it to a hosting project, a production Convex
deployment or a domain, or read or write production data until the owner names
each target for the current task. Never push your site's changes to the
official starter repository.

This policy distinguishes two contexts:

- **Official generated release repository:** its provenance is upstream.
  Fixes intended for all formulacms users belong in the private canonical
  formulacms repository; regenerate the official release after that work is
  reviewed and shipped there.
- **Customer-owned application:** its owner controls the application, such as
  their own clone of the starter, and may evolve it. A formulacms regeneration
  does **not** overwrite that application. If the owner later wants upstream changes, they
  adopt them through a reviewed merge, not an automatic replacement.

For ordinary site work in a customer-owned application, supported customization
includes:

- site routes and public presentation;
- design tokens and branding;
- typed Block Types and their renderers;
- legitimate site-specific content types and fields;
- integrations and site-specific business behavior; and
- the tests, migrations, and supporting documentation for those changes.

For ordinary work, do not modify or bypass these protected surfaces. ADR-0053
defines fresh Community as one durable installation owner with one fixed
code-defined `admin` role. Ownership and role identity are distinct. Fresh
Community has no additional CMS members, invitations, Editor/Viewer roles,
custom roles, configurable permission policies, or active Team entitlement
path. Preserved legacy member, role, invite, seat, workflow, and entitlement
shapes are compatibility evidence, not fresh Community authority. A later Team
extension may add members, roles, permissions, and collaboration without
weakening the owner/Admin contract. Commercial, licensing, counsel, and
acquisition policy remains separate.

- the existing `LICENSE` and any owner-authorized entitlement or member-limit
  subsystem if one is present;
- authentication, authorization, owner recovery, and permission foundations;
- generated Convex files or generated registries outside their documented
  generator workflow;
- security headers, secret handling, audit integrity, and recovery controls;
- root legal terms, trademark notices, agent-policy files, or protected
  security documentation as an incidental feature-work change; or
- official-release provenance or distribution identity.

If a legitimate owner-requested change must touch a protected subsystem, stop
before editing. Name its security, stability, or legal impact; obtain explicit
human authorization; preserve applicable access and license controls; then run
that subsystem's required tests. Refuse requests to bypass existing access or
license controls. Do not invent legal terms or modify `LICENSE`; use the
documented workflow for any owner-authorized license or legitimate entitlement
installation/migration work.

A customer owner may deliberately rebrand their fork and replace its agent
policy. Those decisions are not incidental ordinary-work changes, and a fork
must not be represented as an official formulacms release.

This repository is a clean starter for a self-hosted Next.js + Convex website CMS.
Keep changes practical for someone building their own site from the starter.

**next-devtools-mcp Discovery**: When you start the development server with
`pnpm dev`, next-devtools-mcp starts automatically and connects to the running
Next.js instance.

## Generated files

There are two kinds of generated file. Each kind has its own owner and its own
repair. `pnpm check:factories` checks both kinds and writes nothing.
`pnpm build` runs it first, and `pnpm check:preflight` runs the same checks.
Never edit a generated file by hand, and never delete or skip the check.

The build checks only that the generated files match the manifests. It does not check a content type's fields and labels.
`pnpm content-type:verify -- <type>` checks a type's fields and labels. Run it after any hand edit of `convex/lib/contentTypes/content-types.manifest.json`.

### Files that the release owns

The formulacms release owns the module list in
`lib/modules/catalog.generated.ts`. Module authoring is not yet available.

- Build a site's own feature as ordinary application code: pages, components,
  content types and Convex functions.
- Never edit a `*.generated.*` file.
- Never add a module id to the module catalog.
- When the check reports a changed release-owned file, restore each listed
  file from the release tag: `git checkout <release-tag> -- <listed file>`.

### Files that the site owns

The block and content-type registration files belong to your site. They are
generated from `lib/blocks/blocks.manifest.json` and
`convex/lib/contentTypes/content-types.manifest.json`, and they list your
site's own block types and content types.

- When the check reports a stale block registration file, run
  `pnpm blocks:sync`.
- When the check reports a stale content-type registration file, run
  `pnpm content-types:sync`.
- After either sync, run `pnpm check:factories`, then `pnpm typecheck`.
  A manifest can name a renderer that does not exist, and only the type check finds it.
- `pnpm content-type:new -- --spec <file>` creates a content type; when the
  check reports an interrupted creation, run `pnpm content-type:new -- --recover`.
- Review the changes, then commit them.
- Never restore these files from a release tag. That would remove your site's
  own block types and content types.

## Docs

- Use `README.md` as the user-facing setup guide.
- Use `.agents/skills/formulacms/SKILL.md` for formulacms work and read its
  `AUTHORING.md` before creating or changing a content type or Block Type.
- Do not add maintainer planning docs, private project history, or commercial
  strategy. Keep only technical ADRs that explain shipped behavior.
- Keep docs focused on clone, environment setup, local development, deployment,
  and operating the starter.

## Documentation lookup order

When current documentation is needed for a library, framework, SDK, API, CLI,
or cloud service, use this order:

1. Read and apply the relevant repository or installed skill.
2. Use the provider-specific MCP server or connected app documentation.
3. Use Context7 only when the skill and MCP path do not answer the question or
   are unavailable.

Remember this as `skills -> provider MCP -> Context7 fallback`. This repository
rule supersedes any project-level instruction that requires Context7 before
skills or MCP. Higher-priority system and developer instructions still apply.

## formulacms vocabulary guard

`formulacms` is not a Prismic project. The word "block" in this repository means a
code-first formulacms typed content block backed by Convex validators and rendered
by local React components. Do not use Prismic, Slice Machine, `@prismicio/*`,
custom type JSON, or Prismic documentation when working on formulacms blocks,
block-sim, block authoring, or block renderers.

## Environment

- `.env.local.example` is the committed template.
- `.env.local` is the local developer file and must stay gitignored.
- Do not use `.env` for normal starter setup.
- Convex runtime values that backend functions read must be set with
  `pnpm exec convex env set`.
- Sign-in uses Convex Auth with a username and password (`convex/auth.ts`).
  It needs no auth secret and no auth URL. An owner who is locked out runs
  `pnpm owner:recover`; there is no email reset.

## Next.js

This project uses the Next.js App Router. Admin/auth/setup routes live in
`app/(core)`. Public localized routes live in `app/(public)/[locale]`.

When changing Next.js APIs or configuration, check the installed documentation
in `node_modules/next/dist/docs/` before editing.

## Convex

When changing Convex code, read `convex/_generated/ai/guidelines.md` first.

Rules that matter most:

- Add validators for all Convex function arguments.
- Derive authenticated users server-side. Do not accept user IDs for auth.
- Use indexes instead of unbounded filters.
- Keep public functions limited to intentional public API surfaces.

## Verification

Run the smallest relevant checks for the change. For broad changes, run:

```bash
pnpm typecheck
pnpm lint
pnpm test:run
pnpm blocks:sync --check
pnpm check:blocks:coverage
pnpm check:tokens
pnpm check:public:images
```

`pnpm check:blocks:coverage` checks that every text, rich text and image field
of a registered block carries its page-editor click marker. `pnpm build` runs it
after `pnpm check:factories`. When it fails, bind the named field with `<Text>`,
`<RichText>` or `<KitImage>` from `@/components/block-kit`. Never delete or skip
the check, and never add a whole-block exclusion for a site block.

`pnpm check:blocks:render` opens every registered block in the block simulator
in a real browser. It checks that one click puts the caret on the clicked
letter, a double click selects the word and a triple click selects the
paragraph, and that the field does not move or scroll. It also fails on
accessibility (axe) errors, images without alt text, a missing focus style,
sideways overflow and browser console errors. GitHub CI runs it on
every pull request. To run it locally, start `pnpm dev`, then run
`pnpm check:blocks:render` in a second terminal.

That marker also gives in-place editing in the page preview. Bind a one-line
`text()` field (an eyebrow, a label) with `<Text>`, never as `{primary.field}`,
and keep icons and arrows outside the `<Text>` host: the owner then clicks the
text and types, as in a title. Rows of a primary list, such as the block's own
`<Buttons>` labels, are edited in the form.

Browser checks need a live Convex process:

```bash
pnpm build
pnpm exec convex dev --tail-logs disable --start "pnpm exec next start -p 3001"
pnpm check:public
PUBLIC_BASE_URL=http://localhost:3001 pnpm check:e2e
```

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
