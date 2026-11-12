const AUTH_IP_PROOF_VERSION = "nextcms-auth-ip:v1"
const AUTH_IP_PROOF_TTL_MS = 5 * 60 * 1000
const AUTH_ORIGIN_HEADER = "x-nextcms-auth-origin"
const AUTH_IP_HASH_HEADER = "x-nextcms-auth-ip-hash"
const AUTH_IP_EXPIRES_HEADER = "x-nextcms-auth-ip-expires-at"
const AUTH_IP_SIGNATURE_HEADER = "x-nextcms-auth-ip-signature"
const AUTH_NEXT_ORIGIN = "next"

type ProofOptions = {
  secret?: string
}

function getClientIdentity(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  const realIp = headers.get("x-real-ip")?.trim()
  if (forwarded || realIp) return forwarded || realIp || null

  // Plain `next dev` has no proxy to add a client IP. Keep local setup and
  // password reset usable with one bounded loopback bucket; deployed Next
  // requests still fail closed when the trusted proxy headers are absent.
  return process.env.NODE_ENV === "development" ? "127.0.0.1" : null
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

async function hashClientIdentity(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value.trim().toLowerCase())
    )
  )
}

async function signIpHash(ipHash: string, secret: string) {
  const expiresAt = Date.now() + AUTH_IP_PROOF_TTL_MS
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${AUTH_IP_PROOF_VERSION}:${expiresAt}:${ipHash}`)
  )
  return { ipHash, expiresAt, signature: bytesToHex(signature) }
}

/**
 * Add a short-lived proof of the client identity observed by the Next server.
 * Caller-provided proof headers are always discarded. The Convex auth origin
 * fails closed when this marks a Next request but cannot produce a valid proof.
 */
export async function addNextAuthClientProof(
  request: Request,
  options: ProofOptions = {}
): Promise<Request> {
  const headers = new Headers(request.headers)
  headers.delete(AUTH_IP_HASH_HEADER)
  headers.delete(AUTH_IP_EXPIRES_HEADER)
  headers.delete(AUTH_IP_SIGNATURE_HEADER)
  headers.set(AUTH_ORIGIN_HEADER, AUTH_NEXT_ORIGIN)

  const secret = options.secret ?? process.env.CONTACT_IP_PROOF_SECRET
  const clientIdentity = getClientIdentity(headers)
  if (secret && clientIdentity) {
    const ipHash = await hashClientIdentity(clientIdentity)
    const proof = await signIpHash(ipHash, secret)
    headers.set(AUTH_IP_HASH_HEADER, proof.ipHash)
    headers.set(AUTH_IP_EXPIRES_HEADER, String(proof.expiresAt))
    headers.set(AUTH_IP_SIGNATURE_HEADER, proof.signature)
  }

  const body = await request.arrayBuffer()
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body.byteLength > 0 ? body : undefined,
  })
}
