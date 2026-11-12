export type OutboundUrlErrorCode =
  | "invalid_url"
  | "forbidden_scheme"
  | "forbidden_port"
  | "credentials"
  | "local_hostname"
  | "non_global_ip"
  | "redirect_location_missing"
  | "redirect_status_unsupported"
  | "redirect_limit"

export class OutboundUrlError extends Error {
  constructor(
    readonly code: OutboundUrlErrorCode,
    message: string
  ) {
    super(message)
    this.name = "OutboundUrlError"
  }
}

type NumericRange = {
  network: bigint
  prefixLength: number
}

const IPV4_BITS = 32
const IPV6_BITS = 128
const MAX_MEDIA_REDIRECTS = 3
const BIGINT_ZERO = BigInt(0)
const BIGINT_SHIFT_8 = BigInt(8)
const BIGINT_SHIFT_16 = BigInt(16)
const BIGINT_HEXTET_MASK = BigInt(0xffff)

const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const

const GLOBALLY_REACHABLE_IPV4_EXCEPTIONS = new Set([
  "192.0.0.9",
  "192.0.0.10",
])

const BLOCKED_IPV6_CIDRS = [
  "::/96",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "100:0:0:1::/64",
  "2001::/23",
  "2001:2::/48",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
] as const

const GLOBALLY_REACHABLE_IPV6_EXCEPTIONS = [
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:1::3/128",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:20::/28",
  "2001:30::/28",
] as const

const GLOBAL_UNICAST_IPV6_RANGE = parseIpv6Cidr("2000::/3")
const BLOCKED_IPV4_RANGES = BLOCKED_IPV4_CIDRS.map(parseIpv4Cidr)
const BLOCKED_IPV6_RANGES = BLOCKED_IPV6_CIDRS.map(parseIpv6Cidr)
const ALLOWED_IPV6_RANGES =
  GLOBALLY_REACHABLE_IPV6_EXCEPTIONS.map(parseIpv6Cidr)

function parseIpv4(host: string): bigint | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
  const octets = host.split(".").map(Number)
  if (octets.some((octet) => octet < 0 || octet > 255)) return null
  return octets.reduce(
    (value, octet) => (value << BIGINT_SHIFT_8) | BigInt(octet),
    BIGINT_ZERO
  )
}

function parseIpv6(host: string): bigint | null {
  const unwrapped =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  if (!unwrapped.includes(":") || unwrapped.includes("%")) return null

  const gapParts = unwrapped.split("::")
  if (gapParts.length > 2) return null

  const parseSide = (side: string): number[] | null => {
    if (side === "") return []
    const rawGroups = side.split(":")
    const groups: number[] = []
    for (const [index, rawGroup] of rawGroups.entries()) {
      if (rawGroup.includes(".")) {
        if (index !== rawGroups.length - 1) return null
        const ipv4 = parseIpv4(rawGroup)
        if (ipv4 === null) return null
        groups.push(
          Number((ipv4 >> BIGINT_SHIFT_16) & BIGINT_HEXTET_MASK),
          Number(ipv4 & BIGINT_HEXTET_MASK)
        )
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(rawGroup)) return null
        groups.push(Number.parseInt(rawGroup, 16))
      }
    }
    return groups
  }

  const left = parseSide(gapParts[0] ?? "")
  const right = parseSide(gapParts[1] ?? "")
  if (!left || !right) return null

  const hasGap = gapParts.length === 2
  const explicitGroups = left.length + right.length
  if (
    (!hasGap && explicitGroups !== 8) ||
    (hasGap && explicitGroups >= 8)
  ) {
    return null
  }

  const groups = [
    ...left,
    ...Array(hasGap ? 8 - explicitGroups : 0).fill(0),
    ...right,
  ]
  if (groups.length !== 8) return null
  return groups.reduce(
    (value, group) => (value << BIGINT_SHIFT_16) | BigInt(group),
    BIGINT_ZERO
  )
}

function parseIpv4Cidr(cidr: string): NumericRange {
  const [host, prefix] = cidr.split("/")
  const network = parseIpv4(host ?? "")
  const prefixLength = Number(prefix)
  if (
    network === null ||
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > IPV4_BITS
  ) {
    throw new Error(`Invalid IPv4 CIDR: ${cidr}`)
  }
  return { network, prefixLength }
}

