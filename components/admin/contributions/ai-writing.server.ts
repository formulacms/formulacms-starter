import "server-only"

import type { AdminAiWritingRouteData } from "./ai-writing"

/** Content Editor-owned server contract for the Writing route reader. */
export type AdminAiWritingServerBinding = Readonly<{
  loadRouteData: () =>
    AdminAiWritingRouteData | Promise<AdminAiWritingRouteData>
}>

/** Installed Writing participant. It needs no server data: no read, no key, no environment access. */
export const ADMIN_AI_WRITING_SERVER_BINDING: AdminAiWritingServerBinding | null =
  {
    loadRouteData: () => ({ editorialCopy: null, structuredOutlineMeta: null }),
  }
