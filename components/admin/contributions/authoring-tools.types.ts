import type { ComponentType, ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

/** System-owned browser contract for the Settings "Slices" navigation item. */
export type AdminAuthoringToolsSettingsNavigationItem = Readonly<{
  key: "slices"
  href: "/admin/slices"
  icon: LucideIcon
  exact: false
}>

/**
 * Slice library and design tools (D-6). Source keeps its local authoring loop;
 * the starter ships no participant.
 */
export type AdminAuthoringToolsBrowserBinding = Readonly<{
  settingsNavigationItem: AdminAuthoringToolsSettingsNavigationItem
  /** The development-only Design system entry on the General settings page. */
  SettingsDesignSystemEntry: ComponentType
  /** Wraps the admin shell so a Slice Type deletion can show its progress. */
  DeletionOverlay: ComponentType<{ children: ReactNode }>
}>

/** Local slice-verification scenario requested by the editor route's `?verify=`. */
export type AdminAuthoringToolsVerificationScenario =
  "proposal" | "decomposition" | "renderer-failure" | "archive-read-failure"

export type AdminAuthoringToolsServerBinding = Readonly<{
  resolveVerificationScenario: (
    value: string | string[] | undefined
  ) => AdminAuthoringToolsVerificationScenario | null
}>
