import { env, type MutationCtx, type QueryCtx } from "../../_generated/server"
import { readEmailProviderStateDuringMigration } from "./providerMigration"
import { emailProviderEnvironmentReadiness } from "./providerReadiness"

type EmailReadinessContext = QueryCtx | MutationCtx

export type EmailModuleReadiness = Readonly<{
  readiness: "ready" | "needs_setup"
  setup: "not_required" | "required"
}>

const READY: EmailModuleReadiness = {
  readiness: "ready",
  setup: "not_required",
}

const NEEDS_SETUP: EmailModuleReadiness = {
  readiness: "needs_setup",
  setup: "required",
}

/**
 * Returns the sanitized Email module readiness fact from the successor state.
 * Console fallback and configured-but-inactive providers always need setup.
 * Only an active provider with sender identity and current server environment
 * readiness is production-ready.
 */
export async function resolveEmailModuleReadiness(
  ctx: EmailReadinessContext
): Promise<EmailModuleReadiness> {
  const { state } = await readEmailProviderStateDuringMigration(ctx)
  if (state.provider.kind !== "active" || !state.sender) return NEEDS_SETUP

  return emailProviderEnvironmentReadiness(
    state.provider.providerId,
    env as unknown as Readonly<Record<string, string | undefined>>
  ) === "ready"
    ? READY
    : NEEDS_SETUP
}
