import { isLocalDevelopment } from "@/lib/assert-local-dev"
import type { EffectiveHelpRoute } from "@/components/admin/help-availability"
import {
  LocalToolRefusedError,
  resolveLocalAiRoute,
} from "./pages/local-ai-routing"

/**
 * Which engine answers Help, for the Help chat and its palette command. Only
 * a local tool chosen for Help in Settings › AI leaves the live-site route
 * (`production`, the Convex action). No status command runs here: a saved
 * choice on a request from this computer is "ready"; the run itself reports
 * a tool that is missing or signed out.
 */
export async function loadDevGroundedHelpRoute(): Promise<EffectiveHelpRoute> {
  if (!isLocalDevelopment()) return { kind: "production" }
  try {
    const route = await resolveLocalAiRoute("grounded-help")
    if (route.engine === "off") return { kind: "production" }
    return { kind: "selected-ready", engine: route.engine }
  } catch (error) {
    // A local tool refused for another device, or a malformed local file:
    // Help stays visible and cannot answer. It never switches to the live-site
    // route, which would bill an API key the owner did not choose for Help.
    return error instanceof LocalToolRefusedError
      ? { kind: "selected-other-device" }
      : { kind: "selected-needs-setup" }
  }
}
