# Changelog

This file lists what changed in each formulacms release. The newest release
comes first. Each release has up to four parts: Added, Changed, Removed and
Fixed. The format follows Keep a Changelog 1.1.0.

The known limits of each release are on its release page:
https://github.com/formulacms/formulacms-starter/releases

## 0.4.0

0.4.0 supports fresh installs only; there is no upgrade path from 0.3.1.
Do not merge or pull 0.4.0 into a site made from 0.3.x. Start a new site and a
new Convex deployment from v0.4.0; do not reuse a Convex deployment made by an
earlier release. `scripts/check-release-transition.ts` refuses the 0.3.1 to
0.4.0 hop as unsupported.

### Added

- `pnpm content-type:new` creates a content type in your site, during local
  development. It writes source files only.
  `pnpm content-type:new -- --recover` undoes a run that stopped halfway, and
  keeps any file that you changed after it. `pnpm content-type:verify` checks
  a content type. <!-- #194 -->
- The site checks its content types and blocks when it loads. A broken
  definition stops it with one message that names each problem and its
  repair. <!-- #194 -->
- `pnpm build` runs `pnpm check:blocks:coverage` before `next build`. The
  check fails when a block shows a text, rich-text or image field that you
  cannot click in the preview, and it names the file, the block, the field and
  the repair. <!-- #190 -->
- `pnpm check:blocks:render` clicks the text fields of every installed block
  in the block simulator. The starter's GitHub workflow runs it in a new
  `block-clicks` job. <!-- #192 -->
- You can edit one-line text fields, such as an eyebrow, a label or a button
  text, in place in the page preview, as you edit a title. <!-- #193 -->

### Changed

- "Block" replaces the former term "slice" everywhere: in the admin, the code,
  the file paths, the stored field names and the docs. The schema version is
  now 6. <!-- #185 -->
- The block routes are `/admin/blocks` and, during local development,
  `/block-sim`. <!-- #185 -->
- The block commands are `pnpm blocks:sync`, `pnpm blocks:author` and
  `pnpm check:blocks:narrowed-profile`. The new checks
  `pnpm check:blocks:coverage` and `pnpm check:blocks:render` also use the
  block name. <!-- #185 #190 #192 -->
- The block environment variables are `FORMULACMS_BLOCK_*` and
  `NEXTCMS_BLOCK_*`; when both are set, `FORMULACMS_BLOCK_*` wins.
  <!-- #185 -->
- `pnpm build` and `pnpm check:preflight` run `pnpm check:factories`. This one
  check reads the module, block and content-type files without changing them,
  and prints the repair for each problem. <!-- #188 -->
- The page preview is always editable. A click opens the field in place, or
  puts the focus on its field in the form. <!-- #191 -->
- The block simulator lets you click and edit the text of every installed
  block, also the blocks you add. <!-- #192 -->
- Trash refuses a page while a published page still points to it through any
  relation field. Before, only an author used by a published post was
  protected. A page that points to itself does not block its own move to
  Trash. The message now says "A published page still uses this one."
  <!-- #194 -->
- Package updates: Next.js 16.4.6, Convex 1.51.0, the background job queue
  (workpool) 0.5.0, AI SDK 7.0.177, Claude Agent SDK 0.3.328, dotenv 18.0.10
  and smaller updates. After you start the site on 0.4.0, going back to 0.3.x
  does not undo the job queue change. <!-- #178 -->

### Removed

- The "Edit text in preview" button and the "only in the form" notice in the
  page editor. <!-- #191 -->
- `scripts/check-generated-files.ts`. Its check is now part of
  `pnpm check:factories`. <!-- #188 -->

### Fixed

- A language change that replaces the content no longer fails on a page with
  two or more block types. <!-- #195 -->
- On a fresh site, the first permanent image delete in Trash works the first
  time. Before, Trash refused it once, until a background index finished.
  <!-- #197 -->

## 0.3.1

0.3.1 supports fresh installs only; there is no upgrade path from 0.3.0.
Do not merge or pull 0.3.1 into a site made from 0.3.0. Start a new site from
v0.3.1 instead. `scripts/check-release-transition.ts` refuses the 0.3.0 to
0.3.1 hop as unsupported.

### Added

