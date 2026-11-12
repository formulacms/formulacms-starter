import { MODULE_CATALOG } from "@/lib/modules/catalog"
import type { ModuleDescriptorV1 } from "@/lib/modules/types"

/**
 * F08d optional admin UI slots. Core admin surfaces open an optional
 * subscription or render an optional control only when the installed-code
 * profile has a participant in the owning slot.
 *
 * The profile is a compile-time constant. Nothing here reads module state, so
 * "not installed" is installed-code absence, never owner disablement. Gating an
 * installed participant on enablement belongs to its owning module, which must
 * first close the open F07 load/initialize-failure recovery gate.
 */

export const ADMIN_CONTRIBUTION_SLOTS = [
  "admin.sidebar-status",
  "admin.list-search",
  "admin.page-history",
  "admin.ai-settings",
  "admin.ai-writing",
  "admin.ai-translation",
  "admin.ai-help",
] as const

export type AdminContributionSlot = (typeof ADMIN_CONTRIBUTION_SLOTS)[number]

export type AdminContributionParticipant = Readonly<{
  moduleId: string
  contribution: AdminContributionSlot
}>

export type AdminContributionProfile = Readonly<
  Record<AdminContributionSlot, AdminContributionParticipant | null>
>

/**
 * Composes static registrations into at most one participant per slot. Only an
 * optional catalog module that declares the slot may own a participant.
 */
export function composeAdminContributions(
  registrations: readonly AdminContributionParticipant[],
  catalog: readonly ModuleDescriptorV1[] = MODULE_CATALOG
): AdminContributionProfile {
  const profile: Record<
    AdminContributionSlot,
    AdminContributionParticipant | null
  > = {
    "admin.sidebar-status": null,
    "admin.list-search": null,
    "admin.page-history": null,
    "admin.ai-settings": null,
    "admin.ai-writing": null,
    "admin.ai-translation": null,
    "admin.ai-help": null,
  }
  for (const registration of registrations) {
    const descriptor = catalog.find(
      (candidate) => candidate.id === registration.moduleId
    )
    if (
      !ADMIN_CONTRIBUTION_SLOTS.includes(registration.contribution) ||
      !descriptor ||
      descriptor.required ||
      !descriptor.contributions.includes(registration.contribution)
    ) {
      throw new Error(
        `Module "${registration.moduleId}" cannot contribute "${registration.contribution}".`
      )
    }
    if (profile[registration.contribution]) {
      throw new Error(
        `Admin slot "${registration.contribution}" already has a participant.`
      )
    }
    profile[registration.contribution] = Object.freeze({ ...registration })
  }
  return Object.freeze(profile)
}

/** AI settings, Writing, Translation and Help are installed; their hosts read the saved module gate. */
export const INSTALLED_ADMIN_CONTRIBUTIONS = composeAdminContributions([
  { moduleId: "ai", contribution: "admin.ai-settings" },
  { moduleId: "ai", contribution: "admin.ai-writing" },
  { moduleId: "ai", contribution: "admin.ai-translation" },
  { moduleId: "ai", contribution: "admin.ai-help" },
])

export function isAdminContributionInstalled(
  slot: AdminContributionSlot,
  profile: AdminContributionProfile = INSTALLED_ADMIN_CONTRIBUTIONS
): boolean {
  return profile[slot] !== null
}

/**
 * `effectiveModuleIds` comes from the server-owned effective module state.
 * `null`/`undefined` means still loading or unavailable and fails closed.
 */
export type EffectiveModuleIds = ReadonlySet<string> | null | undefined

/**
 * Participant-level enablement gate (the F07 follow-up named above), applied
 * on the real render seam: the `ADMIN_AI_*_BROWSER_BINDING` / `_SERVER_BINDING`
 * constants in `components/admin/contributions/ai-*.ts`. A binding is returned
 * only while its owning module is effectively enabled; a missing binding, a
 * disabled or unknown module, or an unknown effective state (`null` or
 * `undefined`) all yield `null`, so nothing renders.
 *
 * Hosts (`page-editor.tsx`, `new-page-form.tsx`, `command-palette.tsx`, the
 * settings layout, the admin shell) must read an `ADMIN_AI_*_BINDING` only
 * through `gatedBinding` once any participant exists. Nothing calls it yet:
 * every shipped binding is `null`. Step 2 of the AI plan rewires the hosts and
 * needs a small owner-only "current effective module ids" query to supply
 * `effectiveModuleIds`; today the client's only effective-state read is the
 * `api.cms.modules.preview` query.
 */
export function gatedBinding<T>(
  binding: T | null,
  moduleId: string,
  effectiveModuleIds: EffectiveModuleIds
): T | null {
  if (binding === null || !effectiveModuleIds) return null
  return effectiveModuleIds.has(moduleId) ? binding : null
}
