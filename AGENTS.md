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

After generation, every directory identified as a starter—an official generated
release checkout, a temporary generated artifact, or a starter repository—is a
**read-only blueprint**. Do not install dependencies, create or change
environment files, run development, build, Convex, seed, browser-verification,
Git, or deployment commands, or otherwise write into a starter directory.

This read-only rule applies only to an unmodified release checkout used as a
blueprint. In an application the owner created from the starter, such as their
own clone, agents may edit files, commit and run Git commands.

To operate or customize a site, the owner must explicitly name a separate,
non-starter application directory and authorize cloning the pure blueprint into
it. Only that separately named customer application may be changed. Never
reclassify or repurpose a starter in place.

This policy distinguishes two contexts:

- **Official generated release repository:** its provenance is upstream.
  Fixes intended for all formulacms users belong in the private canonical
  formulacms repository; regenerate the official release after that work is
  reviewed and shipped there.
- **Customer-owned application:** its owner controls the separately created
  application and may evolve it. A formulacms regeneration does **not**
  overwrite that application. If the owner later wants upstream changes, they
  adopt them through a reviewed merge, not an automatic replacement.

For ordinary site work in a customer-owned application, supported customization
includes:

- site routes and public presentation;
- design tokens and branding;
- typed Slice Types and their renderers;
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

## Docs

- Use `README.md` as the user-facing setup guide.
- Use `.agents/skills/formulacms/SKILL.md` for formulacms work and read its
  `AUTHORING.md` before creating or changing a content type or Slice Type.
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

`formulacms` is not a Prismic project. The word "slice" in this repository means a
code-first formulacms typed content block backed by Convex validators and rendered
by local React components. Do not use Prismic, Slice Machine, `@prismicio/*`,
custom type JSON, or Prismic documentation when working on formulacms slices,
slice-sim, slice authoring, or slice renderers.

## Environment

- `.env.local.example` is the committed template.
- `.env.local` is the local developer file and must stay gitignored.
- Do not use `.env` for normal starter setup.
- Convex runtime values that backend functions read must be set with
  `pnpm exec convex env set`.
- `BETTER_AUTH_URL` belongs in both `.env.local` and Convex env. Use
  `http://localhost:3000` locally and the deployed site origin in production.

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
pnpm slices:sync --check
pnpm check:tokens
pnpm check:public:images
```

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
