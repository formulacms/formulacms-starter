import { ConvexError } from "convex/values"
import { isRegisteredEmailProviderId } from "./providerMetadata"
import type { EmailProviderEnvironmentReadiness } from "./providerState"

/**
 * Server-side readiness shared by owner APIs and the Node adapter registry.
 * It returns only a bounded status and never projects a credential value,
 * fragment, or length.
 */
export function emailProviderEnvironmentReadiness(
  providerId: string,
  environment: Readonly<Record<string, string | undefined>>
): EmailProviderEnvironmentReadiness {
  if (!isRegisteredEmailProviderId(providerId)) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_UNREGISTERED")
  }
  return environment.RESEND_API_KEY?.trim() ? "ready" : "needs_setup"
}
