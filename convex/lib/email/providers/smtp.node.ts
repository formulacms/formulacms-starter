"use node"

import type { EmailMessage as SdkEmailMessage } from "@opencoredev/email-sdk"
import { smtp } from "@opencoredev/email-sdk/smtp"
import {
  REGISTERED_EMAIL_PROVIDER_METADATA,
  parseSmtpPort,
  type RegisteredEmailProviderId,
} from "../providerMetadata"
import { emailProviderEnvironmentReadiness } from "../providerReadiness"
import {
  FormulaCmsClassifiedAdapterError,
  type EmailProviderAdapter,
  type FormulaCmsEmailMessage,
  type FormulaCmsProviderContext,
} from "../successor"
import {
  defineRegisteredEmailProvider,
  needsSetup,
  parseEmptyConfiguration,
  type EmailProviderFactoryContext,
  type RegisteredEmailProviderDefinition,
} from "./contract.node"
import { classifySmtpFailure } from "./smtpFailure.node"

const smtpMetadata = REGISTERED_EMAIL_PROVIDER_METADATA.find(
  (metadata) => metadata.id === "smtp"
)!

/** Port 465 is implicit TLS. Every other port must upgrade with STARTTLS. */
const IMPLICIT_TLS_PORT = 465

/** Applies to the connection, the greeting and an idle socket. */
const SMTP_TIMEOUT_MS = 15_000

/**
 * SHA-256 hex digest of the delivery key. The Email SDK writes the key into
 * the Message-ID header as `<key@email-sdk.local>`, and our keys contain
 * ":" which is not valid there.
 */
async function messageIdKey(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(idempotencyKey)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function createSmtpAdapter(
  context: EmailProviderFactoryContext
): EmailProviderAdapter {
  // Spaces and line breaks at the start or end of a value are ignored: a
  // value pasted into a dashboard often carries a stray space or line break.
  const host = context.environment.EMAIL_SMTP_HOST?.trim()
  const user = context.environment.EMAIL_SMTP_USER?.trim()
  const pass = context.environment.EMAIL_SMTP_PASSWORD?.trim()
  if (!host || !user || !pass) needsSetup()
  const port = parseSmtpPort(context.environment.EMAIL_SMTP_PORT)
  const createTransportAdapter = context.smtp ?? smtp

  return {
    id: "smtp",
    // The SDK derives the Message-ID header from the key.
    idempotency: "message_id",
    async send(
      message: FormulaCmsEmailMessage,
      sendContext: FormulaCmsProviderContext
    ) {
      if (port === null) {
        // Nothing was sent and no connection was opened.
        throw new FormulaCmsClassifiedAdapterError({
          adapter: "smtp",
          delivery: "not_sent",
          retryable: false,
          category: "could_not_connect",
        })
      }
      // Only these option keys are passed. No sign-in method, greeting name
      // or default-header option is set. The connection is always encrypted
      // (implicit TLS on 465, otherwise required STARTTLS). `tls` is explicit
      // so that no environment default can turn certificate checks off.
      const adapter = createTransportAdapter({
        name: "smtp",
        host,
        port,
        secure: port === IMPLICIT_TLS_PORT,
        requireTLS: port !== IMPLICIT_TLS_PORT,
        auth: { user, pass },
        timeoutMs: SMTP_TIMEOUT_MS,
        tls: { rejectUnauthorized: true },
      })
      const digest = await messageIdKey(sendContext.idempotencyKey)
      try {
        await adapter.send(message as SdkEmailMessage, {
          adapter: "smtp",
          operation: "send",
          attempt: sendContext.attempt,
          idempotencyKey: digest,
        })
        // The SDK result is not passed on: its id is parsed from the server
        // reply. The local digest is the only identifier that leaves here.
        return { providerMessageId: digest }
      } catch (error) {
        // Decide from typed fields only, then drop the original error: its
        // text can hold a server reply, an address, or a host name.
        throw new FormulaCmsClassifiedAdapterError({
          adapter: "smtp",
          ...classifySmtpFailure(error),
        })
      }
    },
  }
}

export const smtpDefinition = defineRegisteredEmailProvider({
  metadata: smtpMetadata,
  readiness(context) {
    return emailProviderEnvironmentReadiness("smtp", context.environment)
  },
  parseConfiguration: parseEmptyConfiguration,
  createAdapter: createSmtpAdapter,
}) satisfies RegisteredEmailProviderDefinition<RegisteredEmailProviderId>
