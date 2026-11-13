# Changelog

This file lists what changed in each formulacms release. The newest release
comes first. Each release has up to three parts: Added, Changed and Fixed.
The format follows Keep a Changelog 1.1.0.

The known limits of each release are on its release page:
https://github.com/formulacms/formulacms-starter/releases

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

## 0.1.0 - 2026-11-12

The first public release of formulacms.

### Added

- **Multilingual at the core.** Each language has its own content, page addresses and publication, with a language switcher, `hreflang` links and sitemaps.
- **Live preview.** See any draft as visitors will, in each language, before you publish.
- **AI with your own key.** Write a page, translate it, ask the Help assistant, or create a block. Off until you switch it on.
- **Typed content that you own.** Blocks and content types are TypeScript in your repository, styled with design tokens.
- **Your data stays yours.** It lives in your own Convex project, and one command exports it all.
