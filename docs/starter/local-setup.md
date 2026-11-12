# Local setup

`pnpm dev` finishes the local setup by itself. This page says what it sets up, when it does not, and how to do the same work by hand.

## What `pnpm dev` sets up

Each time `pnpm dev` starts, after Convex is ready and before Next.js starts, it checks three things:

- `.env.local` must hold `BETTER_AUTH_SECRET`, `CONTACT_IP_PROOF_SECRET`, `REVALIDATE_SECRET` and `BETTER_AUTH_URL`. A missing or placeholder secret gets the value Convex already has, or a new random value. If the value in Convex holds characters that cannot be written safely to `.env.local`, it prints a line asking you to add it by hand. A missing `BETTER_AUTH_URL` becomes `http://localhost:3000`. A real value is never changed, and `.env.local.example` is never copied over your file.
- The Convex development backend must hold the same three secrets. A missing `BETTER_AUTH_URL` in Convex gets the local value, but only when the local value is a `localhost` or `127.0.0.1` address. Otherwise Convex stays unchanged, and `pnpm dev` prints a line that says so. An existing `BETTER_AUTH_URL` in Convex is never changed. The values go to Convex over stdin. They are never printed or put in a command.
- The site needs an owner setup code (`FORMULACMS_OWNER_CLAIM`, kept in Convex only) until it has an owner. If there is none, `pnpm dev` makes one. Until you finish setup, every `pnpm dev` shows the code in a box. After the site has an owner, the code is never shown again.

To read the code again before you finish setup:

```bash
pnpm exec convex env get FORMULACMS_OWNER_CLAIM
```

When everything is already set up, `pnpm dev` changes nothing and prints nothing about it.

## When it does not run

`pnpm dev` skips the setup and changes nothing when one of these is true. If a value is missing, it prints one line that says why.

- `CI` is set to any value, even `false` or `0`.
- `CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT_TOKEN`, `CONVEX_SELF_HOSTED_URL` or `CONVEX_SELF_HOSTED_ADMIN_KEY` is set in your shell, `.env.local` or `.env`.
- `CONVEX_DEPLOYMENT` is missing, or it does not start with `dev:`, `local:` or `anonymous:`. A production backend is never changed. For a hosted site, follow [Put your site online](hosting.md).

If a Convex command fails, `pnpm dev` prints what failed, with every secret value of 8 characters or more replaced by `[hidden]`, and shows no owner setup code that time. When reading or changing the Convex settings fails, it still starts Next.js if `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` are set, and stops before Next.js starts if one of them is missing. When only the check for an owner fails, it starts Next.js. In both cases, run `pnpm dev` again. If it keeps failing, run `pnpm check:preflight`: it names each missing or mismatched value and never prints a value.

## Limits

The setup reads `.env.local` lines that Convex wrote, lines it wrote itself, and simple `KEY=value` lines. It reads any other line the way Node.js reads it. Secrets you set by hand must be 8 characters or longer.

## By hand

Use these steps only when `pnpm dev` skips the setup. Run them in the site folder. `CONVEX_DEPLOYMENT` must already be in `.env.local`: the first `pnpm exec convex dev` writes it.

1. Create three secrets. Run `openssl rand -hex 32` three times. Paste one result into each of these lines of `.env.local`: `BETTER_AUTH_SECRET`, `REVALIDATE_SECRET` and `CONTACT_IP_PROOF_SECRET`. In PowerShell, make one value with `[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()`.

2. Copy them to Convex. The block reads each secret from `.env.local` and sends it over stdin:

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

   In PowerShell, read each value with `$env:KEY_VALUE = (Get-Content .env.local | Select-String '^KEY=').Line.Split('=', 2)[1]`, send it with `$env:KEY_VALUE | pnpm exec convex env set KEY`, and finish with `Remove-Item Env:KEY_VALUE`.

3. Set the owner setup code. Replace `<deployment>` with the part of `CONVEX_DEPLOYMENT` in `.env.local` after the colon and before any space or `#`. For example, `dev:happy-animal-123` gives `happy-animal-123`, and `anonymous:anonymous-agent` gives `anonymous-agent`. When it starts with `local:`, use `local`.

   ```bash
   (
     FORMULACMS_OWNER_CLAIM_VALUE="$(openssl rand -hex 32)" &&
     printf '%s' "$FORMULACMS_OWNER_CLAIM_VALUE" | pnpm exec convex env set FORMULACMS_OWNER_CLAIM --deployment <deployment> &&
     printf '%s\n' "$FORMULACMS_OWNER_CLAIM_VALUE"
   )
   ```

   In PowerShell:

   ```powershell
   $env:FORMULACMS_OWNER_CLAIM_VALUE = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
   $env:FORMULACMS_OWNER_CLAIM_VALUE | pnpm exec convex env set FORMULACMS_OWNER_CLAIM --deployment <deployment>
   Write-Output $env:FORMULACMS_OWNER_CLAIM_VALUE
   Remove-Item Env:FORMULACMS_OWNER_CLAIM_VALUE
   ```

   Copy the printed code and paste it on the setup screen. After setup is finished, anyone who has a new code can replace the owner. Set one then only when you mean to replace the owner; see [Required Environment](operations.md#required-environment).

4. Check the setup. Fix each value it names and run it again until it passes:

   ```bash
   pnpm check:preflight
   ```
