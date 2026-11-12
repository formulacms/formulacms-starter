# Website CMS Starter

A self-hosted Next.js + Convex starter for building an editable marketing site.

The starter includes:

- A public website with a home page, navigation, SEO, and responsive slices.
- An admin area for pages, media, menus, and settings.
- Convex as the backend and Better Auth for admin authentication.
- Provider-agnostic email for password reset and contact messages.

## Requirements

- Node.js 22 or newer.
- pnpm 11.
- A Convex account or local Convex dev deployment.

## Quickstart

Clone the official Community starter repository into a new project, then configure a fresh
Convex deployment. Follow these steps in this order.

1. Install and create the env file:

   ```bash
   git clone https://github.com/formulacms/formulacms-starter.git my-site
   cd my-site
   pnpm install
   cp .env.local.example .env.local
   ```

   Keep the `.git` folder: an upgrade merges the next release tag into your
   clone.

2. Create three secrets. Run `openssl rand -hex 32` three times and paste one
   result into each of these lines of `.env.local`: `BETTER_AUTH_SECRET`,
   `CONTACT_IP_PROOF_SECRET` and `REVALIDATE_SECRET`. Each secret gets its own
   value.

3. Start the backend once. This creates the Convex deployment and writes
   `CONVEX_DEPLOYMENT` and its URLs to `.env.local`:

   ```bash
   pnpm exec convex dev --until-success
   ```

   To run Convex locally without an account, use
   `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --until-success` instead (PowerShell:
   `$env:CONVEX_AGENT_MODE = "anonymous"; pnpm exec convex dev --until-success; Remove-Item Env:CONVEX_AGENT_MODE`).
   It starts a local backend and needs no login. Only that first command needs
   the variable; later commands such as `pnpm exec convex env set` and
   `pnpm dev` read the deployment from `.env.local`.