function parseIpv6Cidr(cidr: string): NumericRange {
  const [host, prefix] = cidr.split("/")
  const network = parseIpv6(host ?? "")
  const prefixLength = Number(prefix)
  if (
    network === null ||
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > IPV6_BITS
  ) {
    throw new Error(`Invalid IPv6 CIDR: ${cidr}`)
  }
  return { network, prefixLength }
}

function isInRange(value: bigint, range: NumericRange, bits: number): boolean {
  const hostBits = BigInt(bits - range.prefixLength)
  return value >> hostBits === range.network >> hostBits
}

function isGloballyReachableIpv4(host: string, value: bigint): boolean {
  if (GLOBALLY_REACHABLE_IPV4_EXCEPTIONS.has(host)) return true
  return !BLOCKED_IPV4_RANGES.some((range) =>
    isInRange(value, range, IPV4_BITS)
  )
}

function isGloballyReachableIpv6(value: bigint): boolean {
  if (
    ALLOWED_IPV6_RANGES.some((range) =>
      isInRange(value, range, IPV6_BITS)
    )
  ) {
    return true
  }
  if (!isInRange(value, GLOBAL_UNICAST_IPV6_RANGE, IPV6_BITS)) return false
  return !BLOCKED_IPV6_RANGES.some((range) =>
    isInRange(value, range, IPV6_BITS)
  )
}

function isLexicallyLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "")
  if (!host.includes(".")) return true
  return [
    "localhost",
    "local",
    "internal",
    "home",
    "lan",
  ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Validate a URL before an outbound fetch.
 *
 * Literal addresses are checked without DNS. Hostnames retain lexical
 * local-name checks, but DNS resolution is intentionally not pinned: DNS
 * rebinding remains an accepted residual risk for the restricted pilot.
 */
export function guardOutboundUrl(rawUrl: string | URL): URL {
  let url: URL
  try {
    url = new URL(typeof rawUrl === "string" ? rawUrl.trim() : rawUrl.href)
  } catch {
    throw new OutboundUrlError("invalid_url", "Enter a valid absolute URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError(
      "forbidden_scheme",
      "URL must use HTTP or HTTPS"
    )
  }
  if (url.username !== "" || url.password !== "") {
    throw new OutboundUrlError(
      "credentials",
      "URL credentials are not allowed"
    )
  }
  if (url.port !== "") {
    throw new OutboundUrlError(
      "forbidden_port",
      "HTTP URLs must use port 80 and HTTPS URLs must use port 443"
    )
  }

  const hostname = url.hostname.toLowerCase()
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  const ipv4 = parseIpv4(unwrapped)
  if (ipv4 !== null) {
    if (!isGloballyReachableIpv4(unwrapped, ipv4)) {
      throw new OutboundUrlError(
        "non_global_ip",
        "URL IP address must be globally reachable"
      )
    }
    return url
  }

  const ipv6 = parseIpv6(unwrapped)
  if (ipv6 !== null) {
    if (!isGloballyReachableIpv6(ipv6)) {
      throw new OutboundUrlError(
        "non_global_ip",
        "URL IP address must be globally reachable"
      )
    }
    return url
  }

  if (isLexicallyLocalHostname(unwrapped)) {
    throw new OutboundUrlError(
      "local_hostname",
      "URL must point to a public hostname"
    )
  }
  return url
}

const FOLLOWABLE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export async function fetchWithSafeRedirects(
  rawUrl: string | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ response: Response; url: URL }> {
  let url = guardOutboundUrl(rawUrl)
  let redirects = 0

  while (true) {
    const response = await fetchImpl(url, { ...init, redirect: "manual" })
    if (response.status < 300 || response.status > 399) {
      return { response, url }
    }
    if (!FOLLOWABLE_REDIRECT_STATUSES.has(response.status)) {
      throw new OutboundUrlError(
        "redirect_status_unsupported",
        `Unsupported redirect status ${response.status}`
      )
    }
    if (redirects === MAX_MEDIA_REDIRECTS) {
      throw new OutboundUrlError(
        "redirect_limit",
        `Remote URL may follow at most ${MAX_MEDIA_REDIRECTS} redirects`
      )
    }
    const location = response.headers.get("location")
    if (!location) {
      throw new OutboundUrlError(
        "redirect_location_missing",
        "Redirect response is missing a Location header"
      )
    }
    url = guardOutboundUrl(new URL(location, url))
    redirects++
  }
}
