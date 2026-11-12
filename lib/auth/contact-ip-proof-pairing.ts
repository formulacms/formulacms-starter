import "server-only"

const CONTACT_IP_PROOF_PAIRING_VERSION = "nextcms-contact-ip-pairing:v1"
const CONTACT_IP_PROOF_PAIRING_SENTINEL = "contact-ip-proof-secret"
const CONTACT_IP_PROOF_PAIRING_TTL_MS = 5 * 60 * 1000

export type ContactIpProofPairing = {
  expiresAt: number
  signature: string
}

export type ContactIpProofPairingIssueResult =
  | { status: "issued"; proof: ContactIpProofPairing }
  | { status: "unconfigured" }

type ProofOptions = {
  secret?: string
  now?: number
  expiresAt?: number
}

function pairingPayload(expiresAt: number): string {
  return `${CONTACT_IP_PROOF_PAIRING_VERSION}:${expiresAt}:${CONTACT_IP_PROOF_PAIRING_SENTINEL}`
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
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

/**
 * Mint the browser-serializable half of the active Next ↔ Convex configuration
 * pairing check. This fixed-sentinel proof is intentionally not an auth IP
 * proof: its versioned payload domain prevents reuse by authentication flows.
 */
export async function issueContactIpProofPairing(
  options: ProofOptions = {}
): Promise<ContactIpProofPairingIssueResult> {
  const secret = options.secret ?? process.env.CONTACT_IP_PROOF_SECRET
  if (!secret) return { status: "unconfigured" }

  const now = options.now ?? Date.now()
  const expiresAt = options.expiresAt ?? now + CONTACT_IP_PROOF_PAIRING_TTL_MS
  return {
    status: "issued",
    proof: {
      expiresAt,
      signature: await hmacSha256Hex(secret, pairingPayload(expiresAt)),
    },
  }
}
