import "server-only"

import type { AdminContributionRouteData } from "./types"

/** System-owned server contract for the authenticated Help route reader. */
export type AdminAiHelpServerBinding = Readonly<{
  loadRouteData: () =>
    AdminContributionRouteData | Promise<AdminContributionRouteData>
}>

/** Installed Help participant. It needs no server data: no read, no key, no environment access. */
export const ADMIN_AI_HELP_SERVER_BINDING: AdminAiHelpServerBinding | null =
  { loadRouteData: () => null }
