# Changelog

This file lists what changed in each formulacms release. The newest release
comes first. Each release has up to four parts: Added, Changed, Removed and
Fixed. The format follows Keep a Changelog 1.1.0.

The known limits of each release are on its release page:
https://github.com/formulacms/formulacms-starter/releases

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
