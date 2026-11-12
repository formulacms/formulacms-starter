import type { ComponentType } from "react"
import { AiAddSliceEntry } from "../ai-add-slice-entry"
import { AiModuleSetupLine } from "../ai-settings-screen"
import { Sparkles, type LucideIcon } from "lucide-react"

/** System-owned browser contract for the optional Settings AI navigation item. */
export type AdminAiSettingsNavigationItem = Readonly<{
  key: "ai"
  href: "/admin/settings/ai"
  icon: LucideIcon
  exact: false
}>

export type AdminAiSettingsBrowserBinding = Readonly<{
  navigationItem: AdminAiSettingsNavigationItem
  ModulesSetupLine: ComponentType<{ savedOn: boolean }>
  /** "Add slice" on the Slices list; it gates itself on the AI module state. */
  SlicesAddEntry: ComponentType<{ ready: boolean }>
}>

/** Installed AI settings participant; the host gates it on saved module state. */
export const ADMIN_AI_SETTINGS_BROWSER_BINDING: AdminAiSettingsBrowserBinding | null =
  { ModulesSetupLine: AiModuleSetupLine, SlicesAddEntry: AiAddSliceEntry, navigationItem: { key: "ai", href: "/admin/settings/ai", icon: Sparkles, exact: false } }
