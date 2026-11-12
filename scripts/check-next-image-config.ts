import { readFileSync } from "node:fs"
import { convexStorageRemotePatterns } from "../lib/media/next-image-config"

type Pattern = {
  protocol?: string
  hostname?: string
  port?: string
  pathname?: string
}

const requiredPatterns: Pattern[] = [
  {
    protocol: "https",
    hostname: "storage.convex.dev",
    pathname: "/file",
  },
  {
    protocol: "https",
    hostname: "**.convex.cloud",
    pathname: "/api/storage/**",
  },
  {
    protocol: "https",
    hostname: "**.convex.site",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "127.0.0.1",
    port: "3210",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "127.0.0.1",
    port: "3212",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "127.0.0.1",
    port: "3213",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "localhost",
    port: "3210",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "localhost",
    port: "3212",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "localhost",
    port: "3213",
    pathname: "/api/storage/**",
  },
]

function patternMatches(actual: Pattern, expected: Pattern) {
  return Object.entries(expected).every(
    ([key, value]) => actual[key as keyof Pattern] === value
  )
}

const missing = requiredPatterns.filter(
  (expected) =>
    !convexStorageRemotePatterns.some((actual) =>
      patternMatches(actual as Pattern, expected)
    )
)

if (missing.length > 0) {
  console.error("Missing required Convex storage remotePatterns:")
  for (const pattern of missing) {
    console.error(`- ${JSON.stringify(pattern)}`)
  }
  process.exit(1)
}

const nextConfigSource = readFileSync("next.config.ts", "utf8")
const imageConfigSource = readFileSync("lib/media/next-image-config.ts", "utf8")
if (!nextConfigSource.includes("convexStorageRemotePatterns")) {
  console.error(
    "next.config.ts must wire convexStorageRemotePatterns into images.remotePatterns."
  )
  process.exit(1)
}
if (!nextConfigSource.includes("dangerouslyAllowLocalIP")) {
  console.error(
    "next.config.ts must allow local Convex storage IPs in development for optimized local media."
  )
  process.exit(1)
}
if (
  !imageConfigSource.includes("FORMULACMS_ALLOW_LOCAL_IMAGE_IPS") ||
  !imageConfigSource.includes("NEXTCMS_ALLOW_LOCAL_IMAGE_IPS")
) {
  console.error(
    "next.config.ts must keep production local-IP image optimization behind an explicit private-network opt-in."
  )
  process.exit(1)
}
if (
  !nextConfigSource.includes("dangerouslyAllowSVG") ||
  !nextConfigSource.includes("contentSecurityPolicy")
) {
  console.error(
    "next.config.ts must explicitly harden SVG handling for uploaded Convex SVG media."
  )
  process.exit(1)
}

console.log("✓ Next image remotePatterns allow only Convex storage hosts.")
