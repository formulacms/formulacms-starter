export type DevServerOrigin = {
  hostname: string
  origin: string
  port: number
}

// Callers hand this whole env bags (`process.env`, test fixtures); only
// NEXT_PUBLIC_SITE_URL is read, but the others are legitimately present.
type DevServerEnvironment = {
  NEXT_PUBLIC_SITE_URL?: string
  [key: string]: string | undefined
}

const DEFAULT_DEV_ORIGIN = "http://localhost:3000"
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"])

function defaultOrigin(): DevServerOrigin {
  return { hostname: "localhost", origin: DEFAULT_DEV_ORIGIN, port: 3000 }
}

/**
 * The address `pnpm dev` binds. A local NEXT_PUBLIC_SITE_URL moves the port.
 * Any other value (empty, schemeless, or the deployed site's address, which
 * the variable legitimately holds) leaves the default, localhost:3000.
 */
export function resolveDevServerOrigin(
  environment: DevServerEnvironment
): DevServerOrigin {
  const configured = environment.NEXT_PUBLIC_SITE_URL?.trim()
  if (!configured) return defaultOrigin()

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    return defaultOrigin()
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname)) return defaultOrigin()

  if (url.protocol !== "http:") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must use http for pnpm dev; received ${url.origin}.`
    )
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must not include a path, credentials, query, or hash."
    )
  }

  const port = url.port ? Number(url.port) : 80
  return { hostname: url.hostname, origin: url.origin, port }
}

export function occupiedDevPortMessage(config: DevServerOrigin): string {
  return [
    `Port ${config.port} is already in use.`,
    `formulacms will not silently move because the setup address it printed is ${config.origin}.`,
    "Stop the other app, or set another local port in NEXT_PUBLIC_SITE_URL in .env.local before trying again.",
  ].join(" ")
}

export type DevBundler = "turbopack" | "webpack"

// Turbopack is the default for `pnpm dev`; FORMULACMS_DEV_BUNDLER=webpack
// switches back without a code change. `next build --webpack` is unaffected.
export function resolveDevBundler(environment: {
  FORMULACMS_DEV_BUNDLER?: string
  [key: string]: string | undefined
}): DevBundler {
  const configured = environment.FORMULACMS_DEV_BUNDLER?.trim()
  if (!configured) return "turbopack"
  if (configured === "turbopack" || configured === "webpack") return configured
  throw new Error(
    `FORMULACMS_DEV_BUNDLER must be "turbopack" or "webpack"; received ${JSON.stringify(configured)}.`
  )
}

// Always names the bundler explicitly so Next never falls back to its own
// default, and so next.config.ts sees the matching `TURBOPACK` environment.
export function devServerArguments(
  config: DevServerOrigin,
  bundler: DevBundler
): string[] {
  return [
    "dev",
    bundler === "turbopack" ? "--turbopack" : "--webpack",
    "--hostname",
    config.hostname,
    "--port",
    String(config.port),
  ]
}
