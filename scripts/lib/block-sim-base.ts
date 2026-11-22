/**
 * Where the block simulator is being served.
 *
 * The readiness wait and the capture run have to agree on this to the letter.
 * When they each carried their own `http://localhost:3000` literal, a project
 * whose dev server had moved would report the preview page ready on one port
 * and then photograph nothing on another — a confusing failure with a correct
 * server running the whole time. So the fallback is not a literal: it is the
 * origin `pnpm dev` itself binds, read from the same place the dev server
 * reads it.
 *
 * `BLOCK_SIM_BASE` still wins, for pointing a run at a server started some
 * other way.
 */
import nextEnv from "@next/env"
import { resolveDevServerOrigin } from "./dev-server-origin"

const LAST_RESORT_ORIGIN = "http://localhost:3000"

/**
 * Read the origin through the same env cascade `pnpm dev` uses.
 *
 * `start-next-dev.ts` calls `loadEnvConfig` before it picks its port, so a
 * checkout that sets `NEXT_PUBLIC_SITE_URL` in `.env.local` — the ordinary way to
 * move the dev port — binds that port. Reading `process.env` alone would miss
 * it and send the capture to 3000 while the server sat on 3001. `loadEnvConfig`
 * does not overwrite variables already in the environment, so an explicitly
 * exported `BLOCK_SIM_BASE` still wins.
 */
export function loadBlockSimBaseUrl(root = process.cwd()): string {
  nextEnv.loadEnvConfig(root, true)
  return blockSimBaseUrl()
}

export function blockSimBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const explicit = env.BLOCK_SIM_BASE?.trim()
  if (explicit) return explicit.replace(/\/$/, "")

  // A deployed origin in NEXT_PUBLIC_SITE_URL already resolves to the default;
  // a malformed local one falls back rather than refusing to run.
  try {
    return resolveDevServerOrigin(env).origin
  } catch {
    return LAST_RESORT_ORIGIN
  }
}
