import "server-only"

import type { FunctionArgs } from "convex/server"
import { api } from "@/convex/_generated/api"
import { signLocalAiAudit } from "@/convex/lib/localAiAuditProof"
import type { GenerationAccounting } from "@/lib/ai/accounting-contract"
import { fundingForAuditEngine } from "@/lib/ai/local-tool-funding"
import { fetchAuthMutation } from "@/lib/auth/server"
import { requireInstallationOwner } from "@/lib/owner-server"

// The audit row of a local AI run (Help, the Block creator, the page editor).
// A tool run can outlive the 60-second access token, and a server action
// cannot refresh it, so the owner is authorized when the run STARTS and that
// authorization (owner, time, attempt) is signed into the audit. Convex then
// records the row with the live session or, once the token has expired, with
// that recent signed authorization, once per attempt
// (`convex/agents/localGeneration.ts`, `recordAudit`). A plain server-only
// module: a "use server" file may export only server actions.

export type LocalRunAuthorization = Readonly<{
  authId: string
  /** When the owner was checked, ms since the epoch (before the run). */
  authorizedAt: number
  /** This run's own attempt identifier, for a tool run with no admitted
   *  spending attempt (a tool run writes none). */
  attemptId: string
}>

export type LocalAuditEvent = Omit<
  FunctionArgs<typeof api.agents.localGeneration.recordAudit>,
  | "auditProofExpiresAt"
  | "auditProofSignature"
  | "funding"
  | "authId"
  | "authorizedAt"
  | "attemptId"
>

const LOCAL_TOOL_AUDIT_ENGINES: ReadonlySet<string> = new Set([
  "claude-cli",
  "codex-cli",
])

/** Call before a run starts; throws (the run is refused) unless the caller is
 *  the installation owner. */
export async function authorizeLocalRun(): Promise<LocalRunAuthorization> {
  const owner = await requireInstallationOwner()
  return {
    authId: owner.authId,
    authorizedAt: Date.now(),
    attemptId: crypto.randomUUID(),
  }
}

/**
 * Signs and records one audit row. Best effort: it never throws, so it never
 * replaces the run's result or failure. No owner check runs here: after a
 * long run the token may have expired, and the signed authorization stands in.
 * An admitted spending attempt (an API engine run) keeps its own attempt key;
 * an API engine row without one keeps the pre-admission path (no attempt id).
 */
export async function recordLocalAuditBestEffort(
  event: LocalAuditEvent,
  authorization: LocalRunAuthorization,
  accounting?: GenerationAccounting
): Promise<void> {
  try {
    // A tool run records how it was billed; API-engine rows carry no funding.
    const funding = await fundingForAuditEngine(event.selectedEngine)
    const attemptId =
      accounting?.anchorAttemptKey ??
      (LOCAL_TOOL_AUDIT_ENGINES.has(event.selectedEngine)
        ? authorization.attemptId
        : undefined)
    const signed = await signLocalAiAudit({
      ...event,
      ...(funding ? { funding } : {}),
      authId: authorization.authId,
      authorizedAt: authorization.authorizedAt,
      ...(attemptId ? { attemptId } : {}),
    })
    await fetchAuthMutation(api.agents.localGeneration.recordAudit, signed)
  } catch {
    // Audit stays best effort and must not replace the answer or generation
    // failure returned by the selected engine.
  }
}
