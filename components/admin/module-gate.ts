import { ConvexError } from "convex/values"

export type ModuleGateState = "loading" | "off" | "needs_setup" | "on" | "error"

export type ModuleGate =
  | { state: "loading" | "off" | "on" }
  | { state: "needs_setup"; setup: readonly string[] }
  | { state: "error"; errorCode?: "CMS_MODULE_READINESS_FAILED" }

/** Exact typed/serialized Convex refusals, never a substring of arbitrary copy. */
export function moduleFailureState(
  error: unknown
): "off" | "needs_setup" | "error" {
  const code = error instanceof ConvexError ? error.data : undefined
  const lines =
    error instanceof Error
      ? error.message.split(/\r?\n/).map((line) => line.trim())
      : []
  if (
    code === "CMS_MODULE_DISABLED" ||
    lines.includes("Uncaught ConvexError: CMS_MODULE_DISABLED")
  )
    return "off"
  if (
    code === "CMS_MODULE_NOT_READY" ||
    lines.includes("Uncaught ConvexError: CMS_MODULE_NOT_READY")
  )
    return "needs_setup"
  return "error"
}

/** Static entries remain available for setup, but never while state is unknown. */
export function showsModuleEntry(gate: ModuleGate): boolean {
  return gate.state === "on" || gate.state === "needs_setup"
}

export function isModuleConfigurationStale(error: unknown): boolean {
  const codes = ["CMS_MODULE_CONFIGURATION_STALE", "LANGUAGE_OPERATION_STALE"]
  if (error instanceof ConvexError && codes.includes(String(error.data)))
    return true
  const lines =
    error instanceof Error
      ? error.message.split(/\r?\n/).map((line) => line.trim())
      : []
  return codes.some((code) => lines.includes(`Uncaught ConvexError: ${code}`))
}
