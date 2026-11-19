"use server"

import "server-only"

import { createHash, randomBytes } from "node:crypto"
import type { FunctionArgs } from "convex/server"
import { ConvexError } from "convex/values"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { PageOutline } from "@/convex/lib/agents/contentWriterContract"
import { isLocalDevelopment } from "@/lib/assert-local-dev"
import type { LocalToolRoute } from "@/lib/ai/local-engine-run"
import { isLocalToolRequest } from "@/lib/local-request"
import type { PageOutlineArgs } from "./local-ai-run"
import type { PageAiAssistant } from "./local-ai-routing"

// Whole-page Writing and Translation jobs and the outline step on the owner's
// local tool (ADR-0057 decision 2, AI-LOCAL-2). Each action checks, in order:
// local development, the installation owner, a browser on this computer, then
// the assistant's Settings › AI choice. A request from another device is
// refused with a code the screen turns into its message; it never takes an
// API path, which would bill a key the owner did not choose for this run.
// A refusal is a returned value: a thrown error loses its class on the way to
// the browser.
//
// The server modules load lazily: the admin screens import this file, and the
// auth module reads the Convex environment when it loads (screen tests have
// none). Next turns this file into action references for the browser anyway.

const auth = () => import("@/lib/auth/server")
const runner = () => import("@/lib/ai/local-job-runner")
const run = () => import("./local-ai-run")

/** Why a local run did not start. The `AI_*` codes are Convex's own. */
export type LocalAiRefusal =
  /** The browser is not on the computer that runs formulacms. */
  | "LOCAL_TOOL_OTHER_DEVICE"
  /** Settings › AI no longer runs this assistant with a local tool. */
  | "LOCAL_TOOL_NOT_CHOSEN"
  | "AI_JOB_ALREADY_ACTIVE"
  | "AI_JOB_TARGET_HAS_CONTENT"
  | "AI_JOB_SOURCE_TOO_LARGE"
  | "AI_JOB_NOT_RESUMABLE"
  | "AI_JOB_STILL_SETTLING"
  /** The content type's translation switch hides the target language. */
  | "CONTENT_TYPE_TRANSLATION_OFF"

export type LocalAiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: LocalAiRefusal }

type PageJobInput = FunctionArgs<typeof api.cms.aiLocalJobs.startLocalPageJob>["input"]

const CONVEX_REFUSALS = new Set<string>([
  "AI_JOB_ALREADY_ACTIVE",
  "AI_JOB_TARGET_HAS_CONTENT",
  "AI_JOB_SOURCE_TOO_LARGE",
  "AI_JOB_NOT_RESUMABLE",
  "AI_JOB_STILL_SETTLING",
  "CONTENT_TYPE_TRANSLATION_OFF",
])

const refused = (refusal: LocalAiRefusal) => ({ ok: false, refusal }) as const

/** Local development, the owner, this computer: or the refusal to return. */
async function checkLocalRequest(): Promise<LocalAiRefusal | null> {
  if (!isLocalDevelopment()) {
    throw new Error("Local AI tools run only in local development.")
  }
  const { requireInstallationOwner } = await import("@/lib/owner-server")
  await requireInstallationOwner()
  return (await isLocalToolRequest()) ? null : "LOCAL_TOOL_OTHER_DEVICE"
}

/** The assistant's local tool route, or the refusal to return. */
async function localRoute(
  assistant: PageAiAssistant
): Promise<LocalAiResult<LocalToolRoute>> {
  const refusal = await checkLocalRequest()
  if (refusal) return refused(refusal)
  const { loadLocalToolChoice } = await import("./local-ai-routing")
  const choice = await loadLocalToolChoice(assistant)
  return choice ? { ok: true, value: choice } : refused("LOCAL_TOOL_NOT_CHOSEN")
}

/** A new runner secret and the SHA-256 hex that Convex stores. */
function mintRunnerSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url")
  return { secret, hash: createHash("sha256").update(secret).digest("hex") }
}

/** Runs a Convex call; a known refusal code comes back as a value. */
async function convexRefusal<T>(work: () => Promise<T>): Promise<LocalAiResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (
      error instanceof ConvexError &&
      typeof error.data === "string" &&
      CONVEX_REFUSALS.has(error.data)
    )
      return refused(error.data as LocalAiRefusal)
    throw error
  }
}

const assistantOf = (input: PageJobInput): PageAiAssistant => {
  const kind: unknown = input && typeof input === "object" ? input.kind : undefined
  if (kind === "write") return "writing"
  if (kind === "translation") return "translation"
  throw new Error("Unknown page job kind.")
}

/** Starts a whole-page job on the assistant's local tool; returns its id. */
export async function startLocalPageJob(
  input: PageJobInput
): Promise<LocalAiResult<Id<"aiJobs">>> {
  const assistant = assistantOf(input)
  const route = await localRoute(assistant)
  if (!route.ok) return route
  const { secret, hash } = mintRunnerSecret()
  const { fetchAuthMutation } = await auth()
  // Convex checks the rest of the input (`pageJobInputValidator`).
  const started = await convexRefusal(() =>
    fetchAuthMutation(api.cms.aiLocalJobs.startLocalPageJob, {
      input,
      localRoute: route.value,
      runnerSecretHash: hash,
    })
  )
  if (!started.ok) return started
  const { startLocalJobRunner } = await runner()
  void startLocalJobRunner({
    jobId: started.value,
    runnerSecret: secret,
  })
  return started
}

/**
 * Resumes a stopped local job with a new runner secret (the old runner is
 * locked out). The frozen route comes back from Convex with each claim, so
 * this works after a restart of the dev server. The job's assistant must still
 * run with a local tool in Settings › AI; Convex refuses a `kind` that is not
 * the job's.
 */
export async function resumeLocalPageJob(
  jobId: Id<"aiJobs">,
  kind: "write" | "translation"
): Promise<LocalAiResult<null>> {
  if (typeof jobId !== "string") throw new Error("Unknown job.")
  if (kind !== "write" && kind !== "translation") throw new Error("Unknown page job kind.")
  const route = await localRoute(kind === "write" ? "writing" : "translation")
  if (!route.ok) return route
  const { startLocalJobRunner } = await runner()
  const { secret, hash } = mintRunnerSecret()
  const { fetchAuthMutation } = await auth()
  const resumed = await convexRefusal(() =>
    fetchAuthMutation(api.cms.aiLocalJobs.resumeLocalPageJob, {
      jobId,
      kind,
      runnerSecretHash: hash,
    })
  )
  if (!resumed.ok) return resumed
  void startLocalJobRunner({ jobId, runnerSecret: secret })
  return resumed
}

/** The Write page outline step on Writing's local tool. */
export async function generatePageOutlineLocal(
  args: PageOutlineArgs
): Promise<LocalAiResult<PageOutline>> {
  // An assertion function needs a declared type to be called (TS2775).
  const local: typeof import("./local-ai-run") = await run()
  local.validatePageOutlineArgs(args)
  const route = await localRoute("writing")
  if (!route.ok) return route
  return {
    ok: true,
    value: await local.runPageOutlineLocally(
      { brief: args.brief, locale: args.locale },
      route.value
    ),
  }
}
