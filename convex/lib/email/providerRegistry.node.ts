"use node"

import type { EmailProviderAdapter, FormulaCmsEmailMessage } from "./successor"
import type { EmailProviderMetadata } from "./providerMetadata"
import type { EmailProviderEnvironmentReadiness } from "./providerState"
import {
  defineRegisteredEmailProvider,
  needsSetup,
  type EmailProviderFactoryContext,
  type RegisteredEmailProviderDefinition,
} from "./providers/contract.node"
import { resendDefinition } from "./providers/resend.node"
import { smtpDefinition } from "./providers/smtp.node"

export {
  defineRegisteredEmailProvider,
  type EmailProviderFactoryContext,
  type RegisteredEmailProviderDefinition,
}

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

function unregisteredProvider(): never {
  throw new Error("CMS_EMAIL_PROVIDER_UNREGISTERED")
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

/**
 * Server-only factory authority for providers registered in this build, in
 * display order: SMTP first, then Resend.
 */
export const EMAIL_PROVIDER_REGISTRY = createEmailProviderRegistry([
  smtpDefinition,
  resendDefinition,
])

// Keep the normalized message type referenced at this boundary so a future
// private definition cannot silently widen the FormulaCMS contract to SDK
// message options.
export type RegisteredEmailProviderMessage = FormulaCmsEmailMessage
