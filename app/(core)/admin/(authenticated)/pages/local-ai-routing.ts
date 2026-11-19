import { isLocalDevelopment } from "@/lib/assert-local-dev"
import type { TaskProfile } from "@/lib/ai/execution-contract"
import { isLocalToolRequest } from "@/lib/local-request"
import { requireInstallationOwner } from "@/lib/owner-server"
import {
  LOCAL_TOOL_ASSISTANT_TASKS,
  localToolChoicesOf,
  readDevAiSelection,
  resolveDevAiTaskSelection,
  type DevAiChoice,
  type DevAiTaskEffectiveSelection,
  type LocalToolAssistant,
  type LocalToolChoice,
} from "@/scripts/lib/dev-ai-selection"

// The one place that turns the saved local AI selection into a route
// (ADR-0057 step 1). Routing (what the admin shows) and every server action
// (what runs) read the route here, so both apply the same rule: a local tool
// (Claude Code, Codex) runs only in local development AND for a browser on
// this computer (`isLocalToolRequest`). From another device the local file is
// not read: Help and the Block creator are refused and never switch to an API
// service or to the Convex route, because that would bill a key the owner did
// not choose for this run; page-editor tasks take the production route (seat
// decision, review round 1, 2026-11-15).

export const LOCAL_TOOL_REFUSED_MESSAGE =
  "Local AI tools run only in a browser on the computer that runs formulacms. Open the admin on that computer, or choose an API connection in Settings › AI."

export class LocalToolRefusedError extends Error {
  constructor() {
    super(LOCAL_TOOL_REFUSED_MESSAGE)
    this.name = "LocalToolRefusedError"
  }
}

export type ResolveLocalAiRoute = (
  profile: TaskProfile
) => DevAiTaskEffectiveSelection

const PRODUCTION_ROUTE: DevAiTaskEffectiveSelection = Object.freeze({
  engine: "off",
})

/**
 * The assistants this resolver runs only on their Settings › AI choice and
 * refuses from another device. Writing and Translation keep the page-task rule
 * here (the field actions of the development lane): Convex refuses their API
 * runs while their local tool marker is set, so another device can still use
 * them when they run with an API service. Their whole-page jobs and the outline
 * step read only their choice (`loadLocalToolChoice`).
 */
const CHOICE_ONLY_ASSISTANTS = ["help", "sliceCreator"] as const satisfies
  readonly LocalToolAssistant[]

/** The choice-only assistant that owns a task profile, if any. */
function localToolAssistantOf(
  profile: TaskProfile
): LocalToolAssistant | undefined {
  return CHOICE_ONLY_ASSISTANTS.find((assistant) =>
    (LOCAL_TOOL_ASSISTANT_TASKS[assistant] as readonly string[]).includes(
      profile
    )
  )
}

/**
 * Checks the owner and the request once, then reads the saved selection and
 * resolves any number of task profiles. Outside local development every
 * profile is "off" and nothing runs here. In local development the owner check
 * comes first (it throws for anyone else), so no local file is read for a
 * caller who is not the installation owner.
 * A request that is not from this computer never reads the local file: Help
 * and the Block creator are refused (`LocalToolRefusedError`, never their API
 * service, which would switch billing), and every other profile takes the
 * production route.
 * On this computer, Help and the Block creator take only the local tool choice
 * that Settings › AI saved for them (`localToolChoicesOf`); without one they
 * are "off" (their API route), whatever the file's top-level engine says, so
 * the screen always shows what runs. Throws on a malformed selection file.
 */
