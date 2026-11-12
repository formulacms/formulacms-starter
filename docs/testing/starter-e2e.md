# Starter E2E Gate

Phase 14's browser gate is intentionally split by deployment state:

- Existing app whose backend records completed setup:
  `PUBLIC_BASE_URL=http://localhost:3001 pnpm check:e2e`
- Fresh setup: `STARTER_E2E_ONBOARDING=single PUBLIC_BASE_URL=http://localhost:3001 pnpm check:e2e`

The onboarding mode requires a disposable fresh deployment where `/setup`
renders the wizard; it creates the owner account, finishes setup in one step
with one site language, and then confirms `/` shows the not-found page, because
setup publishes nothing. It then publishes the draft home from the page editor
and confirms `/` no longer shows the not-found page. The default mode skips the
setup workflow so the forgot-password path can run against an app whose backend
already records completed setup, without resetting data. Browser verification
never supplies an onboarding cookie or other client-side bypass; a redirect to
`/setup` fails with an explicit completed-setup precondition.

Run these static gates normally:

```bash
pnpm typecheck
pnpm lint
pnpm test:run
pnpm slices:sync --check
pnpm check:tokens
```

For browser gates, keep Convex alive while serving the production Next build:

```bash
pnpm exec playwright install chromium
pnpm exec convex dev --tail-logs disable --start "pnpm exec next start -p 3001"
```

Install Chromium once for the pinned Playwright version before browser checks.
`pnpm check:preflight` stops first with this same command when the managed
executable is missing.

Then run, in another terminal:

```bash
pnpm check:public
PUBLIC_BASE_URL=http://localhost:3001 pnpm check:e2e
```

CI runs the extraction gate against a disposable local Convex deployment:

- `pnpm slices:sync --check` covers ADR-0021 manifest sync.
- `pnpm check:public` checks the Next image configuration.
- `STARTER_E2E_ONBOARDING=single pnpm check:e2e` runs against a
  production-local Next server and a fresh local Convex process. It completes
  setup through the wizard, confirms `/` shows the not-found page until something
  is published, publishes the draft home, and exercises the forgot-password path.

When verifying a production build against local Convex storage URLs, build with
`FORMULACMS_ALLOW_LOCAL_IMAGE_IPS=1`. That opt-in is only for private local
verification; leave it unset for public production deployments.