4. Copy the three secrets to the Convex deployment, then set the first-owner
   code. Both command blocks are in [Env Files](#env-files); run them in the
   order shown there.

5. Check the setup. `pnpm check:preflight` names each missing or mismatched
   value; fix it and run the check again until it passes:

   ```bash
   pnpm check:preflight
   ```

6. Start the app and complete onboarding at `http://localhost:3000/setup`:

   ```bash
   pnpm dev
   ```

   The home address shows "Page not found" until you publish the home page. To
   publish it, open Pages, open the home page, then select Save and Publish. The
   first publish may ask "Publish with warnings?" because the SEO title and
   description are empty; it is safe to accept.

## Releases and fork upgrades

A published formulacms release is identified only by its immutable, annotated
SemVer Git tag. Package, engine, schema, and release-recipe versions are
component versions, separate from release identity.

This starter becomes your customer-owned fork. Regeneration creates a fresh
starter for a new project; it never updates or overwrites an existing fork. To
adopt a compatible upstream release, use the
[manual fork-upgrade playbook](./docs/starter/operations.md#fork-upgrade-playbook)
and review every change in your own upgrade branch. Before merging, validate
the exact declared pair in `starter.transitions.json`:

```bash
node --import tsx scripts/check-release-transition.ts \
  --source-tag <source-tag> \
  --target-tag <target-tag>
```

## Env Files

### Quickstart step 4: set the Convex values

Set the Convex env values with the commands below. `BETTER_AUTH_URL` is not a
secret, so it is a command argument. The secrets (`BETTER_AUTH_SECRET`,
`CONTACT_IP_PROOF_SECRET` and `REVALIDATE_SECRET`) must equal the values in
`.env.local`, so copy each one from `.env.local` over stdin instead of
generating a new value or passing it as an argument.
`pnpm check:preflight` fails when either side is missing or the values differ.

```bash
pnpm exec convex env set BETTER_AUTH_URL http://localhost:3000
BETTER_AUTH_SECRET_VALUE="$(sed -n 's/^BETTER_AUTH_SECRET=//p' .env.local)"
printf '%s' "$BETTER_AUTH_SECRET_VALUE" | pnpm exec convex env set BETTER_AUTH_SECRET
CONTACT_IP_PROOF_SECRET_VALUE="$(sed -n 's/^CONTACT_IP_PROOF_SECRET=//p' .env.local)"
printf '%s' "$CONTACT_IP_PROOF_SECRET_VALUE" | pnpm exec convex env set CONTACT_IP_PROOF_SECRET
REVALIDATE_SECRET_VALUE="$(sed -n 's/^REVALIDATE_SECRET=//p' .env.local)"
printf '%s' "$REVALIDATE_SECRET_VALUE" | pnpm exec convex env set REVALIDATE_SECRET
unset BETTER_AUTH_SECRET_VALUE CONTACT_IP_PROOF_SECRET_VALUE REVALIDATE_SECRET_VALUE
```

In PowerShell, read each value with
`$env:KEY_VALUE = (Get-Content .env.local | Select-String '^KEY=').Line.Split('=', 2)[1]`,
pipe it with `$env:KEY_VALUE | pnpm exec convex env set KEY`, and finish with
`Remove-Item Env:KEY_VALUE`.

Then configure the first-owner code, without writing it to a file or passing it
as a command argument. The block starts in your site's folder and names its
Convex deployment, so it works from any terminal folder and can never set the
code on a different site (a bare `convex env set` writes to whichever
deployment the current folder points at):

```bash
(
  cd '/path/to/your-site' &&
  FORMULACMS_OWNER_CLAIM_VALUE="$(openssl rand -hex 32)" &&
  printf '%s' "$FORMULACMS_OWNER_CLAIM_VALUE" | pnpm exec convex env set FORMULACMS_OWNER_CLAIM --deployment <name from CONVEX_DEPLOYMENT in .env.local> &&
  printf '%s\n' "$FORMULACMS_OWNER_CLAIM_VALUE"
)
```

Replace `/path/to/your-site` with your site's folder and the deployment name
with the part of `CONVEX_DEPLOYMENT` after the colon (`dev:happy-animal-123`
gives `happy-animal-123`). Copy the printed value and paste it into the owner
setup code field on `/setup`. The variable disappears when the block ends.

Printing the value is deliberate (ADR-0007, amendment 2026-07-30): the
clipboard alone loses the code the moment anything else is copied, which leaves
the deployment unable to create its owner account. If you lose it before
finishing setup, read it back with `pnpm exec convex env get
FORMULACMS_OWNER_CLAIM` — the configured value is stored in cleartext, and only
the consumed record is hashed. After the first claim, a rotated value is used
only by the durable-owner replacement flow; it rebinds the installation owner
and signs the outgoing owner out.

### Where each value goes

Use `.env.local` for local development. Do not use `.env` for normal setup.

Compatibility notice (2026-08-12): this applies only to installations made
before 2026-08-12. Those installations may continue using the corresponding
`NEXTCMS_*` variables during the migration window. New setup
commands use `FORMULACMS_*`, and supported readers resolve the canonical name
before the legacy fallback without changing each setting's blank-value semantics.

| Value                              | Put it in                   | Notes                                                                        |
| ---------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `CONVEX_DEPLOYMENT`                | `.env.local`                | Written by `pnpm exec convex dev`.                                           |
| `NEXT_PUBLIC_CONVEX_URL`           | `.env.local`                | Convex client URL, usually written by Convex dev.                            |
| `NEXT_PUBLIC_CONVEX_SITE_URL`      | `.env.local`                | Convex HTTP actions URL ending in `.convex.site`.                            |
| `BETTER_AUTH_URL`                  | `.env.local` and Convex env | Use `http://localhost:3000` locally. Use your deployed origin in production. |
| `BETTER_AUTH_SECRET`               | `.env.local` and Convex env | Generate once with `openssl rand -hex 32`; use the same value in Convex.     |
| `NEXT_PUBLIC_SITE_URL`             | `.env.local` or host env    | Optional canonical public site URL.                                          |
| `CONTACT_IP_PROOF_SECRET`          | `.env.local` and Convex env | Required proof secret for contact, password reset, and account setup.        |
| `FORMULACMS_OWNER_CLAIM`           | Convex env only             | One-time owner setup code; never save it in a file or metadata.              |
| `REVALIDATE_SECRET`                | `.env.local` and Convex env | Shared secret for publish-time revalidation.                                 |
| `RESEND_API_KEY`                   | Convex env                  | Enables readiness for the bundled Resend adapter; never expose its value.    |
| `FORMULACMS_ALLOW_LOCAL_IMAGE_IPS` | `.env.local` or command env | Local production-build verification only.                                    |

The installation owner is the only CMS user. A Better Auth account on its own
has no admin access. The starter has one fixed admin role and no other members,
invitations, or roles; see `docs/starter/community-roles.md`. See
`docs/starter/operations.md` for the operator contract.

For a deployed site, set `BETTER_AUTH_URL` to the deployed site origin, for
example `https://example.com`.

## Development

```bash
pnpm dev
pnpm typecheck
pnpm lint
pnpm test:run
pnpm slices:sync --check
pnpm check:tokens
pnpm check:public:images
pnpm check:preflight
```

`pnpm dev` runs one Convex watcher and starts the Next.js development server
after Convex is ready. Open the Convex dashboard separately when needed with
`pnpm dev:dashboard`.

### Local sign-in redirects

If two local apps use different ports and one unexpectedly redirects to
`/sign-in`, their browser sessions can still overlap: cookies are scoped to the
hostname, not the port, so `localhost:3000` and `localhost:3001` are not
isolated. Stop the other app, use separate loopback hostnames or browser
profiles, or clear the local auth session before retrying. This affects local
browser sessions only; it does not change production cookie behavior.

For browser checks, keep Convex alive while serving the production build:

```bash
pnpm exec playwright install chromium
pnpm build:local
pnpm start
pnpm check:preflight
pnpm check:e2e:local
pnpm check:app-creation
pnpm check:app-creation:report
pnpm check:app-creation:feedback
```

The default `check:e2e:local` and `check:app-creation` paths require the active
backend to record completed setup. They do not inject an onboarding cookie or
otherwise bypass the setup gate. To verify setup itself, use
`STARTER_E2E_ONBOARDING=single` with `STARTER_E2E_OWNER_CLAIM` against a fresh
disposable backend; that mode completes the supported setup flow before the
remaining checks run.

Install Chromium once for the version of Playwright pinned by the project. The
browser preflight checks for that executable and repeats this command if it is
missing; it does not download a browser during `pnpm install`.

For a release gate, make the locale contract explicit so missing or unexpected
localized routes cannot weaken the audit by changing its inferred input:

```bash
STARTER_APP_QA_DEFAULT_LOCALE=en \
  STARTER_APP_QA_LOCALES=en \
  pnpm check:app-creation
```

Setup publishes nothing, so after setup a new site's home shows the not-found
page until you publish it. `pnpm check:app-creation` checks whichever
post-setup publication state it finds: before the first publish, that the home
and its draft stay private and are not indexed; after it, the published home's
language, canonical URL, and language alternates. Set
`STARTER_APP_QA_HOME=unpublished` or
`STARTER_APP_QA_HOME=published` to require one state, so a broken home cannot
pass as a site that has not published yet.

`pnpm build:local` and `pnpm start` are intentionally local-first: they serve
the production build at `http://localhost:3000` and keep Convex in dev mode.
Use a fresh local deployment whose stored site URL is also localhost. Use
`pnpm build` and `pnpm start:deploy` only after setting real host env values and
matching Convex env values for the deployed origin.

### Bounded pilot release gate

This generated starter is a bounded pilot for at most 499 total pages and 499
published pages. Until ROUTE-04 replaces the current 500-row route and sitemap
reads, run this against the exact Convex deployment after importing content and
before any promotion:

```bash
pnpm check:pilot-envelope
```

It fails at the sentinel; normal page writes also reject the 500th total or
published page. This is an interim pilot constraint, not a substitute for the
future indexed route and sitemap implementation.

For an early operator signal, run this against the same exact deployment on a
schedule:

```bash
pnpm check:pilot-envelope:capacity
```

It returns nonzero at 400 of the 499-page pilot maximum (80%) when either total
or published pages reaches that threshold. Route that result to the deployment
owner, pause planned growth in the indicated scope, and schedule ROUTE-04 before
the hard limit. After a registered provider is active, Settings -> Email
provides an owner-restricted test that sends a fixed redacted recovery-drill
message to the durable owner's account. Provider acceptance is not final inbox
delivery and does not configure alert routing or runtime-error monitoring.

`pnpm check:preflight` catches common local setup problems before the browser
checks run: missing `.env.local`, placeholder Convex or Better Auth values, old
Node/pnpm versions, production Convex deployments, and remote origins in
local-only verification. It also reads the active Convex deployment's env and
reports, by variable name only, when `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`,
`CONTACT_IP_PROOF_SECRET`, or `REVALIDATE_SECRET` is missing there or differs
from `.env.local`, and when the Convex-only `FORMULACMS_OWNER_CLAIM` is unset (the
setup code `/setup` needs at the account step). It never prints a secret value. If the
Convex CLI is unavailable, signed out, or has no deployment, those checks warn
instead of failing. `pnpm check:app-creation:report` runs the same
preflight and app-creation QA, writes JSON reports to `.cms-starter/`, and then
summarizes them into `.cms-starter/feedback-report.json`. The feedback report
groups failures, setup friction, artifact state, severity, proposed follow-up,
owner, and open/closed status for local handoff. If you already have fresh
preflight and app-creation reports, run `pnpm check:app-creation:feedback` to
regenerate only the feedback summary. `.cms-starter/` is ignored by git and is
safe for local handoff artifacts; review it before sharing because browser and
setup failures can include local paths or operator-provided values.

The application security-header contract, including the report-only
script/style CSP boundary and the edge-owned TLS/HSTS boundary, is documented in
[`docs/starter/security-headers.md`](docs/starter/security-headers.md).

## Continuous integration

The shipped GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every
pull request and every push to `main`. It installs dependencies, runs the
dependency audit, lint, type-check and tests, builds the production app, and
runs the fresh-setup test against a local Convex backend, so it needs no Convex
account. Add a `CONVEX_DEPLOY_KEY` repository secret (a Convex deploy key for
your production deployment) to also run a dry run of the Convex deployment on
pushes to `main`; without it that step is skipped with a warning.

## Authoring Slices

Slices are code-first content blocks: each slice has a typed Convex descriptor,
a local React renderer, registry entries, sample data, and optional simulator
snapshots. Do not use Prismic, Slice Machine, or custom type JSON workflows in
this starter.

Create a new Slice Type by hand, then review it like any other local code
change:

1. Add the typed descriptor under `convex/lib/slices/`, including its
   validator, defaults, and `aiHint`.
2. Add the local React renderer under `components/slices/`.
3. Add the manifest entry in `lib/slices/slices.manifest.json`.
4. Run `pnpm slices:sync` to regenerate registration.

Run the focused checks before committing:

```bash
pnpm typecheck
pnpm slices:sync --check
pnpm lint
```

Review the diff in `convex/lib/slices/`, `components/slices/`, and
`lib/slices/` so every slice lands as a reviewable code change.

## Authoring Content Types

The shipped content types are examples, not a closed catalog. Add any
domain-specific content type the site genuinely needs as code-first work:
write a descriptor under `convex/lib/contentTypes/`, add it to
`convex/lib/contentTypes/content-types.manifest.json`, and run
`pnpm content-types:sync`. Then check the result:

```bash
pnpm exec convex codegen --typecheck disable
pnpm content-types:sync -- --check
pnpm typecheck
pnpm lint
```

`pnpm content-types:sync` regenerates the mechanical registry and schema
projections from the manifest. Review and complete any domain-specific
renderer, query, index, migration, or deletion behavior before committing.
Product, Event, Location, Course, and similar names are examples only; no
domain model is privileged. See `docs/starter/content-model-authoring.md` for
the full workflow.

## Public URLs, Routes, And Revalidation

The starter uses three related path shapes. Keep them distinct when editing
menus, links, metadata, redirects, or publish-time cache invalidation.

**Public localized URLs** are the URLs visitors see and share. The default
locale is unprefixed, so an English site usually serves `/`, `/services`, and
`/contact`. Non-default locales are prefixed, so French pages usually serve
`/fr`, `/fr/services`, and `/fr/contact`. Public menus, canonical links,
hreflang links, sitemap entries, redirects, and page links should use
these visitor-facing URLs or page references that resolve to them.

**Internal Next route paths** are the App Router paths that actually render the
public pages. Public pages live under `app/(public)/[locale]/[[...path]]`, so a
default-locale public URL like `/services` renders through an internal route
path like `/en/services`. Use `toInternalRoutePath` when a public URL needs to
be converted for a Next route operation.

**Revalidation paths** are the paths passed to `revalidatePath`. For current
published pages, revalidation should target internal route paths, not only the
public default-locale URL. When a slug or parent changes, also include the old
public URLs so stale redirects and route cache entries are cleared. Use
`pageRevalidationPaths` to build the full set.

## First Site Setup

1. Complete `/setup`.
2. Choose the site language.
3. Open `/admin/pages`. Setup created one home page at `/` that stays private until you publish it.
4. Edit the home page, add your own pages, preview, and publish.
5. Replace logo, favicon, Open Graph image, contact details, and social links in Settings.

## Email

Fresh setup leaves transactional email unconfigured. The Console fallback sends
nothing, returns a `not_configured` result, and is not production-ready.

The bundled production adapter is Resend. Set its credential only in Convex
deployment env; do not add it to `.env.local`, enter it in Settings, or store it
in application data. Run this in your site's folder; the command asks for the
key, so the key stays out of your shell history:

```bash
pnpm exec convex env set RESEND_API_KEY --deployment <name from CONVEX_DEPLOYMENT in .env.local>
```

On macOS you can pipe the key from the clipboard instead:
`pbpaste | pnpm exec convex env set RESEND_API_KEY --deployment <name>`. If you
already put the key in `.env.local`, delete that line.

Then open Settings -> Email, set sender identity, check configuration, run the
owner-restricted test, and activate Resend with the current provider-accepted
receipt. Configure the sending domain using Resend's reviewed SPF, DKIM, and
DMARC instructions. Provider acceptance is not proof of inbox delivery.

To register another Email SDK-supported adapter or a private implementation,
follow [Email Setup](docs/starter/operations.md#email-setup). This is a reviewed
code, test, build, and release change; **Add this provider** never installs code
or mutates a running application.

## License

See `LICENSE`.

## AI setup

AI is off by default. Switch it on in Settings › Modules, then configure the
assistants in Settings › AI. Set `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` in the Convex environment for the provider you use. Run this
in your site's folder, with your provider's key name; the command asks for the
key:

```bash
pnpm exec convex env set OPENROUTER_API_KEY --deployment <name from CONVEX_DEPLOYMENT in .env.local>
```

Block creator key: the Block creator (Settings › AI › Block creator) runs on
your computer during local development and does not use the Convex key. Add
its own key as one line in `.env.local`, for example
`FORMULACMS_DEV_OPENROUTER_API_KEY=<your key>`
(`FORMULACMS_DEV_ANTHROPIC_API_KEY` and `FORMULACMS_DEV_OPENAI_API_KEY` also
work). Only this key goes in `.env.local`; the Convex key and
`RESEND_API_KEY` never do.