- The page editor shows the block list and the live preview side by side.
  You can drag the divider between them and hide either side. Your browser
  remembers the layout. On a narrow screen, an Edit / Preview switch shows one
  side at a time. <!-- 3353e795 6b85c089 -->
- The Archive list has batch select. You can restore several items or move
  them to Trash at once. <!-- #182 -->
- Trash shows a Retry deletion button when a permanent delete stopped.
  <!-- #180 -->
- One runtime package: `react-resizable-panels` 4.24.1, for the resizable page
  editor. <!-- 3353e795 -->

### Changed

- Delete in Trash no longer waits for the public site. It queues the page, and
  one daily batch removes the queued pages. <!-- #180 -->
- The background job "page purge daily batch" (daily, 08:07 UTC) replaces
  "page purge resume" (daily, 04:20 UTC). <!-- #180 -->
- The menu editor names link destinations "Internal link" and "External
  link". <!-- #183 -->

### Fixed

- The menu page picker lists only the pages that are published in the menu
  language. <!-- #179 -->
- Every content type with a block body has a live preview. <!-- #181 -->
- The public site refreshes at once after you publish, unpublish, archive or
  trash a page. <!-- #184 -->
- A click in the preview puts the caret on the letter or word that you
  clicked, in plain text fields and in rich-text blocks.
  <!-- 0b2159b5 4c0f3359 8ba2424b 5d656399 -->
- A block that is already on screen stays in place when you select it in the
  preview. <!-- 408ee75c -->
- Nothing moves when you double-click or triple-click in the preview.
  <!-- 41306a18, back-port of #189 -->
- When the in-place editor fails to load, you edit the block in the form
  instead. <!-- 41306a18, back-port of #189 -->

## 0.3.0

0.3.0 supports fresh installs only; there is no upgrade path from 0.2.0.
Do not merge or pull 0.3.0 into a site made from 0.2.0. Start a new site from
v0.3.0 instead. `scripts/check-release-transition.ts` refuses the 0.2.0 to
0.3.0 hop as unsupported.

### Added

- During local development, Help, the Block creator, Writing and Translation
  can run on your own Claude Code or Codex, signed in with your plan or key,
  when you open the admin on the computer that runs formulacms. <!-- #138 #147 -->
- The Claude Code and Codex menus in Settings > AI list the models that the
  installed tool offers, with versioned names such as Opus 5.5 and
  GPT-6.1 Sol. <!-- #139 #143 #144 -->
- A Fable model needs a Claude Max or Ultra plan or an API key, and Settings >
  AI shows "Needs Max or Ultra" on a Fable row when your plan does not allow
  it. <!-- #144 -->
- Claude Fable 5.2 is in the Anthropic API model list. <!-- #140 -->
- SMTP is a bundled email provider next to Resend, with its connection values
  `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASSWORD` and the optional
  `EMAIL_SMTP_PORT` set only in the Convex environment. <!-- #135 -->
- Trash has a Pages tab and an Images tab, where you can restore or delete
  items permanently, one at a time or with Select all. <!-- #165 -->
- A Languages card on each content type page, shown when Multilingual is on,
  has a "Translate {type}" switch that keeps the type in one language when you
  turn it off. <!-- #167 -->
- The social title and description, noindex, nofollow, structured data,
  keywords, card excerpt and post category now have a value in each language.
  <!-- #167 -->
- `lib/modules/catalog.generated.ts`, the generated list of modules. The
  release generates this file, and `.gitattributes` marks it `-merge`.
  <!-- #171 -->
- `.gitattributes`, which tells git not to merge
  `lib/modules/catalog.generated.ts` line by line; on a conflict, restore that
  file from the release tag. <!-- #171 53676b92 -->
- Two runtime packages: `@anthropic-ai/claude-agent-sdk` 0.3.325, which reads
  the Claude Code model list, and `dotenv` 16.6.1. <!-- faf5c7da 945ad464 -->
- Two backfills that start by themselves each hour until they finish and need
  no command: the per-language fields backfill (minute 40) and the rich-text
  image usage backfill (minute 25). <!-- #167 #168 -->
- Three more background jobs: page purge resume (daily, 04:20 UTC), the
  Anthropic and OpenAI model list refresh (daily, 05:10 UTC) and a key check
  for those lists (hourly). <!-- #168 #141 -->
