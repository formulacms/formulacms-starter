import { notFound } from "next/navigation"

import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "@/components/admin/contributions/ai-settings.server"
import { localProviderKeyPresence } from "@/lib/local-api-keys"

export default async function AiSettingsPage() {
  if (!ADMIN_AI_SETTINGS_SERVER_BINDING) notFound()
  const isLocal = process.env.NODE_ENV !== "production"
  // Local development only: which local keys exist, as booleans; never a value.
  return ADMIN_AI_SETTINGS_SERVER_BINDING.renderSettingsPage(
    isLocal ? { isLocal, localKeys: localProviderKeyPresence() } : { isLocal }
  )
}
