import { configuredDeploymentName } from "@/components/development-instance-badge"

/**
 * What the setup page's "Make a new code" help shows. Built on the server and
 * passed to the client wizard, so the terminal block is never worked out in
 * the browser.
 *
 * - `local`: local development, or a production build (`pnpm build:local`,
 *   `pnpm start`) on this machine's own Convex backend. The block starts in
 *   this site's folder and names this site's Convex deployment, so it works
 *   from any terminal folder and can never set the code on another site.
 * - `local-unbound`: local, but the folder or the deployment is unknown. No
 *   command is shown, because an unbound one could silently set the code on a
 *   different site.
 * - `live`: not local. The server's folder is the host's, not the
 *   owner's, so there is no `cd`; the block names this site's deployment (read
 *   from `NEXT_PUBLIC_CONVEX_URL`) and the owner runs it in their project
 *   folder. From a folder of another project the Convex CLI fails with "not
 *   found" and the code is never printed.
 * - `live-unbound`: not local, and the deployment cannot be read
 *   from a Convex Cloud URL (missing URL, self-hosted or a custom domain). No
 *   command is shown.
 */
export type OwnerCodeTarget =
  | { kind: "local"; folder: string; command: string }
  | { kind: "local-unbound" }
  | { kind: "live"; deployment: string; command: string }
  | { kind: "live-unbound" }

/** Convex deployment names are lowercase words joined by hyphens. */
const DEPLOYMENT_NAME = /^[a-z0-9-]+$/

/** Quote a path for a POSIX shell: single quotes, with `'` written as `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The deployment name, or null when it is missing or not a plain name. */
export function validDeploymentName(name: string | null): string | null {
  return name !== null && DEPLOYMENT_NAME.test(name) ? name : null
}

/**
 * What `--deployment` should get for `CONVEX_DEPLOYMENT`. A signed-in local
 * deployment is `local:local-<team>-<project>`, a name the CLI does not accept
 * as a deployment name (team and project slugs may hold underscores); the CLI's
 * own `local` selector (convex/src/cli/lib/deploymentSelector.ts) picks it.
 */
export function deploymentSelectorFor(configured: string | undefined) {
  const trimmed = configured?.trim()
  if (!trimmed) return null
  if (/^local:/.test(trimmed)) return "local"
  return validDeploymentName(configuredDeploymentName({ CONVEX_DEPLOYMENT: trimmed }))
}

/** The steps shared by both blocks, one subshell chained with `&&`. */
function ownerCodeSteps(deployment: string, folder?: string) {
  return [
    "(",
    ...(folder === undefined ? [] : [`  cd ${shellQuote(folder)} &&`]),
    `  FORMULACMS_OWNER_CLAIM_VALUE="$(openssl rand -hex 32)" &&`,
    `  printf '%s' "$FORMULACMS_OWNER_CLAIM_VALUE" | npx convex env set FORMULACMS_OWNER_CLAIM --deployment ${deployment} &&`,
    `  printf '%s\\n' "$FORMULACMS_OWNER_CLAIM_VALUE"`,
    ")",
  ].join("\n")
}

/** Local block: starts in the site's folder. */
export function buildOwnerCodeCommand(folder: string, deployment: string) {
  return ownerCodeSteps(deployment, folder)
}

/** Live block: no folder, because the owner runs it in their own. */
export function buildLiveOwnerCodeCommand(deployment: string) {
  return ownerCodeSteps(deployment)
}

/**
 * The deployment name of an `https://<name>.convex.cloud` URL, or null for any
 * other URL (self-hosted, custom domain) or a name that is not a plain name.
 */
export function convexCloudDeploymentName(url: string | undefined) {
  if (!url) return null
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== "https:") return null
    const host = /^(.+)\.convex\.cloud$/.exec(parsed.hostname)
    return validDeploymentName(host?.[1] ?? null)
  } catch {
    return null
  }
}

/** Host names that can only reach a backend on this machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * True when the site uses a Convex backend that runs on this machine: the
 * CLI's `local:` or `anonymous:` deployment, reached at a loopback address.
 * Such a backend is never a hosted one, so the server's folder is the owner's
 * folder even when `NODE_ENV` is production.
 */
export function usesThisMachineBackend(environment: {
  CONVEX_DEPLOYMENT?: string
  NEXT_PUBLIC_CONVEX_URL?: string
}): boolean {
  if (!/^(local|anonymous):/.test(environment.CONVEX_DEPLOYMENT?.trim() ?? ""))
    return false
  const url = environment.NEXT_PUBLIC_CONVEX_URL?.trim()
  if (!url) return false
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

export function resolveOwnerCodeTarget(
  environment: {
    NODE_ENV?: string
    CONVEX_DEPLOYMENT?: string
    NEXT_PUBLIC_CONVEX_URL?: string
  },
  folder: string | undefined
): OwnerCodeTarget {
  // The same check the development badge uses, except that a production build
  // on this machine's own backend is still local.
  if (
    environment.NODE_ENV !== "development" &&
    !usesThisMachineBackend(environment)
  ) {
    const deployment = convexCloudDeploymentName(
      environment.NEXT_PUBLIC_CONVEX_URL
    )
    return deployment
      ? {
          kind: "live",
          deployment,
          command: buildLiveOwnerCodeCommand(deployment),
        }
      : { kind: "live-unbound" }
  }
  const deployment = deploymentSelectorFor(environment.CONVEX_DEPLOYMENT)
  if (!folder || !deployment) return { kind: "local-unbound" }
  return {
    kind: "local",
    folder,
    command: buildOwnerCodeCommand(folder, deployment),
  }
}
