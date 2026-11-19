import "server-only"

import { isLocalDevelopment } from "@/lib/assert-local-dev"

import type { AdminAiWritingRouteData } from "./ai-writing"

/** Content Editor-owned server contract for the Writing route reader. */
export type AdminAiWritingServerBinding = Readonly<{
  loadRouteData: () =>
    AdminAiWritingRouteData | Promise<AdminAiWritingRouteData>
}>

/**
 * Installed Writing participant. Its route data is the local tool that runs
 * Writing for this browser (`{ engine }`), or null for its API service. The
 * live site reads nothing here; in local development the route module loads
 * lazily and reads the local file only for the owner on this computer.
 */
export const ADMIN_AI_WRITING_SERVER_BINDING: AdminAiWritingServerBinding | null =
  {
    loadRouteData: async () => {
      if (!isLocalDevelopment())
        return { editorialCopy: null, structuredOutlineMeta: null }
      const { loadLocalToolEngine } =
        await import("@/app/(core)/admin/(authenticated)/pages/local-ai-routing")
      const engine = await loadLocalToolEngine("writing")
      return { editorialCopy: engine, structuredOutlineMeta: engine }
    },
  }