- `pnpm check:preflight` and `pnpm build` stop when a module file that the
  release owns was changed by hand, and `pnpm check:preflight` stops when your
  backend stores an enabled module that this release does not have.
  `pnpm check:preflight:strict` fails when the backend cannot be read.
  <!-- #173 -->

### Changed

- Settings > AI is rebuilt, with a rail for Assistants, Subscriptions and
  API keys, a tab for each provider, and assistant cards that show the
  provider, model and effort in use. <!-- #148 -->
- Each provider in Settings > AI shows one status word: Ready, Signed out,
  Not set up or Invalid key. <!-- #172 -->
- An assistant card whose saved model the tool no longer offers says "Choose
  another model" instead of "Ready". <!-- #164 -->
- The Anthropic, OpenAI and OpenRouter model lists update daily with your own
  keys, and a model appears only when it has a price. <!-- #141 -->
- The OpenRouter model list refreshes daily instead of weekly. <!-- #141 -->
- The OpenRouter defaults move to GPT-6.1 Sol and Claude Opus 5.5. <!-- #140 -->
- The OpenRouter menu no longer offers GPT-6 Sol Pro. <!-- #149 -->
- The Block creator reads its key from `.env.local` each time you use it, so a
  changed key works without a restart. <!-- #172 -->
- Settings > Modules shows the optional modules first, folds the modules every
  site needs into "Always on", and shows a progress panel while it applies
  your changes. <!-- #169 -->
- A row in Settings > Modules shows only the module name, a one-line
  description and its on/off switch; setup stays on each module's own page.
  <!-- #170 -->
- The SEO panel in the page editor works per language, and the social share
  image and the card image stay shared by every language. <!-- #167 -->
- AI translation also translates the new per-language text fields, except
  structured data. <!-- #167 -->
- Settings > Email lists SMTP first, and a provider becomes active when the
  mail server accepts its test email. <!-- #135 -->
- "More providers" in Settings > Email shows the bundled providers and a link
  to the guide for adding another one. <!-- #135 #157 -->
- The notification email hint, in `/setup` and Settings > Email, says "Enter
  your email to receive formulacms automatic notifications." <!-- #164 -->
- The site now tracks the images inside Rich text blocks, and it refuses to
  save or publish content that still shows the address of a deleted image.
  <!-- #165 -->
- On a phone (below 768 px), the admin sidebar starts hidden and opens over
  the page. <!-- #150 -->
- Machine-local files move from `.nextcms/` to `.formulacms/local/` once, when
  the server starts, and git ignores both folders. <!-- #158 #143 -->
- The content catalog for agents is now `formulacms-catalog` with
  `formulacms://` addresses, and the old `nextcms://` addresses still work in
  this release. <!-- #158 -->
- The border and page-colour reset in `app/globals.css` moves into Tailwind's
  `base` layer, so borders can look different if you edited that reset.
  <!-- #166 ba062a95 -->
- `pnpm-workspace.yaml` stops the install of the Claude Agent SDK's native
  binaries and ignores one audit advisory that has no fixed version.
  <!-- faf5c7da #167 -->

### Removed

- 14 unused database tables from the retired invitation and team features,
  among them `invites` and `authorMemberLinks`. <!-- #160 #161 #164 -->
- The `roundId` field and its index in `pagePublicationReleases`. <!-- #161 -->
- The `invitation` email type, which nothing created since 0.2.0. <!-- #157 -->
- The status badges, the Required badge, the "Needs" rows and the toasts on
  the Modules page. <!-- #169 -->
- The AI setup line and the "Open Languages" button on Modules page rows.
  <!-- #170 -->
- Nine unused block screenshots in `public/slice-sim/`. <!-- #162 -->

### Fixed

- A save from an older browser tab can no longer overwrite a newer change to
  a page, a draft, a menu or the settings. <!-- #153 #154 -->
- Restoring a menu now counts as a change to it. <!-- #153 -->
- A page created or published while a site language change is under review
  now moves into the new language. <!-- #156 -->
- Removing the image of a required Hero image field no longer breaks Save,
  and Publish stays blocked until you choose an image. <!-- #166 -->
- Save and Publish give a plain message when an image on the page was
  deleted from the media library. <!-- #166 -->
- Border, outline and background classes win over the base reset again.
  <!-- #166 -->
- The block simulator no longer shows a "Design system" link to a page that
  the starter does not ship. <!-- #163 -->
