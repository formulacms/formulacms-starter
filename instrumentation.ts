import { validateNextRuntimeEnv } from "@/lib/env"

export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    validateNextRuntimeEnv()
  }
  // Once per server instance, before it takes requests: move a 0.2.0 site's
  // `.nextcms/` folder to `.formulacms/local/` (ADR-0048 amendment, 2026-11-16).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { moveLegacyLocalState } = await import("@/lib/local-state/directory")
    moveLegacyLocalState(process.cwd())
  }
}
