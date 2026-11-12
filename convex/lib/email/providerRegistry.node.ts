"use node"

import {
  type EmailAdapter as SdkEmailAdapter,
  type EmailMessage as SdkEmailMessage,
} from "@opencoredev/email-sdk"
import { resend } from "@opencoredev/email-sdk/resend"
import type { EmailProviderAdapter, FormulaCmsEmailMessage } from "./successor"
import {
  REGISTERED_EMAIL_PROVIDER_METADATA,
  type EmailProviderMetadata,
  type RegisteredEmailProviderId,
} from "./providerMetadata"
import type { EmailProviderEnvironmentReadiness } from "./providerState"
import { emailProviderEnvironmentReadiness } from "./providerReadiness"

export type EmailProviderFactoryContext = Readonly<{
  environment: Readonly<Record<string, string | undefined>>
  /** Internal transport seam for deterministic contract tests. */
  fetch?: typeof fetch
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

export type EmailProviderRegistry<Id extends string> = Readonly<{
  metadata: readonly EmailProviderMetadata<Id>[]
  has(providerId: string): providerId is Id
  readiness(
    providerId: string,
    context: EmailProviderFactoryContext
  ): EmailProviderEnvironmentReadiness
  createAdapter(
    providerId: string,
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

function unregisteredProvider(): never {
  throw new Error("CMS_EMAIL_PROVIDER_UNREGISTERED")
}

function needsSetup(): never {
  throw new Error("CMS_EMAIL_PROVIDER_NEEDS_SETUP")
}

function adaptSdkAdapter(adapter: SdkEmailAdapter): EmailProviderAdapter {
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

export function createEmailProviderRegistry<Id extends string>(
  definitions: readonly RegisteredEmailProviderDefinition<Id>[]
): EmailProviderRegistry<Id> {
  const byId = new Map<string, RegisteredEmailProviderDefinition<Id>>()
  for (const definition of definitions) {
    const providerId = definition.metadata.id.trim()
    if (!providerId || byId.has(providerId)) {
      throw new Error("CMS_EMAIL_PROVIDER_REGISTRY_INVALID")
    }
    byId.set(providerId, definition)
  }

  const metadata = Object.freeze(
    definitions.map((definition) => Object.freeze({ ...definition.metadata }))
  )

  function definitionFor(
    providerId: string
  ): RegisteredEmailProviderDefinition<Id> {
    return byId.get(providerId) ?? unregisteredProvider()
  }

  return Object.freeze({
    metadata,
    has(providerId: string): providerId is Id {
      return byId.has(providerId)
    },
    readiness(providerId, context) {
      return definitionFor(providerId).readiness(context)
    },
    createAdapter(providerId, context, configuration) {
      const definition = definitionFor(providerId)
      if (definition.readiness(context) !== "ready") needsSetup()
      const adapter = definition.createAdapter(context, configuration)
      if (adapter.id !== providerId) {
        throw new Error("CMS_EMAIL_PROVIDER_REGISTRY_INVALID")
      }
      return adapter
    },
  })
}

const resendMetadata = REGISTERED_EMAIL_PROVIDER_METADATA[0]

const resendDefinition = defineRegisteredEmailProvider({
  metadata: resendMetadata,
  readiness(context) {
    return emailProviderEnvironmentReadiness("resend", context.environment)
  },
  parseConfiguration(value): Readonly<Record<string, never>> {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 0
    ) {
      throw new Error("CMS_EMAIL_PROVIDER_CONFIGURATION_INVALID")
    }
    return {}
  },
  createAdapter(context) {
    const apiKey = context.environment.RESEND_API_KEY?.trim()
    if (!apiKey) needsSetup()
    return adaptSdkAdapter(
      resend({
        apiKey,
        ...(context.fetch ? { fetch: context.fetch } : {}),
      })
    )
  },
}) satisfies RegisteredEmailProviderDefinition<RegisteredEmailProviderId>

/** Server-only factory authority for providers registered in this build. */
export const EMAIL_PROVIDER_REGISTRY = createEmailProviderRegistry([
  resendDefinition,
])

// Keep the normalized message type referenced at this boundary so a future
// private definition cannot silently widen the FormulaCMS contract to SDK
// message options.
export type RegisteredEmailProviderMessage = FormulaCmsEmailMessage