- Settings > AI shows a readable model name, not a raw id, when the local
  tool no longer lists the saved model. <!-- #152 -->
- The Effort select is disabled for a saved model that the tool does not
  offer. <!-- #159 -->
- Settings > AI reads the model list again after you update Claude Code or
  Codex, without a restart. <!-- #159 -->
- The Block creator card shows the newer-model line, as the other assistant
  cards do. <!-- #150 -->
- An OpenRouter key alone no longer runs the old Gemini 2.5 Flash default.
  <!-- #141 -->
- Turning AI off no longer logs an error, and Writing and Translation hide
  their controls even when a local tool is present. <!-- #172 -->
- The page job list keeps the local job cards visible when the AI module is
  not ready. <!-- #151 -->
- On a 390 px screen, the Modules progress panel no longer slides under the
  menu button. <!-- #170 -->
- Settings > AI: a long model name stays inside its field. <!-- #174 -->
- The page job list no longer logs an error while the AI module is off.
  <!-- #174 -->

## 0.2.0

0.2.0 cannot be merged or pulled into a 0.1.x site. Before any `git pull` or
merge, read the upgrade file:
`git show v0.2.0:upgrades/v0.1.1-to-v0.2.0.md`. It covers sites made from
0.1.0 and 0.1.1.

### Added

- Sign-in with a username and a password, through Convex Auth.
- `pnpm owner:recover`. It prints a one-time link that lets the owner choose
  a new username and password on the `/recover` page. The page shows the
  expired message at once for a link that was already used.
- Change password, in Settings > Account.
- An optional notification email. It only receives contact messages and the
  test email.
- The `login` and `logout` commands of `pnpm slices:author`. See
  `docs/starter/content-model-authoring.md`.
- `upgrades/v0.1.1-to-v0.2.0.md` and `upgrades/v0.1.0-to-v0.2.0.md`.

### Changed

- Sign-in moves from Better Auth to Convex Auth. It needs no auth secret and
  no auth URL.
- Setup accepts the owner setup code only while the site has no owner.
- `pnpm dev` writes two secrets: `CONTACT_IP_PROOF_SECRET` and
  `REVALIDATE_SECRET`.
- `pnpm lint` also runs the Convex lint rules on `convex/`. Your own Convex
  code can fail these rules.

### Removed

- Sign-in with an email address.
- Password reset by email, and the `/forgot-password` and `/reset-password`
  pages.
- Sign-in with Google, and its settings.
- Invitation email delivery.
- The password-reset script `admin:reset-password`.
- The environment values `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
- Owner replacement with a new owner setup code.
- 11 duplicate database indexes in `convex/schema.ts`.

### Fixed

- `pnpm dev` serves its development files, such as hot reload, at
  `127.0.0.1` and `[::1]` too, not only at `localhost`.
- `pnpm slices:author` runs in a site that you cloned with git.

## 0.1.1

To upgrade a site made from 0.1.0, follow `upgrades/v0.1.0-to-v0.1.1.md`.

### Added

- `upgrades/v0.1.0-to-v0.1.1.md`, the step-by-step upgrade file. It keeps
  your own content types, blocks, text and styling.
- `CHANGELOG.md`, this file.

### Changed

- `docs/starter/hosting.md` has two more sentences: wait about a minute after
  the first deploy, and choose your team when `vercel link` asks.
- The development package `glob` moves from version 13 to 14.

### Fixed

- Restoring a page from Trash keeps a language published when another page
  now uses only the address of the restored page's draft. In 0.1.0, that
  language was unpublished.
- Local setup keeps a secret that you give in your shell exactly as you gave
  it.
- One editor test, `components/admin/page-editor-history-slot.test.tsx`, no
  longer fails at random.

## 0.1.0 - 2026-11-12

The first public release of formulacms.

### Added

- **Multilingual at the core.** Each language has its own content, page addresses and publication, with a language switcher, `hreflang` links and sitemaps.
- **Live preview.** See any draft as visitors will, in each language, before you publish.
- **AI with your own key.** Write a page, translate it, ask the Help assistant, or create a block. Off until you switch it on.
- **Typed content that you own.** Blocks and content types are TypeScript in your repository, styled with design tokens.
- **Your data stays yours.** It lives in your own Convex project, and one command exports it all.
