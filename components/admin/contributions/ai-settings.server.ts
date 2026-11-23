import "server-only"

import { createElement, type ReactNode } from "react"
import { api } from "@/convex/_generated/api"
import { isLocalDevelopment } from "@/lib/assert-local-dev"
import type { LocalProviderKeyPresence } from "@/lib/local-api-keys"
import { localProviderKeyPresenceNow } from "@/lib/local-api-keys-file"
import { isLocalToolRequest } from "@/lib/local-request"
import { resolveBlockCreatorSelection } from "@/lib/blocks/authoring/creator-selection"
import { AiSettingsRoute, type LocalToolsData } from "../ai-settings-screen"

/** System-owned server contract for the direct Settings AI route body. */
export type AdminAiSettingsServerBinding = Readonly<{
  renderSettingsPage: (props: {
    isLocal: boolean
    /** Local development only: which local API keys exist (booleans). */
    localKeys?: LocalProviderKeyPresence
    /** A browser on this computer only: the local tools and their choices. */
    localTools?: LocalToolsData
  }) => ReactNode | Promise<ReactNode>
  /** The local tools for Settings › AI; `undefined` unless the owner, with
   *  the AI module on, asks from this computer in local development. */
  loadLocalTools: () => Promise<LocalToolsData | undefined>
  /** Whether the Block creator can run here; the Blocks list and Create
   *  block share it so they never disagree. */
  resolveBlockCreatorReady: () => Promise<boolean>
}>

// Same route and selection as the block-authoring server actions, so the
// Generate button never lies about whether the action can run. A local tool
// chosen for the Block creator in Settings › AI is ready for a browser on
// this computer (no API key needed); another device is not ready. Any failed
// read (the AI module off included) means "not ready"; the caller never
// errors. The auth client and the route module load inside the read: they
// need the deployment's environment and the local file, which the Settings
// AI route does not otherwise load. The reads run in order, so the local file
// is read only after the owner check and the saved settings (which refuse
// while the AI module is off) succeed.
async function resolveBlockCreatorReady(): Promise<boolean> {
  if (!isLocalDevelopment()) return false
  try {
    const [{ requireInstallationOwner }, { fetchAuthQuery }] = await Promise.all([
      import("@/lib/owner-server"),
      import("@/lib/auth/server"),
    ])
    await requireInstallationOwner()
    const saved = await fetchAuthQuery(api.cms.aiSettings.blockCreator, {})
    const { resolveLocalAiRoute } = await import(
      "@/app/(core)/admin/(authenticated)/pages/local-ai-routing"
    )
    const route = await resolveLocalAiRoute("vision-spec")
    if (route.engine === "claude" || route.engine === "codex") return true
    return resolveBlockCreatorSelection(saved.tuple, localProviderKeyPresenceNow())
      .keyPresent
  } catch {
    return false
  }
}

// The Settings page renders while its layout checks the session (a layout
// does not stop its page), and before the client redirects away when the AI
// module is off. So the owner and the module are checked here, before any
// local effect. Any failed check shows no local tools.
async function mayShowLocalTools(): Promise<boolean> {
  if (!isLocalDevelopment()) return false
  try {
    const [{ requireInstallationOwner }, { fetchAuthQuery }] = await Promise.all([
      import("@/lib/owner-server"),
      import("@/lib/auth/server"),
    ])
    await requireInstallationOwner()
    const { modules } = await fetchAuthQuery(api.cms.modules.effective, {})
    // The same states in which OptionalModuleRoute renders the AI screen.
    const ai = modules.find((module) => module.id === "ai")?.outcome
    if (ai !== "on" && ai !== "needs_setup") return false
  } catch {
    return false
  }
  return isLocalToolRequest()
}

// ADR-0057 step 1: the local tools are shown, checked and read only for the
// owner, with the AI module on, in a browser on this computer. Otherwise
// neither the status commands run nor the local file is read. Only the
// sign-in method leaves this function, never vendor output. A malformed local
// file shows no saved choice (saving then refuses rather than overwrite it).
async function loadLocalTools(): Promise<LocalToolsData | undefined> {
  if (!(await mayShowLocalTools())) return undefined
  // Loaded here only: these modules run local commands and read the local
  // file, so no other page (and no live site) loads them.
  const [{ inspectLocalTools }, selection, { saveLocalToolChoices }, { loadLocalToolModels }] = await Promise.all([
    import("@/scripts/lib/dev-ai-connections"),
    import("@/scripts/lib/dev-ai-selection"),
    import("@/app/(core)/admin/(authenticated)/settings/ai/actions"),
    import("@/scripts/lib/local-tool-models"),
  ])
  let choices = {}
  try {
    choices = selection.readLocalToolChoices()
  } catch {
    // Shown as "no local tool chosen".
  }
  const status = await inspectLocalTools()
  // The installed tools list their models, Claude Code with the plan (cached
  // 1 hour; a failed read keeps the last list or the committed one). Claude
  // gets its raw sign-in, so a change of sign-in method drops the plan.
  const models = await loadLocalToolModels({ codex: status.codex, claude: status.claudeSignIn })
  return {
    tools: (["claude", "codex"] as const).map((tool) => ({ tool, status: status[tool] })),
    choices,
    menus: selection.localToolMenus(models),
    // The plan's closed name from the cached list read, never the raw string.
    ...(models.claude.plan ? { claudePlan: models.claude.plan } : {}),
    save: saveLocalToolChoices,
  }
}

/** Installed AI settings route; OptionalModuleRoute owns the runtime gate. */
export const ADMIN_AI_SETTINGS_SERVER_BINDING: AdminAiSettingsServerBinding | null =
  { renderSettingsPage: (props) => createElement(AiSettingsRoute, { ...props, siteFolder: process.cwd() }), resolveBlockCreatorReady, loadLocalTools }
