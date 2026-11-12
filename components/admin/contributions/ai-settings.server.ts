import "server-only"

import { createElement, type ReactNode } from "react"
import { api } from "@/convex/_generated/api"
import { isLocalDevelopment } from "@/lib/assert-local-dev"
import {
  localProviderKeyPresence,
  type LocalProviderKeyPresence,
} from "@/lib/local-api-keys"
import { resolveSliceCreatorSelection } from "@/lib/slices/authoring/creator-selection"
import { AiSettingsRoute } from "../ai-settings-screen"

/** System-owned server contract for the direct Settings AI route body. */
export type AdminAiSettingsServerBinding = Readonly<{
  renderSettingsPage: (props: {
    isLocal: boolean
    /** Local development only: which local API keys exist (booleans). */
    localKeys?: LocalProviderKeyPresence
  }) => ReactNode | Promise<ReactNode>
  /** Whether the Slice creator can run here; the Slices list and Create
   *  slice share it so they never disagree. */
  resolveSliceCreatorReady: () => Promise<boolean>
}>

// Same selection as the slice-authoring server actions, so the Generate
// button never lies about whether the action can run. Any failed read (the
// AI module off included) means "not ready"; the caller never errors. The
// auth client loads inside the read: it needs the deployment's environment,
// which the Settings AI route does not otherwise load.
async function resolveSliceCreatorReady(): Promise<boolean> {
  if (!isLocalDevelopment()) return false
  try {
    const { fetchAuthQuery } = await import("@/lib/auth-server")
    const saved = await fetchAuthQuery(api.cms.aiSettings.sliceCreator, {})
    return resolveSliceCreatorSelection(saved.tuple, localProviderKeyPresence())
      .keyPresent
  } catch {
    return false
  }
}

/** Installed AI settings route; OptionalModuleRoute owns the runtime gate. */
export const ADMIN_AI_SETTINGS_SERVER_BINDING: AdminAiSettingsServerBinding | null =
  { renderSettingsPage: (props) => createElement(AiSettingsRoute, props), resolveSliceCreatorReady }
