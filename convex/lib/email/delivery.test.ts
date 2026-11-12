import { describe, expect, test } from "vitest"
import {
  assertEmailDeliveryRequest,
  emailDeliveryExpiresAt,
  emailMessageFingerprint,
  parseTerminalEmailDeliveryResult,
} from "./delivery"

const message = {
  to: "owner@example.test",
  subject: "Delivery request",
  text: "Bounded private payload",
}

describe("E04 delivery envelope", () => {
  test("accepts bounded event keys and fingerprints message content", async () => {
    expect(() =>
      assertEmailDeliveryRequest({
        idempotencyKey: "contact:event_123",
        message,
      })
    ).not.toThrow()
    await expect(emailMessageFingerprint(message)).resolves.toMatch(
      /^[0-9a-f]{64}$/
    )
  })

  test("rejects unbounded or unsafe delivery input", () => {
    expect(() =>
      assertEmailDeliveryRequest({ idempotencyKey: "bad key", message })
    ).toThrow("CMS_EMAIL_DELIVERY_REQUEST_INVALID")
    expect(() =>
      assertEmailDeliveryRequest({
        idempotencyKey: "contact:event_123",
        message: { ...message, text: "" },
      })
    ).toThrow("CMS_EMAIL_DELIVERY_REQUEST_INVALID")
  })

  test("bounds retention by consumer link lifetime", () => {
    const now = 1_000
    expect(emailDeliveryExpiresAt("password_recovery", now)).toBe(
      now + 60 * 60 * 1000
    )
    expect(emailDeliveryExpiresAt("owner_test", now)).toBe(now + 60 * 60 * 1000)
    expect(emailDeliveryExpiresAt("contact", now)).toBe(
      now + 24 * 60 * 60 * 1000
    )
    expect(emailDeliveryExpiresAt("invitation", now)).toBe(
      now + 7 * 24 * 60 * 60 * 1000
    )
  })

  test("accepts only normalized terminal results", () => {
    expect(
      parseTerminalEmailDeliveryResult({
        state: "unknown",
        providerId: "resend",
        reason: "delivery_unknown",
        rawError: "must-not-cross-boundary",
      })
    ).toEqual({
      state: "unknown",
      providerId: "resend",
      reason: "delivery_unknown",
    })
    expect(
      parseTerminalEmailDeliveryResult({
        state: "failed",
        reason: "raw-provider-error",
      })
    ).toBeNull()
  })
})
