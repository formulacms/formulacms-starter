# Contributing to formulacms-starter

Thank you for your interest in improving the starter.

## Before you start

- Read [`README.md`](./README.md) for setup and the bounded-pilot release boundary.
- Read [`docs/starter/block-reuse-triage.md`](./docs/starter/block-reuse-triage.md) before deciding whether to reuse a Block Type.
- Read [`docs/starter/content-model-authoring.md`](./docs/starter/content-model-authoring.md) before adding a content model or Block Type.

## Development setup

```bash
git clone https://github.com/formulacms/formulacms-starter.git
cd formulacms-starter
pnpm install
pnpm dev   # starts Convex and Next.js, and finishes the local setup
```

## Pull requests

- One focused change per pull request. Do not bundle refactors.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before opening one.
- New Block Types follow the code-first authoring workflow and the
  [Block Type reuse triage](./docs/starter/block-reuse-triage.md).
- All contributions are subject to the CLA (see below).

## Contributor License Agreement

By submitting a pull request, you agree that your contribution is licensed under
the same [FSL-1.1-ALv2](./LICENSE) terms as the project. A CLA bot will ask you
to confirm on your first pull request.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).

## Reporting security issues

See [SECURITY.md](./SECURITY.md). Do **not** open a public issue for security
vulnerabilities.
