import "server-only"

import { headers } from "next/headers"
import { isLocalDevelopment } from "@/lib/assert-local-dev"

// Request-scoped half of "local" for the local tool route (ADR-0057 step 1):
// development mode AND a request from a browser on this computer.
//
// Threat: `next dev` listens on every network interface unless a hostname is
// given (its own default is 0.0.0.0; `pnpm dev` passes `--hostname localhost`).
// Then another device on the same network can reach the admin. The owner
// session is still required. This check keeps local tool runs, which use the
// owner's plan on the owner's computer, to a browser on that computer.
//
// Where the values come from: Next.js fills `x-forwarded-for` from the socket's
// remote address only when the request has no such header
// (next/dist/server/base-server.js, `??=`). A normal browser never sends it, so
// a browser on another device gets its real network address here. A client
// that writes both headers by hand can pass this check; the owner session is
// the boundary for that case, not this check. `host` is a client header too:
// it is checked only to refuse DNS-rebinding pages (as Vite and
// webpack-dev-server do), never trusted alone.

const MAX_HEADER_LENGTH = 1024
const ADDRESS_CHARACTERS = /^[0-9a-z.:[\]]+$/
const IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
// WHATWG URL serializes ::ffff:127.x.y.z as [::ffff:7fxx:xxxx].
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/

/**
 * True for `localhost`, 127.0.0.0/8, ::1 and ::ffff:127.x, with or without
 * IPv6 brackets and a port. Anything missing, longer than 1 KB, or
 * unparsable is not loopback.
 */
export function isLoopbackAddress(raw: string | null | undefined): boolean {
  if (!raw || raw.length > MAX_HEADER_LENGTH) return false
  const value = raw.trim().toLowerCase()
  if (!value || !ADDRESS_CHARACTERS.test(value)) return false
  // A bare IPv6 address (the socket form, such as "::1") has no brackets.
  const candidate =
    !value.startsWith("[") && value.split(":").length > 2 ? `[${value}]` : value
  let hostname: string
  try {
    hostname = new URL(`http://${candidate}`).hostname
  } catch {
    return false
  }
  if (hostname === "localhost" || hostname === "[::1]") return true
  const ipv4 = IPV4.exec(hostname)
  if (ipv4) return ipv4[1] === "127"
  return IPV4_MAPPED_LOOPBACK.test(hostname)
}

/**
 * The request came from this computer: one loopback `x-forwarded-for` value
 * (a list means a proxy chain, refused) and a loopback `host`.
 */
export function isLoopbackRequest(
  requestHeaders: Pick<Headers, "get">
): boolean {
  const forwardedFor = requestHeaders.get("x-forwarded-for")
  if (!forwardedFor || forwardedFor.includes(",")) return false
  return (
    isLoopbackAddress(forwardedFor) &&
    isLoopbackAddress(requestHeaders.get("host"))
  )
}

/** Local development AND a loopback request. Fails closed outside a request. */
export async function isLocalToolRequest(): Promise<boolean> {
  if (!isLocalDevelopment()) return false
  try {
    return isLoopbackRequest(await headers())
  } catch {
    return false
  }
}