export async function loadLocalAiRouteResolver(): Promise<ResolveLocalAiRoute> {
  if (!isLocalDevelopment()) return () => PRODUCTION_ROUTE
  await requireInstallationOwner()
  if (!(await isLocalToolRequest())) {
    return (profile) => {
      if (localToolAssistantOf(profile)) throw new LocalToolRefusedError()
      return PRODUCTION_ROUTE
    }
  }
  const selection = readDevAiSelection()
  const choices = localToolChoicesOf(selection)
  return (profile) => {
    const assistant = localToolAssistantOf(profile)
    return assistant
      ? (choices[assistant] ?? PRODUCTION_ROUTE)
      : resolveDevAiTaskSelection(selection, profile)
  }
}

/** Writing and Translation: the two assistants with whole-page jobs. */
export type PageAiAssistant = Extract<LocalToolAssistant, "writing" | "translation">

/**
 * The local tool that Settings › AI chose for Writing or Translation, or null
 * when its API service runs it. Only the saved choice counts, never the file's
 * top-level engine, so the screen always shows what runs. The checks run in
 * the resolver's order: outside local development null; the owner first (it
 * throws for anyone else); a request from another device is refused
 * (`LocalToolRefusedError`) without reading the file. Throws on a malformed
 * selection file.
 */
export async function loadLocalToolChoice(
  assistant: PageAiAssistant
): Promise<LocalToolChoice | null> {
  if (!isLocalDevelopment()) return null
  await requireInstallationOwner()
  if (!(await isLocalToolRequest())) throw new LocalToolRefusedError()
  return localToolChoicesOf(readDevAiSelection())[assistant] ?? null
}

/**
 * Route data of the Writing and Translation slots. `{ engine }`: the owner on
 * this computer, and the local tool that runs the assistant, or null for its
 * API service. `null`: not this computer (or not local development, not the
 * owner, a malformed file); the file is not read for another device. The
 * screen then takes the API path, which Convex refuses while the assistant's
 * local tool marker is set, and shows why.
 */
export async function loadLocalToolEngine(
  assistant: PageAiAssistant
): Promise<{ readonly engine: LocalToolChoice["engine"] | null } | null> {
  if (!isLocalDevelopment()) return null
  try {
    const choice = await loadLocalToolChoice(assistant)
    return { engine: choice?.engine ?? null }
  } catch {
    return null
  }
}

/** The effective local route for one task profile; see the resolver above. */
export async function resolveLocalAiRoute(
  profile: TaskProfile
): Promise<DevAiTaskEffectiveSelection> {
  return (await loadLocalAiRouteResolver())(profile)
}

export type DevTaskRouting = {
  readonly engine: Exclude<DevAiChoice, "off">
} | null

export type DevPageAiRouting = {
  readonly mechanicalTranslation: DevTaskRouting
  readonly brandTranslation: DevTaskRouting
  readonly editorialCopy: DevTaskRouting
  readonly structuredOutlineMeta: DevTaskRouting
}

const UNAVAILABLE: DevPageAiRouting = {
  mechanicalTranslation: null,
  brandTranslation: null,
  editorialCopy: null,
  structuredOutlineMeta: null,
}

/**
 * Expose only which local page-editor task routes are reachable. Authenticated
 * actions resolve the route again at execution time; this controls visibility.
 * Anyone but the owner, or a request from another device, sees none.
 */
export async function loadDevPageAiRouting(): Promise<DevPageAiRouting> {
  if (!isLocalDevelopment()) return UNAVAILABLE
  let resolve: ResolveLocalAiRoute
  try {
    resolve = await loadLocalAiRouteResolver()
  } catch {
    return UNAVAILABLE
  }

  const load = (
    profile:
      | "mechanical-translation"
      | "brand-translation"
      | "editorial-copy"
      | "structured-outline-meta"
  ): DevTaskRouting => {
    try {
      const route = resolve(profile)
      return route.engine === "off" ? null : { engine: route.engine }
    } catch {
      return null
    }
  }

  return {
    mechanicalTranslation: load("mechanical-translation"),
    brandTranslation: load("brand-translation"),
    editorialCopy: load("editorial-copy"),
    structuredOutlineMeta: load("structured-outline-meta"),
  }
}
