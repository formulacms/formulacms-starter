import type { Doc } from "../../_generated/dataModel"

// M05 C3e.2 owns a separate carry-decision digest encoding. Do not reuse the
// disclosure-page encoding: changing either digest must not silently change
// the other one's stored receipts.

export const CARRY_DECISION_DIGEST_DOMAIN = "formulacms/m05/carry-decision/v1"

/** SHA-256 of the framed v1 domain followed by an empty list. */
export const CARRY_DECISION_EMPTY_DIGEST =
  "sha256:96a5dcb3593918bea73f10e39629961836d2876b64ed3ffefe849a823b01076c"

export type CarryDecisionDigestInput = Pick<
  Doc<"siteLanguageCarryDecisions">,
  | "routeId"
  | "fromPath"
  | "outcome"
  | "capturedSourcePublicSetVersion"
  | "capturedCarryInputVersion"
  | "capturedCarryDecisionGeneration"
>

const encoder = new TextEncoder()

function u32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]
}

function encodeValue(
  value: string | number | readonly unknown[],
  out: number[]
) {
  if (typeof value === "string") {
    const bytes = encoder.encode(value)
    out.push(0x53, ...u32(bytes.byteLength), ...bytes)
    return
  }
  if (typeof value === "number") {
    const bytes = encoder.encode(String(value))
    out.push(0x4e, ...u32(bytes.byteLength), ...bytes)
    return
  }
  out.push(0x4c, ...u32(value.length))
  for (const child of value) {
    if (
      typeof child !== "string" &&
      typeof child !== "number" &&
      !Array.isArray(child)
    ) {
      throw new Error("CARRY_DECISION_DIGEST_VALUE_INVALID")
    }
    encodeValue(child, out)
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/** Recomputes the frozen empty value from the v1 framing for proof/tests. */
export async function computeCarryDecisionEmptyDigest(): Promise<string> {
  const out: number[] = []
  encodeValue(CARRY_DECISION_DIGEST_DOMAIN, out)
  encodeValue([], out)
  return `sha256:${await sha256Hex(Uint8Array.from(out))}`
}

function decisionFields(decision: CarryDecisionDigestInput) {
  return [
    String(decision.routeId),
    decision.fromPath,
    decision.outcome,
    decision.capturedSourcePublicSetVersion,
    decision.capturedCarryInputVersion,
    decision.capturedCarryDecisionGeneration,
  ] as const
}

/** Extends the canonical, reorder-sensitive chain by one persisted decision. */
export async function extendCarryDecisionDigest(
  previousDigest: string,
  decision: CarryDecisionDigestInput
): Promise<string> {
  const out: number[] = []
  encodeValue(CARRY_DECISION_DIGEST_DOMAIN, out)
  encodeValue([previousDigest, decisionFields(decision)], out)
  return `sha256:${await sha256Hex(Uint8Array.from(out))}`
}

/** Test/reference helper; production extends the same chain page by page. */
export async function digestCarryDecisionCorpus(
  decisions: readonly CarryDecisionDigestInput[]
): Promise<string> {
  let digest = CARRY_DECISION_EMPTY_DIGEST
  for (const decision of decisions) {
    digest = await extendCarryDecisionDigest(digest, decision)
  }
  return digest
}
