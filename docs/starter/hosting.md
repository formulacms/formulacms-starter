# Put your site online

Vercel serves the Next.js app and Convex runs the backend. Start from the folder where `pnpm dev` works on `http://localhost:3000`. Run every command in that folder, in one terminal window.

## What you need

- A Vercel account and the Vercel CLI: `pnpm i -g vercel`.
- A Convex account.
- A project name for both services, for example `my-site`. Use lowercase letters, digits and hyphens. This page uses `my-site`; replace it everywhere.

Vercel and Convex both have free plans with usage limits; read each plan's limits before you choose one.

The pages and media you made on your computer stay there. The hosted site starts empty, and you set it up once more.

## Steps

1. Sign in to Vercel:

   ```bash
   vercel login
   ```

2. Sign in to Convex:

   ```bash
   pnpm exec convex login
   ```

3. Only if `CONVEX_DEPLOYMENT` in `.env.local` starts with `anonymous:`, create a Convex cloud project. Skip this step when it starts with `dev:`.

   ```bash
   pnpm exec convex dev --configure new --project my-site --once
   ```

   From now on, `pnpm dev` uses a new, empty development backend in the cloud. The next `pnpm dev` sets up this backend by itself and shows a new owner setup code for it. Then complete the setup screen again, as in README Quickstart step 3.

4. Send the backend code to production:

   ```bash
   pnpm exec convex deploy
   ```

   - It prints the production backend address on a line `NEXT_PUBLIC_CONVEX_URL=https://<name>.convex.cloud`. Copy that address.
   - It then asks "Do you want to push your code to your prod deployment … now?". Answer yes.

5. Create the Vercel project:

   ```bash
   vercel project add my-site
   ```

6. Connect the folder to the project. First back up your local values, because `vercel link` can write to `.env.local`:

   ```bash
   cp .env.local .env.backup.local
   vercel link --yes --project my-site
   ```

   If `pnpm dev` stops working afterwards, restore the backup with `cp .env.backup.local .env.local`.

7. Find your site address:

   ```bash
   vercel api "/v9/projects/my-site/domains"
   ```

   - Your address is the `"name"` that ends in `.vercel.app`, for example `my-site.vercel.app`.
   - If the name is taken, Vercel gives a different one.

8. Save both addresses in this terminal. Replace the examples with your values:

   ```bash
   SITE=https://my-site.vercel.app
   CLOUD=https://happy-animal-123.convex.cloud
   ```

   If you close the terminal, run this step again before you continue.

9. Set the addresses on the Convex production backend:

   ```bash
   pnpm exec convex env set BETTER_AUTH_URL "$SITE" --prod
   pnpm exec convex env set SITE_URL "$SITE" --prod
   ```

10. Set the addresses on Vercel:

    ```bash
    printf '%s' "$SITE" | vercel env add NEXT_PUBLIC_SITE_URL production --sensitive --force --yes
    printf '%s' "$CLOUD" | vercel env add NEXT_PUBLIC_CONVEX_URL production --sensitive --force --yes
    printf '%s' "${CLOUD%.convex.cloud}.convex.site" | vercel env add NEXT_PUBLIC_CONVEX_SITE_URL production --sensitive --force --yes
    ```

11. Create the three secrets. This block makes a new value for each secret, sets it on both sides and prints nothing. The hosted site uses new values, not the ones in `.env.local`.

    ```bash
    for NAME in BETTER_AUTH_SECRET CONTACT_IP_PROOF_SECRET REVALIDATE_SECRET; do
      V="$(openssl rand -hex 32)"
      printf '%s' "$V" | pnpm exec convex env set "$NAME" --prod
      printf '%s' "$V" | vercel env add "$NAME" production --sensitive --force --yes
      unset V
    done
    ```

12. Set the owner setup code on production. Copy the printed code.

    ```bash
    (
      FORMULACMS_OWNER_CLAIM_VALUE="$(openssl rand -hex 32)" &&
      printf '%s' "$FORMULACMS_OWNER_CLAIM_VALUE" | pnpm exec convex env set FORMULACMS_OWNER_CLAIM --prod &&
      printf '%s\n' "$FORMULACMS_OWNER_CLAIM_VALUE"
    )
    ```

    Run this step only once, before the first setup: a code set later lets whoever holds it replace the owner.

13. Deploy the site. The build takes a few minutes.

    ```bash
    vercel deploy --prod
    ```

14. Open `https://my-site.vercel.app/setup`, with your address from step 7. Complete the three setup steps with the code from step 12.

    Use only this address. The other addresses that Vercel prints are protected by Vercel, and the admin sign-in does not work on them.

## Check that it works

1. Sign out, then sign in again.
2. Publish the home page as in README Quickstart step 4.
3. Open your address in a private window. You see the page.
4. Open `/no-such-page`. You see "Page not found".

## Later

- New code: run `pnpm exec convex deploy`, then `vercel deploy --prod`, in that order. If the new code narrows the schema of a table that already holds data, read [`docs/starter/staged-schema-changes.md`](staged-schema-changes.md) first.
- Email and AI keys on the hosted site: use the README commands with `--prod`, for example `pbpaste | pnpm exec convex env set RESEND_API_KEY --prod`.
- Your own domain: add it to the project in Vercel. Then repeat steps 8 to 10 with the new address, and run `vercel deploy --prod` again.
- `pnpm check:preflight` checks only a local setup. It stops on a production deployment or a non-local address. `STARTER_PREFLIGHT_ALLOW_REMOTE=1` turns that stop off, but the check still compares `.env.local` with your development backend, not with production.
- For controlled releases from a Git-connected Vercel project, see "Controlled Vercel Releases" in [`docs/starter/operations.md`](operations.md#controlled-vercel-releases).

## Where each value goes (hosted)

The table lists names only.

| Place             | Values                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convex production | `BETTER_AUTH_URL`, `SITE_URL`, `BETTER_AUTH_SECRET`, `CONTACT_IP_PROOF_SECRET`, `REVALIDATE_SECRET`, `FORMULACMS_OWNER_CLAIM`; optional `RESEND_API_KEY` and AI keys |
| Vercel production | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, `BETTER_AUTH_SECRET`, `CONTACT_IP_PROOF_SECRET`, `REVALIDATE_SECRET`                |

The three secrets must be equal on both sides.
