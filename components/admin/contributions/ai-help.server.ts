import "server-only"

import { isLocalDevelopment } from "@/lib/assert-local-dev"
import type { AdminContributionRouteData } from "./types"

/** System-owned server contract for the authenticated Help route reader. */
export type AdminAiHelpServerBinding = Readonly<{
  loadRouteData: () =>
    AdminContributionRouteData | Promise<AdminContributionRouteData>
}>

/**
 * Installed Help participant. Its route data is which engine answers Help
 * (`EffectiveHelpRoute`). The live site always answers with its API service
 * and reads nothing here; in local development the route module loads lazily
 * and reads the local file only for a browser on this computer.
 */
export const ADMIN_AI_HELP_SERVER_BINDING: AdminAiHelpServerBinding | null = {
  loadRouteData: async () => {
    if (!isLocalDevelopment()) return { kind: "production" }
    const { loadDevGroundedHelpRoute } =
      await import("@/app/(core)/admin/(authenticated)/help-ai-routing")
    return loadDevGroundedHelpRoute()
  },
}
