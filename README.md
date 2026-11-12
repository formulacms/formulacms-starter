# formulacms

formulacms is a self-hosted, fair-source, full-stack CMS for Next.js. The admin, the content backend and the public site are one Next.js and Convex app that you own. It includes:

- A public site with a home page, navigation, SEO and responsive blocks.
- An admin for pages, media, menus and settings.
- Convex as the backend and Better Auth for admin sign-in.
- Email for password reset and contact messages.

## Quickstart

You need Node.js 22 or newer, pnpm 11 and git. You do not need a Convex account.

1. Get the code and install it:

   ```bash
   git clone https://github.com/formulacms/formulacms-starter.git my-site
   cd my-site
   pnpm install
   ```

   Keep the `.git` folder. You need it to update to a later release.

2. Start the site:

   ```bash
   pnpm dev
   ```

   The first time, Convex asks where to run the backend:

   - If it asks "Would you like to login to your account?", choose "Start without an account" and press Enter. Then press Enter at "Continue?". Everything runs on your computer.
   - If you are already signed in to Convex, it asks "What would you like to configure?" instead. Press Enter at each question to create a new project. Your development backend then runs in your Convex account. If Convex also asks "Use cloud or local dev deployment?", choose "local deployment (BETA)" to keep it on your computer.

   The first start takes about a minute. When it is ready, the terminal shows your owner setup code in a box, just above the line "Ready". Keep the terminal open.

   On the first start, the log may show errors that say "Too many writes per second". You can ignore them: Convex runs those jobs again by itself.

3. Open `http://localhost:3000/setup` and complete the three steps:
   1. Choose the "Site language" and the "Timezone". Select "Continue".
   2. Create your account: your name, email, a password of at least 8 characters (twice) and the "Owner setup code" from the terminal. Select "Create account".
   3. Enter the "Site name". The "Site address" is filled in. Select "Finish setup".

   Until you publish a page in step 4, `http://localhost:3000` shows "Page not found".

4. Publish the home page:
   1. In the admin, open "Content". Select the title of the page marked "Home page".
   2. The page is empty and shows "Choose content to add". Select "Add example" on "Rich Text Body".
   3. Select "Save", then "Publish". When "Publish with warnings?" appears, select "Publish anyway". The warnings are about the empty SEO title and description.
   4. Open `http://localhost:3000` in a private window. You see your page.

To stop the site, press Ctrl+C. To start it again, run `pnpm dev`.

If something goes wrong, see [Local setup](docs/starter/local-setup.md).

## Put your site online

Vercel can serve the Next.js app, and Convex runs the backend in its cloud. Follow [`docs/starter/hosting.md`](docs/starter/hosting.md) from the folder where the Quickstart works.

## After setup

In Settings -> General, replace the logo, favicon, Open Graph image, contact details and social links.

## Email

Fresh setup leaves email unconfigured. The Console fallback sends nothing and returns a `not_configured` result. The bundled email provider is Resend. Set its key only in the Convex environment. Do not put it in `.env.local`, in Settings or in application data. Run the command in the site folder; it targets the deployment in `.env.local`. On macOS, copy the key, then pipe it from the clipboard:

```bash
pbpaste | pnpm exec convex env set RESEND_API_KEY
```

Otherwise run `pnpm exec convex env set RESEND_API_KEY` without a value. It asks for the key and shows it on screen while you type. For the hosted site, add `--prod`. If you already put the key in `.env.local`, delete that line.

Then open Settings -> Email. Set the sender, check the configuration, run the owner-restricted test and activate Resend with the receipt that the test returns. Set up the sending domain with Resend's SPF, DKIM and DMARC instructions. Provider acceptance is not proof of inbox delivery.

