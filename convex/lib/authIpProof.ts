const AUTH_IP_PROOF_VERSION = "nextcms-auth-ip:v1"
const AUTH_IP_PROOF_TTL_MS = 5 * 60 * 1000
const AUTH_IP_PROOF_MAX_FUTURE_MS = 10 * 60 * 1000
const SHA256_HEX_RE = /^[a-f0-9]{64}$/

export const AUTH_ORIGIN_HEADER = "x-nextcms-auth-origin"
export const AUTH_IP_HASH_HEADER = "x-nextcms-auth-ip-hash"
export const AUTH_IP_EXPIRES_HEADER = "x-nextcms-auth-ip-expires-at"
export const AUTH_IP_SIGNATURE_HEADER = "x-nextcms-auth-ip-signature"
export const AUTH_NEXT_ORIGIN = "next"

declare const process: { env: Record<string, string | undefined> } | undefined

export type AuthIpProof = {
  ipHash: string
  expiresAt: number
  signature: string
}

type ProofOptions = {
  secret?: string
  now?: number
  expiresAt?: number
}

function getAuthIpProofSecret(): string | undefined {
  return typeof process !== "undefined"
    ? process.env.CONTACT_IP_PROOF_SECRET
    : undefined
}

function normalizeIpHash(ipHash: string | undefined): string | null {
  const value = ipHash?.trim().toLowerCase()
  return value && SHA256_HEX_RE.test(value) ? value : null
}

function proofPayload(ipHash: string, expiresAt: number): string {
  return `${AUTH_IP_PROOF_VERSION}:${expiresAt}:${ipHash}`
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0)
  }
  return difference === 0
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
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
    encoder.encode(payload)
  )
  return bytesToHex(signature)
}

export async function hashAuthClientIdentity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value.trim().toLowerCase())
  )
  return bytesToHex(digest)
}

export async function signAuthIpHash(
  ipHash: string,
  options: ProofOptions = {}
): Promise<AuthIpProof | null> {
  const normalized = normalizeIpHash(ipHash)
  const secret = options.secret ?? getAuthIpProofSecret()
  if (!normalized || !secret) return null

  const now = options.now ?? Date.now()
  const expiresAt = options.expiresAt ?? now + AUTH_IP_PROOF_TTL_MS
  return {
    ipHash: normalized,
    expiresAt,
    signature: await hmacSha256Hex(secret, proofPayload(normalized, expiresAt)),
  }
}

export async function verifyAuthIpProof(
  proof: {
    ipHash?: string
    expiresAt?: number
    signature?: string
  },
  options: ProofOptions = {}
): Promise<string | null> {
  const normalized = normalizeIpHash(proof.ipHash)
  const secret = options.secret ?? getAuthIpProofSecret()
  const expiresAt = proof.expiresAt
  const signature = proof.signature?.trim().toLowerCase()
  if (!normalized || !secret || !expiresAt || !signature) return null
  if (!SHA256_HEX_RE.test(signature)) return null

  const now = options.now ?? Date.now()
  if (expiresAt < now || expiresAt > now + AUTH_IP_PROOF_MAX_FUTURE_MS) {
    return null
  }

  const expected = await hmacSha256Hex(
    secret,
    proofPayload(normalized, expiresAt)
  )
  return constantTimeEqual(expected, signature) ? normalized : null
}
