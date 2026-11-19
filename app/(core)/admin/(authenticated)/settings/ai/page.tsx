import { notFound } from "next/navigation"

import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "@/components/admin/contributions/ai-settings.server"
import { localProviderKeyPresenceNow } from "@/lib/local-api-keys-file"

export default async function AiSettingsPage() {
  if (!ADMIN_AI_SETTINGS_SERVER_BINDING) notFound()
  const isLocal = process.env.NODE_ENV !== "production"
  if (!isLocal) return ADMIN_AI_SETTINGS_SERVER_BINDING.renderSettingsPage({ isLocal })
  // Local development only: which local keys .env.local holds now, as
  // booleans; never a value.
  // The local tools come only for a browser on this computer.
  const localTools = await ADMIN_AI_SETTINGS_SERVER_BINDING.loadLocalTools()
  return ADMIN_AI_SETTINGS_SERVER_BINDING.renderSettingsPage({
    isLocal,
    localKeys: localProviderKeyPresenceNow(),
    ...(localTools ? { localTools } : {}),
  })
}
