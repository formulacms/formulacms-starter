import type { ComponentType } from "react"
import { AiAddBlockEntry } from "../ai-add-block-entry"
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
  /** "Add block" on the Blocks list; it gates itself on the AI module state. */
  BlocksAddEntry: ComponentType<{ ready: boolean }>
}>

/** Installed AI settings participant; the host gates it on saved module state. */
export const ADMIN_AI_SETTINGS_BROWSER_BINDING: AdminAiSettingsBrowserBinding | null =
  { BlocksAddEntry: AiAddBlockEntry, navigationItem: { key: "ai", href: "/admin/settings/ai", icon: Sparkles, exact: false } }
