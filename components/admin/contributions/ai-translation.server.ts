import "server-only"

import type { AdminAiTranslationRouteData } from "./ai-translation"

/** Content Editor-owned server contract for the Translation route reader. */
export type AdminAiTranslationServerBinding = Readonly<{
  loadRouteData: () =>
    AdminAiTranslationRouteData | Promise<AdminAiTranslationRouteData>
}>

/** Installed Translation participant. It needs no server data: no read, no key, no environment access. */
export const ADMIN_AI_TRANSLATION_SERVER_BINDING: AdminAiTranslationServerBinding | null =
  {
    loadRouteData: () => ({ mechanicalTranslation: null, brandTranslation: null }),
  }
