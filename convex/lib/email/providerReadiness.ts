import { ConvexError } from "convex/values"
import {
  EMAIL_PROVIDER_ENVIRONMENT,
  isRegisteredEmailProviderId,
} from "./providerMetadata"
import type { EmailProviderEnvironmentReadiness } from "./providerState"

export type EmailProviderEnvironmentVariableStatus = Readonly<{
  name: string
  required: boolean
  present: boolean
}>

export type EmailProviderEnvironmentStatus = Readonly<{
  readiness: EmailProviderEnvironmentReadiness
  variables: readonly EmailProviderEnvironmentVariableStatus[]
}>

/**
 * Server-side readiness shared by owner APIs and the Node adapter registry.
 * It returns variable names and whether each is present, never a value,
 * fragment, prefix, suffix, or length. A variable is present when its value
 * is not empty after trimming. The provider is ready when every required
 * variable is present; an optional variable never blocks.
 */
export function emailProviderEnvironmentStatus(
  providerId: string,
  environment: Readonly<Record<string, string | undefined>>
): EmailProviderEnvironmentStatus {
  if (!isRegisteredEmailProviderId(providerId)) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_UNREGISTERED")
  }
  const variables = EMAIL_PROVIDER_ENVIRONMENT[providerId].map(
    ({ name, required }) => ({
      name,
      required,
      present: Boolean(environment[name]?.trim()),
    })
  )
  return {
    readiness: variables.every(({ required, present }) => !required || present)
      ? "ready"
      : "needs_setup",
    variables,
  }
}

export function emailProviderEnvironmentReadiness(
  providerId: string,
  environment: Readonly<Record<string, string | undefined>>
): EmailProviderEnvironmentReadiness {
  return emailProviderEnvironmentStatus(providerId, environment).readiness
}
