"use server"

import { refresh } from "next/cache"
import { api } from "@/convex/_generated/api"
import { fetchAuthMutation } from "@/lib/auth/server"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { isLocalToolRequest } from "@/lib/local-request"
import { requireInstallationOwner } from "@/lib/owner-server"
import {
  assertOfferedLocalToolChoices,
  DEV_AI_CHOICES,
  parseDevAiSelection,
  parseLocalToolChoiceChanges,
  writeDevAiSelection,
  writeLocalToolChoices,
  type DevAiChoice,
  type DevAiSelection,
  type LocalToolChoices,
} from "@/scripts/lib/dev-ai-selection"
import { validateDevAiConnection as validateLocalAiConnection } from "@/scripts/lib/dev-ai-connections"
import { peekLocalToolModels } from "@/scripts/lib/local-tool-models"
import type { AiConnectionStatus } from "@/lib/ai/connection-validation"

// The Development AI selection is machine-local by design (ADR-0032): it is
// written to .formulacms/local/dev-ai.json on the machine running the Next server and
// NEVER into Convex — the deployment is shared, the developer's machine is
// not. This action only exists under `pnpm dev`; a deployed admin renders the
// lane read-only instead.
//
// Deliberately a STATIC import, unlike the sibling block actions, which defer
// their much heavier authoring graph into a lazy chunk: this store module is
// tiny and side-effect-free at load, and the local-development gate guards the
// write. Either way the import must never carry `turbopackIgnore` — that leaves
// the "@/" alias verbatim in the emitted chunk for raw Node to resolve, which
// throws "Cannot find package '@/…'" at call time.

// The Development AI selection is an installation-level, machine-local fact,
// so both reading and writing it use the owner-only seam (matching the other
// F03b source-writing actions). Convex cannot gate an fs write; the check has
// to happen Next-side, before `assertLocalDevelopment`.
async function requireSettingsOwnerAccess(): Promise<void> {
  await requireInstallationOwner(
    "You do not have permission to change AI settings."
  )
}

async function requireSettingsOwnerView(): Promise<void> {
  await requireInstallationOwner(
    "You do not have permission to view AI settings."
  )
}

// The local file and the local tools' status belong to the owner's computer:
// refuse a request from another device (ADR-0057 step 1).
async function requireLocalToolRequest(): Promise<void> {
  if (!(await isLocalToolRequest())) {
    throw new Error(
      "Local tool settings can be changed only in a browser on the computer that runs formulacms."
    )
  }
}

/** The assistants whose local tool choice Convex also knows (its marker). */
const MARKED_ASSISTANTS = ["writing", "translation"] as const

const SAVE_LOCK = Symbol.for("formulacms.localToolChoiceSave")
/**
 * Runs one save after the previous one ended, so two saves (two tabs) never
 * interleave their marker and file writes. One chain per server process, on
 * `globalThis`: module state is lost when `next dev` recompiles
 * (vercel/next.js#72578). A failed save releases the lock.
 */
function oneSaveAtATime<T>(work: () => Promise<T>): Promise<T> {
  const scope = globalThis as typeof globalThis & { [SAVE_LOCK]?: Promise<void> }
  const run = (scope[SAVE_LOCK] ?? Promise.resolve()).then(work)
  scope[SAVE_LOCK] = run.then(
    () => {},
    () => {}
  )
  return run
}

/**
 * Saves the local tool choice of Help, the Block creator, Writing and
 * Translation (Settings › AI on localhost). `null` removes a choice, so the assistant runs with its API
 * service. Returns the saved choices.
 */
export async function saveLocalToolChoices(
  raw: unknown
): Promise<LocalToolChoices> {
  await requireSettingsOwnerAccess()
  await requireLocalToolRequest()
  // The payload crosses the client boundary: validate it here. A changed
  // choice must be on the menu the owner saw; reading it starts no tool.
  const changes = parseLocalToolChoiceChanges(raw)
  assertOfferedLocalToolChoices(changes, peekLocalToolModels())
  // Writing and Translation also carry a marker in Convex, which refuses their
  // API runs while it is set (ADR-0057 decision 2). Set: the marker first,
  // then the file. Clear: the file first, then the marker. A failure between
  // the two leaves the marker set, so the API path refuses rather than bills.
  // A failed marker write throws before the file changes. Saves run one at a
  // time: two interleaved saves could leave a local choice without its marker.
  const marked = MARKED_ASSISTANTS.filter((assistant) => Object.hasOwn(changes, assistant))
  const saved = await oneSaveAtATime(async () => {
    for (const assistant of marked) {
      if (changes[assistant])
        await fetchAuthMutation(api.cms.aiSettings.setAssistantLocalTool, { assistant, on: true })
    }
    const written = writeLocalToolChoices(changes)
    for (const assistant of marked) {
      if (!changes[assistant])
        await fetchAuthMutation(api.cms.aiSettings.setAssistantLocalTool, { assistant, on: false })
    }
    return written
  })
  // The admin layout reads Help's route once (the Help chat); refresh it so
  // Help runs on the new choice without a page reload.
  refresh()
  return saved
}

export async function saveDevAiSelection(
  raw: unknown
): Promise<DevAiSelection> {
  await requireSettingsOwnerAccess()
  assertLocalDevelopment("The Development AI selection")
  await requireLocalToolRequest()
  // The payload crosses the client boundary — re-validate everything here;
  // the client UI constraining choices is convenience, not enforcement.
  const selection = parseDevAiSelection(raw, "dev AI selection")
  return writeDevAiSelection(selection)
}

/** Validate one machine-local connection without generating content. */
export async function checkDevAiConnection(
  raw: unknown
): Promise<AiConnectionStatus> {
  await requireSettingsOwnerView()
  assertLocalDevelopment("Development AI connection checks")
  await requireLocalToolRequest()
  if (
    typeof raw !== "string" ||
    !(DEV_AI_CHOICES as readonly string[]).includes(raw)
  ) {
    throw new Error("Unknown Development AI connection.")
  }
  return validateLocalAiConnection(raw as DevAiChoice)
}
