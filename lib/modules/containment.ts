/**
 * Minimal observable containment for optional module participation (M01
 * recovery design RG8). A required host that proceeds without a failed
 * participant (public routing, an admin route) calls this at its catch site so
 * the failure is never mistaken for "disabled" or "no match". It only writes a
 * console error: no persisted failure table, alert pipeline, or health panel.
 */

export const MODULE_PARTICIPATION_FAILED = "CMS_MODULE_PARTICIPATION_FAILED"

export type ContainedModuleBoundary =
  | "proxy.resolve"
  | "proxy.key-cache"
  | "admin.route"
  | "admin.effective-readiness"
  | "admin.contribution"
  | "admin.shell-module-state"

export function reportContainedModuleFailure(
  moduleId: string,
  boundary: ContainedModuleBoundary,
  error: unknown
): void {
  console.error(
    `[${MODULE_PARTICIPATION_FAILED}] module=${moduleId} boundary=${boundary}`,
    {
      code: MODULE_PARTICIPATION_FAILED,
      moduleId,
      boundary,
      cause: error instanceof Error ? error.message : String(error),
    }
  )
}
