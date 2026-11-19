import { describe, expect, test } from "vitest"
import {
  classifySmtpCause,
  classifySmtpFailure,
  type SmtpFailureClassification,
} from "./smtpFailure.node"

type Row = readonly [
  name: string,
  cause: Record<string, unknown>,
  expected: SmtpFailureClassification,
]

const notSent = (
  retryable: boolean,
  category?: SmtpFailureClassification["category"]
): SmtpFailureClassification => ({
  delivery: "not_sent",
  retryable,
  ...(category ? { category } : {}),
})
const unknown: SmtpFailureClassification = {
  delivery: "unknown",
  retryable: false,
}

// One row per row of the classification table in the EM-SMTP plan (row 1, the
// validation error, keeps today's verdict and is covered below; row 2, a bad
// port, is decided before any connection and is tested with the adapter).
const rows: readonly Row[] = [
  ["3: sign-in reply 535", { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }, notSent(false, "sign_in_refused")],
  ["3: temporary sign-in reply 454 may retry", { code: "EAUTH", responseCode: 454, command: "AUTH LOGIN" }, notSent(true, "sign_in_refused")],
  ["4: sender refused at MAIL FROM", { code: "EENVELOPE", responseCode: 553, command: "MAIL FROM" }, notSent(false, "sender_refused")],
  ["4: temporary MAIL FROM reply may retry", { code: "EENVELOPE", responseCode: 451, command: "MAIL FROM" }, notSent(true, "sender_refused")],
  ["5: STARTTLS refused with a reply", { code: "ETLS", responseCode: 454, command: "STARTTLS" }, notSent(true, "secure_connection_failed")],
  ["6: greeting refused with 421", { code: "ECONNECTION", responseCode: 421, command: "CONN" }, notSent(true, "could_not_connect")],
  ["6: EHLO refused with 554", { code: "EPROTOCOL", responseCode: 554, command: "EHLO" }, notSent(false, "could_not_connect")],
  ["7: recipient refused at RCPT TO", { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }, notSent(false, "message_refused")],
  ["7: message refused at DATA with 4xx may retry", { code: "EMESSAGE", responseCode: 452, command: "DATA" }, notSent(true, "message_refused")],
  ["8: missing credentials, no reply", { code: "EAUTH", command: "API" }, notSent(false, "sign_in_refused")],
  ["8: ENOAUTH, no reply", { code: "ENOAUTH" }, notSent(false, "sign_in_refused")],
  ["9: name lookup failed", { code: "EDNS", command: "CONN" }, notSent(true, "could_not_connect")],
  ["10: ETLS without a reply", { code: "ETLS", command: "CONN" }, notSent(false, "secure_connection_failed")],
  ["10: EREQUIRETLS without a reply", { code: "EREQUIRETLS", command: "MAIL FROM" }, notSent(false, "secure_connection_failed")],
  ["11: expired certificate", { code: "ESOCKET", originalCode: "CERT_HAS_EXPIRED", command: "CONN" }, notSent(false, "secure_connection_failed")],
  ["11: self-signed certificate", { code: "ESOCKET", originalCode: "DEPTH_ZERO_SELF_SIGNED_CERT", command: "CONN" }, notSent(false, "secure_connection_failed")],
  ["11: host name mismatch", { code: "ESOCKET", originalCode: "ERR_TLS_CERT_ALTNAME_INVALID", command: "CONN" }, notSent(false, "secure_connection_failed")],
  ["12: connection refused", { code: "ESOCKET", originalCode: "ECONNREFUSED", command: "CONN" }, notSent(true, "could_not_connect")],
  ["13: connect timeout", { code: "ETIMEDOUT", timeoutType: "CONNECT_TIMEOUT", command: "CONN" }, notSent(true, "could_not_connect")],
  ["13: greeting timeout", { code: "ETIMEDOUT", timeoutType: "GREETING_TIMEOUT", command: "CONN" }, notSent(true, "could_not_connect")],
  ["14: TLS upgrade timeout", { code: "ETIMEDOUT", timeoutType: "UPGRADE_TIMEOUT", command: "CONN" }, notSent(false, "secure_connection_failed")],
  ["15: message error without a reply", { code: "EMESSAGE", command: "API" }, notSent(false, "message_refused")],
  ["16: envelope error without a reply", { code: "EENVELOPE", command: "API" }, notSent(false)],
  ["16: configuration error", { code: "ECONFIG" }, notSent(false, "could_not_connect")],
  ["16: proxy error", { code: "EPROXY" }, notSent(false)],
  ["16: OAuth2 error", { code: "EOAUTH2" }, notSent(false)],
  ["17: connection closed unexpectedly", { code: "ECONNECTION", command: "CONN" }, unknown],
  ["17: connection reset", { code: "ESOCKET", originalCode: "ECONNRESET" }, unknown],
  ["17: socket timeout while sending", { code: "ETIMEDOUT", timeoutType: "SOCKET_TIMEOUT", command: "CONN" }, unknown],
  ["17: protocol error", { code: "EPROTOCOL" }, unknown],
  ["17: stream error", { code: "ESTREAM" }, unknown],
  ["17: network unreachable stays uncertain", { code: "ESOCKET", originalCode: "EHOSTUNREACH" }, unknown],
  ["17: no code at all", {}, unknown],
]

describe("SMTP failure classification", () => {
  test.each(rows)("%s", (_name, cause, expected) => {
    expect(classifySmtpCause(cause)).toEqual(expected)
  })

  test("a server reply wins over an error code", () => {
    // A reply in 400 to 599 decides first, so a "connection" code with a 550
    // reply is a refused message, not an unknown delivery.
    expect(
      classifySmtpCause({
        code: "ECONNECTION",
        responseCode: 550,
        command: "MAIL FROM",
      })
    ).toEqual(notSent(false, "message_refused"))
  })

  test("reads typed fields only, never the message text", () => {
    // The text mentions a certificate, but there is no original code.
    expect(
      classifySmtpCause({
        code: "ESOCKET",
        message: "self-signed certificate in certificate chain",
      })
    ).toEqual(unknown)
    // A 535 in the text alone does not make it a sign-in failure.
    expect(
      classifySmtpCause({ code: "ECONNECTION", message: "535 5.7.8 denied" })
    ).toEqual(unknown)
  })

  test("an adapter error without a Nodemailer cause is a delivery unknown", () => {
    // For example a message validation error thrown before any connection:
    // it keeps today's verdict.
    expect(classifySmtpFailure(new Error("validation"))).toEqual(unknown)
    expect(classifySmtpFailure("not an error")).toEqual(unknown)
    expect(
      classifySmtpFailure(
        Object.assign(new Error("wrapped"), { cause: { code: "EAUTH" } })
      )
    ).toEqual(notSent(false, "sign_in_refused"))
  })

  test("ignores a reply outside 400 to 599", () => {
    expect(
      classifySmtpCause({ code: "EAUTH", responseCode: 250 })
    ).toEqual(notSent(false, "sign_in_refused"))
  })
})