To register another email provider, follow [Email Setup](docs/starter/operations.md#email-setup). That is a code, test, build and release change; **Add this provider** never installs code or changes a running app.

## AI setup

AI is off by default. Turn it on in Settings -> Modules, then set up the assistants in Settings -> AI. Set `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the Convex environment for the provider you use. Run the command in the site folder, with your provider's key name. On macOS:

```bash
pbpaste | pnpm exec convex env set OPENROUTER_API_KEY
```

Otherwise run the command without a value. It asks for the key and shows it on screen while you type. For the hosted site, add `--prod`.

The Block creator (Settings -> AI -> Block creator) runs on your computer during local development and does not use the Convex key. Add its own key as one line in `.env.local`, for example `FORMULACMS_DEV_OPENROUTER_API_KEY=<your key>` (`FORMULACMS_DEV_ANTHROPIC_API_KEY` and `FORMULACMS_DEV_OPENAI_API_KEY` also work). Only this key goes in `.env.local`; the Convex key and `RESEND_API_KEY` never do.

## Releases and upgrades

A published formulacms release is identified only by its immutable, annotated SemVer Git tag. Package, engine, schema and release-recipe versions are component versions, separate from release identity.

This starter becomes your own fork. Regeneration creates a fresh starter for a new project; it never updates or overwrites an existing fork. To adopt a compatible release, use the [manual fork-upgrade playbook](./docs/starter/operations.md#fork-upgrade-playbook) and review every change in your own upgrade branch. Before you merge, validate the exact declared pair in `starter.transitions.json`:

```bash
node --import tsx scripts/check-release-transition.ts \
  --source-tag <source-tag> \
  --target-tag <target-tag>
```

## Page limit

This release supports at most 499 total pages and 499 published pages. Page writes reject the 500th total or published page.

After you import content, and before each release, run `pnpm check:pilot-envelope` against the deployment. It fails at the limit. For an early signal, run `pnpm check:pilot-envelope:capacity` on a schedule. It returns nonzero at 400 of 499 pages (80%), for total or published pages. Send that result to the site owner and plan for the limit.

After an email provider is active, Settings -> Email provides an owner-restricted test. It sends a fixed, redacted message to the owner's account. Provider acceptance is not inbox delivery, and the starter does not configure alert routing or runtime-error monitoring.

## Where each value goes

Use `.env.local` for local development, not `.env`. The table lists names only. The three secrets must be equal in `.env.local` and the development deployment, and equal on Vercel and the production deployment. The Next.js app does not read `BETTER_AUTH_URL`.

| Value                                                       | Local (`.env.local`)                     | Convex                                            | Vercel   |
| ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- | -------- |
| `CONVEX_DEPLOYMENT`                                         | Written by `convex dev`                  | —                                                 | —        |
| `NEXT_PUBLIC_CONVEX_URL`                                    | Written by `convex dev`                  | —                                                 | Required |
| `NEXT_PUBLIC_CONVEX_SITE_URL`                               | Written by `convex dev`                  | —                                                 | Required |
| `BETTER_AUTH_URL`                                           | Written by `pnpm dev` on the first start | Required                                          | —        |
| `BETTER_AUTH_SECRET`                                        | Written by `pnpm dev` on the first start | Required                                          | Required |
| `CONTACT_IP_PROOF_SECRET`                                   | Written by `pnpm dev` on the first start | Required                                          | Required |
| `REVALIDATE_SECRET`                                         | Written by `pnpm dev` on the first start | Required                                          | Required |
| `NEXT_PUBLIC_SITE_URL`                                      | Optional                                 | —                                                 | Required |
| `SITE_URL`                                                  | —                                        | Hosted site: the address used for publish refresh | —        |
| `FORMULACMS_OWNER_CLAIM`                                    | Never                                    | Owner setup code                                  | Never    |
| `RESEND_API_KEY`                                            | Never                                    | Optional                                          | Never    |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Never                                    | Optional                                          | Never    |
| `FORMULACMS_DEV_OPENROUTER_API_KEY` and the other two       | Optional, for the Block creator          | —                                                 | —        |
| `FORMULACMS_ALLOW_LOCAL_IMAGE_IPS`                          | Local production-build check only        | —                                                 | Never    |

The installation owner is the only CMS user. A Better Auth account on its own has no admin access. The starter has one fixed admin role and no other users, invitations or roles; see `docs/starter/community-roles.md`. See `docs/starter/operations.md` for the operator contract.

## Development

The main commands are `pnpm dev`, `pnpm typecheck`, `pnpm lint`, `pnpm test:run`, `pnpm slices:sync --check`, `pnpm check:tokens`, `pnpm check:public:images` and `pnpm check:preflight`. `pnpm dev` runs one Convex watcher and starts Next.js after Convex is ready. `pnpm dev:dashboard` opens the Convex dashboard.

Cookies belong to the host name, not the port, so `localhost:3000` and `localhost:3001` share sign-in cookies. If one local app sends you to `/sign-in` unexpectedly, stop the other app, use separate browser profiles or host names, or clear the local session. This affects local browsers only.

`pnpm check:preflight` finds common local setup problems: a missing `.env.local`, placeholder values, old Node.js or pnpm versions, a production deployment and non-local addresses. It also compares `BETTER_AUTH_URL` and the three secrets in `.env.local` with the Convex deployment and checks that `FORMULACMS_OWNER_CLAIM` is set. It reports variable names only and never prints a value. When the Convex CLI is signed out or has no deployment, these checks warn instead of fail.

### Browser checks

Keep Convex running while you serve the production build:

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

- Install Chromium once for the pinned Playwright version. `pnpm install` does not download it.
- `check:e2e:local` and `check:app-creation` need a deployment where setup is complete. They never skip the setup screen. To test setup itself, set `STARTER_E2E_ONBOARDING=single` and `STARTER_E2E_OWNER_CLAIM` against a fresh, disposable deployment.
- `check:app-creation` checks the home page in the state it finds: private and not indexed before the first publish, or with its language, canonical address and language alternates after it. Set `STARTER_APP_QA_HOME=unpublished` or `STARTER_APP_QA_HOME=published` to require one state.
- For a release check, name the languages so a missing route cannot weaken the check: `STARTER_APP_QA_DEFAULT_LOCALE=en STARTER_APP_QA_LOCALES=en pnpm check:app-creation`.
- `check:app-creation:report` writes JSON reports and a feedback summary to `.cms-starter/`, which git ignores. Review these files before you share them, because they can contain local paths and values you entered. `check:app-creation:feedback` rebuilds only the summary from fresh reports.
- `pnpm build:local` and `pnpm start` serve the production build on `http://localhost:3000` against the development deployment. Use `pnpm build` and `pnpm start:deploy` only with real hosted values on both sides.

## Continuous integration

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`. It installs dependencies, runs the dependency audit, lint, type-check and tests, builds the app and runs the fresh-setup test against a local Convex deployment. It needs no Convex account.

Add a `CONVEX_DEPLOY_KEY` repository secret to also run a dry run of the Convex deployment on pushes to `main`. Without it, that step is skipped with a warning. To create the key: in the Convex dashboard, open your production deployment, then Deployment Settings › General › Generate Production Deploy Key.

## Authoring Slices

Slices are code-first content blocks. Each one has a typed Convex descriptor, a React renderer, registry entries, sample data and optional preview images. This starter does not use Prismic, Slice Machine or custom type JSON.

1. Add the typed descriptor, with its validator, defaults and `aiHint`, under `convex/lib/slices/`.
2. Add the React renderer under `components/slices/`.
3. Add the entry in `lib/slices/slices.manifest.json`.
4. Run `pnpm slices:sync` to regenerate the registration.
5. Run `pnpm typecheck`, `pnpm slices:sync --check` and `pnpm lint`. Then review the diff in `convex/lib/slices/`, `components/slices/` and `lib/slices/`.

## Authoring Content Types

The shipped content types are examples, and no domain model is special. Add the types your site needs as code:

1. Write a descriptor under `convex/lib/contentTypes/`.
2. Add it to `convex/lib/contentTypes/content-types.manifest.json`.
3. Run `pnpm content-types:sync`. It regenerates the registry and schema files from the manifest.
4. Run `pnpm exec convex codegen --typecheck disable`, `pnpm content-types:sync -- --check`, `pnpm typecheck` and `pnpm lint`.
5. Complete the renderer, queries, indexes, migrations and delete behavior your type needs, then commit. See `docs/starter/content-model-authoring.md` for the full workflow.

## Public addresses, routes and revalidation

The starter uses three kinds of path. Keep them apart when you edit menus, links, metadata, redirects or cache refresh.

- **Public addresses** are what visitors see and share. The default language has no prefix (`/`, `/services`). Other languages have one (`/fr`, `/fr/services`). Menus, canonical links, hreflang links, sitemaps, redirects and page links use these addresses.
- **Internal route paths** are the App Router paths that render public pages, under `app/(public)/[locale]/[[...path]]`. The public address `/services` renders through `/en/services`. Use `toInternalRoutePath` to convert one.
- **Revalidation paths** go to `revalidatePath`. They are internal route paths. When an address or parent page changes, include the old public addresses too. `pageRevalidationPaths` builds the full set.

## Security headers and license

The security-header contract is in [`docs/starter/security-headers.md`](docs/starter/security-headers.md). For the license, see `LICENSE`.
