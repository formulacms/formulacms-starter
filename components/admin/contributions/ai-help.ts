import type { ComponentType, ReactNode } from "react"
import { HelpParticipant } from "../ai-help/help-participant"

import type { AdminCommand } from "../command-palette"
import type { AdminContributionRouteData } from "./types"

/** Values the System host renders from the optional Help participant. */
export type AdminAiHelpHostResult = Readonly<{
  command: AdminCommand | null
  panel: ReactNode | null
}>

/** Neutral System-owned inputs for the command-palette Help mount. */
export type AdminAiHelpHostProps = Readonly<{
  routeData: AdminContributionRouteData
  query: string
  route: string
  children: (result: AdminAiHelpHostResult) => ReactNode
}>

export type AdminAiHelpBrowserBinding = ComponentType<AdminAiHelpHostProps>

/** Installed Help participant: the floating Help chat and its palette command; it gates itself on the AI module. */
export const ADMIN_AI_HELP_BROWSER_BINDING: AdminAiHelpBrowserBinding | null =
  HelpParticipant
