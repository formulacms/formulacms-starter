"use node"

import type { EmailDeliveryFailureCategory } from "../delivery"

/**
 * Decide, from typed Nodemailer error fields only, what an SMTP send failure
 * means. It never reads message text, so no server text, address, or
 * credential reaches a result. Fields are documented at
 * https://nodemailer.com/errors: `code`, `command`, `responseCode`,
 * `originalCode` and `timeoutType`.
 *
 * Applies only to errors thrown by the SMTP adapter. Resend errors never come
 * through here.
 */
export type SmtpFailureClassification = Readonly<{
  /** "not_sent": proven not delivered. "unknown": it may have been sent. */
  delivery: "not_sent" | "unknown"
  /** Whether Action Retrier may run the same send again. */
  retryable: boolean
  category?: EmailDeliveryFailureCategory
}>

/**
 * Certificate failure codes, copied from the Email SDK's own list
 * (`CERTIFICATE_ERROR_CODE_PATTERN` in its `smtp-errors` module). A
 * certificate is checked only in the TLS handshake, before any message data
 * is sent.
 */
const CERTIFICATE_ORIGINAL_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "INVALID_CA",
  "CERT_SIGNATURE_FAILURE",
  "ERR_SSL_CA_KEY_TOO_SMALL",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  "ERR_TLS_CERTIFICATE_REQUIRED",
])

const UNKNOWN: SmtpFailureClassification = {
  delivery: "unknown",
  retryable: false,
}

function field(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined
}

function stringField(source: unknown, key: string): string | undefined {
  const value = field(source, key)
  return typeof value === "string" ? value : undefined
}

function replyCode(source: unknown): number | undefined {
  const value = field(source, "responseCode")
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 400 &&
    value <= 599
    ? value
    : undefined
}

function notSent(
  retryable: boolean,
  category?: EmailDeliveryFailureCategory
): SmtpFailureClassification {
  return {
    delivery: "not_sent",
    retryable,
    ...(category ? { category } : {}),
  }
}

/**
 * `cause` is the Nodemailer error the Email SDK keeps as the cause of its
 * adapter error. The rows are checked in order: a server reply (400 to 599)
 * wins over an error code, and only 4xx replies may be retried.
 */
export function classifySmtpCause(cause: unknown): SmtpFailureClassification {
  const code = stringField(cause, "code")
  const command = stringField(cause, "command")
  const reply = replyCode(cause)

  if (reply !== undefined) {
    const retryable = reply < 500
    if (code === "EAUTH") return notSent(retryable, "sign_in_refused")
    if (code === "EENVELOPE" && command === "MAIL FROM") {
      return notSent(retryable, "sender_refused")
    }
    if (code === "ETLS") return notSent(retryable, "secure_connection_failed")
    if (command === "CONN" || command === "EHLO" || command === "HELO") {
      return notSent(retryable, "could_not_connect")
    }
    return notSent(retryable, "message_refused")
  }

  switch (code) {
    case "EAUTH":
    case "ENOAUTH":
      return notSent(false, "sign_in_refused")
    case "EDNS":
      return notSent(true, "could_not_connect")
    case "ETLS":
    case "EREQUIRETLS":
      return notSent(false, "secure_connection_failed")
    case "ESOCKET": {
      const originalCode = stringField(cause, "originalCode")
      if (originalCode && CERTIFICATE_ORIGINAL_CODES.has(originalCode)) {
        return notSent(false, "secure_connection_failed")
      }
      if (originalCode === "ECONNREFUSED") {
        return notSent(true, "could_not_connect")
      }
      return UNKNOWN
    }
    case "ETIMEDOUT": {
      const timeoutType = stringField(cause, "timeoutType")
      if (
        timeoutType === "CONNECT_TIMEOUT" ||
        timeoutType === "GREETING_TIMEOUT"
      ) {
        return notSent(true, "could_not_connect")
      }
      if (timeoutType === "UPGRADE_TIMEOUT") {
        return notSent(false, "secure_connection_failed")
      }
      return UNKNOWN
    }
    case "EMESSAGE":
      return notSent(false, "message_refused")
    case "ECONFIG":
      return notSent(false, "could_not_connect")
    case "EENVELOPE":
    case "EPROXY":
    case "EOAUTH2":
      return notSent(false)
    default:
      return UNKNOWN
  }
}

/**
 * Classify an error thrown by the Email SDK's SMTP adapter. The SDK keeps the
 * Nodemailer error as `cause`; an error without one (for example a message
 * validation error) is treated as delivery unknown, as before.
 */
export function classifySmtpFailure(error: unknown): SmtpFailureClassification {
  return classifySmtpCause(field(error, "cause"))
}
