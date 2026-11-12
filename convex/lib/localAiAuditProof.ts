const LOCAL_AI_AUDIT_PROOF_VERSION = "v1"
const LOCAL_AI_AUDIT_PROOF_TTL_MS = 5 * 60 * 1000
const LOCAL_AI_AUDIT_PROOF_MAX_FUTURE_MS = 10 * 60 * 1000
const SHA256_HEX_RE = /^[a-f0-9]{64}$/

declare const process: { env: Record<string, string | undefined> } | undefined

type ProofOptions = {
  secret?: string
  now?: number
  expiresAt?: number
}

export type LocalAiAuditProof = {
  auditProofExpiresAt: number
  auditProofSignature: string
}

function getLocalAiAuditProofSecret(): string | undefined {
  return typeof process !== "undefined"
    ? process.env.CONTACT_IP_PROOF_SECRET
    : undefined
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return JSON.stringify("$number:NaN")
    if (value === Number.POSITIVE_INFINITY) {
      return JSON.stringify("$number:Infinity")
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return JSON.stringify("$number:-Infinity")
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  throw new Error("Local AI audit proof values must be JSON serializable.")
}

function proofPayload(event: object, expiresAt: number): string {
  return `${LOCAL_AI_AUDIT_PROOF_VERSION}:${expiresAt}:${canonicalJson(event)}`
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const max = Math.max(a.length, b.length)
  for (let index = 0; index < max; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0)
  }
  return diff === 0
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
 * Bind the complete privacy-safe audit event to the trusted Next.js server.
 * Domain separation lets this reuse the existing cross-runtime proof secret
 * without accepting a contact-form proof as an AI audit proof.
 */
export async function signLocalAiAudit<T extends object>(
  event: T,
  options: ProofOptions = {}
): Promise<T & LocalAiAuditProof> {
  const secret = options.secret ?? getLocalAiAuditProofSecret()
  if (!secret) {
    throw new Error(
      "CONTACT_IP_PROOF_SECRET is required to record local AI audit events."
    )
  }
  const now = options.now ?? Date.now()
  const expiresAt = options.expiresAt ?? now + LOCAL_AI_AUDIT_PROOF_TTL_MS
  return {
    ...event,
    auditProofExpiresAt: expiresAt,
    auditProofSignature: await hmacSha256Hex(
      secret,
      proofPayload(event, expiresAt)
    ),
  }
}

export async function verifyLocalAiAuditProof(
  event: object,
  proof: {
    auditProofExpiresAt?: number
    auditProofSignature?: string
  },
  options: ProofOptions = {}
): Promise<boolean> {
  const secret = options.secret ?? getLocalAiAuditProofSecret()
  const expiresAt = proof.auditProofExpiresAt
  const signature = proof.auditProofSignature?.trim().toLowerCase()
  if (!secret || !expiresAt || !signature || !SHA256_HEX_RE.test(signature)) {
    return false
  }

  const now = options.now ?? Date.now()
  if (expiresAt < now || expiresAt > now + LOCAL_AI_AUDIT_PROOF_MAX_FUTURE_MS) {
    return false
  }
  const expected = await hmacSha256Hex(secret, proofPayload(event, expiresAt))
  return constantTimeEqual(expected, signature)
}
