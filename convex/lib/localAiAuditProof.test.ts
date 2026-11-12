import { describe, expect, test } from "vitest"

import { signLocalAiAudit, verifyLocalAiAuditProof } from "./localAiAuditProof"

describe("local AI audit proofs", () => {
  const secret = "local-ai-audit-test-secret"
  const now = 1_800_000_000_000
  const event = {
    kind: "page-generate-outline",
    selectedEngine: "codex-cli",
    selectedModel: "gpt-5.6-sol",
    success: true,
    tokenUsage: { promptTokens: 12, completionTokens: 4 },
  }

  test("accepts an unmodified short-lived proof", async () => {
    const signed = await signLocalAiAudit(event, { secret, now })
    const { auditProofExpiresAt, auditProofSignature, ...signedEvent } = signed

    await expect(
      verifyLocalAiAuditProof(
        signedEvent,
        { auditProofExpiresAt, auditProofSignature },
        { secret, now: now + 1_000 }
      )
    ).resolves.toBe(true)
  })

  test("rejects tampered, expired, and implausibly future proofs", async () => {
    const signed = await signLocalAiAudit(event, { secret, now })
    const proof = {
      auditProofExpiresAt: signed.auditProofExpiresAt,
      auditProofSignature: signed.auditProofSignature,
    }

    await expect(
      verifyLocalAiAuditProof({ ...event, success: false }, proof, {
        secret,
        now,
      })
    ).resolves.toBe(false)
    await expect(
      verifyLocalAiAuditProof(event, proof, {
        secret,
        now: signed.auditProofExpiresAt + 1,
      })
    ).resolves.toBe(false)

    const futureProof = await signLocalAiAudit(event, {
      secret,
      now,
      expiresAt: now + 11 * 60 * 1_000,
    })
    await expect(
      verifyLocalAiAuditProof(event, futureProof, { secret, now })
    ).resolves.toBe(false)
  })
})
