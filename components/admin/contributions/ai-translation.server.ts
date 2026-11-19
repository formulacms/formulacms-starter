import "server-only"

import { isLocalDevelopment } from "@/lib/assert-local-dev"

import type { AdminAiTranslationRouteData } from "./ai-translation"

/** Content Editor-owned server contract for the Translation route reader. */
export type AdminAiTranslationServerBinding = Readonly<{
  loadRouteData: () =>
    AdminAiTranslationRouteData | Promise<AdminAiTranslationRouteData>
}>

/**
 * Installed Translation participant. Its route data is the local tool that
 * runs Translation for this browser (`{ engine }`), or null for its API
 * service. The live site reads nothing here; in local development the route
 * module loads lazily and reads the local file only for the owner on this
 * computer.
 */
export const ADMIN_AI_TRANSLATION_SERVER_BINDING: AdminAiTranslationServerBinding | null =
  {
    loadRouteData: async () => {
      if (!isLocalDevelopment())
        return { mechanicalTranslation: null, brandTranslation: null }
      const { loadLocalToolEngine } =
        await import("@/app/(core)/admin/(authenticated)/pages/local-ai-routing")
      const engine = await loadLocalToolEngine("translation")
      return { mechanicalTranslation: engine, brandTranslation: engine }
    },
  }
