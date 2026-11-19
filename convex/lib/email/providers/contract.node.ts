"use node"

import {
  type EmailAdapter as SdkEmailAdapter,
  type EmailMessage as SdkEmailMessage,
} from "@opencoredev/email-sdk"
import type { smtp } from "@opencoredev/email-sdk/smtp"
import type { EmailProviderMetadata } from "../providerMetadata"
import type { EmailProviderEnvironmentReadiness } from "../providerState"
import type { EmailProviderAdapter } from "../successor"

export type EmailProviderFactoryContext = Readonly<{
  environment: Readonly<Record<string, string | undefined>>
  /** Internal transport seam for deterministic contract tests. */
  fetch?: typeof fetch
  /** Internal SMTP adapter seam for deterministic contract tests. */
  smtp?: typeof smtp
}>

export type RegisteredEmailProviderDefinition<Id extends string = string> =
  Readonly<{
    metadata: EmailProviderMetadata<Id>
    readiness(
      context: EmailProviderFactoryContext
    ): EmailProviderEnvironmentReadiness
    createAdapter(
      context: EmailProviderFactoryContext,
      configuration: unknown
    ): EmailProviderAdapter
  }>

export function defineRegisteredEmailProvider<
  Id extends string,
  Configuration,
>(definition: {
  metadata: EmailProviderMetadata<Id>
  readiness(
    context: EmailProviderFactoryContext
  ): EmailProviderEnvironmentReadiness
  parseConfiguration(value: unknown): Configuration
  createAdapter(
    context: EmailProviderFactoryContext,
    configuration: Configuration
  ): EmailProviderAdapter
}): RegisteredEmailProviderDefinition<Id> {
  return Object.freeze({
    metadata: definition.metadata,
    readiness: definition.readiness,
    createAdapter(context, configuration) {
      return definition.createAdapter(
        context,
        definition.parseConfiguration(configuration)
      )
    },
  })
}

export function needsSetup(): never {
  throw new Error("CMS_EMAIL_PROVIDER_NEEDS_SETUP")
}

/** Every bundled provider takes no stored configuration: `{}` only. */
export function parseEmptyConfiguration(
  value: unknown
): Readonly<Record<string, never>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw new Error("CMS_EMAIL_PROVIDER_CONFIGURATION_INVALID")
  }
  return {}
}

export function adaptSdkAdapter(
  adapter: SdkEmailAdapter
): EmailProviderAdapter {
  return {
    id: adapter.name,
    idempotency: adapter.capabilities.idempotency,
    async send(message, context) {
      const result = await adapter.send(message as SdkEmailMessage, {
        adapter: adapter.name,
        operation: "send",
        attempt: context.attempt,
        idempotencyKey: context.idempotencyKey,
      })
      return { providerMessageId: result.id }
    },
  }
}
