"use node"

import { resend } from "@opencoredev/email-sdk/resend"
import { REGISTERED_EMAIL_PROVIDER_METADATA } from "../providerMetadata"
import { emailProviderEnvironmentReadiness } from "../providerReadiness"
import {
  adaptSdkAdapter,
  defineRegisteredEmailProvider,
  needsSetup,
  parseEmptyConfiguration,
  type RegisteredEmailProviderDefinition,
} from "./contract.node"
import type { RegisteredEmailProviderId } from "../providerMetadata"

const resendMetadata = REGISTERED_EMAIL_PROVIDER_METADATA.find(
  (metadata) => metadata.id === "resend"
)!

export const resendDefinition = defineRegisteredEmailProvider({
  metadata: resendMetadata,
  readiness(context) {
    return emailProviderEnvironmentReadiness("resend", context.environment)
  },
  parseConfiguration: parseEmptyConfiguration,
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
