"use server"

import { createLocalAccounting } from "@/lib/ai/local-accounting"
import "server-only"

import { ConvexError } from "convex/values"
import { api } from "@/convex/_generated/api"
import { AGENTS } from "@/convex/lib/agents/registry"
import {
  buildHelpGenerationInput,
  parseHelpGenerationOutput,
} from "@/convex/lib/help/workflow"
import {
  assertLocalDevelopment,
  isLocalDevelopment,
} from "@/lib/assert-local-dev"
import { fetchAuthAction } from "@/lib/auth/server"
import { prependAssistantInstructions } from "@/lib/ai/task-profiles"
import type {
  GenerationErrorCategory,
  GenerationUsage,
  ReasoningEffort,
} from "@/lib/ai/execution-contract"
import { isGenerationErrorCategory } from "@/lib/ai/execution-contract"
import {
  createEngine,
  type EngineGenerationResult,
  type EngineId,
} from "@/scripts/lib/ai-engine"
import {
  authorizeLocalRun,
  recordLocalAuditBestEffort,
} from "./local-ai-audit"
import {
  LocalToolRefusedError,
  resolveLocalAiRoute,
} from "./pages/local-ai-routing"

const MAX_QUESTION_CHARS = 2_000
const MAX_ROUTE_CHARS = 500

type LocalAuditEngine =
  "openrouter-api" | "anthropic-api" | "openai-api" | "claude-cli" | "codex-cli"

const LOCAL_AUDIT_ENGINES = {
  openrouter: "openrouter-api",
  anthropic: "anthropic-api",
  openai: "openai-api",
  claude: "claude-cli",
  codex: "codex-cli",
} as const satisfies Record<EngineId, LocalAuditEngine>

export type HelpAnswer = {
  answer: string
  sources: string[]
  suggestedAction?: { id: string; label: string; href: string }
}

/** A failure comes back as its category: a thrown error loses it on the way
 *  to the browser. "OTHER" is any failure without a known category. */
export type HelpChatAnswer =
  | { ok: true; answer: HelpAnswer }
  | {
      ok: false
      category: GenerationErrorCategory | "OTHER"
      /** A local tool was chosen for this question (its own notices apply). */
      localTool: boolean
    }

export type HelpQuestionArgs = {
  question: string
  route?: string
}

function validateHelpQuestionArgs(
  value: HelpQuestionArgs
): asserts value is HelpQuestionArgs {
  const input: unknown = value
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Help input must be an object.")
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (key !== "question" && key !== "route") {
      throw new Error(`Unexpected help input field: ${key}`)
    }
  }
  if (typeof raw.question !== "string") {
    throw new Error("question must be a string")
  }
  if (raw.route !== undefined && typeof raw.route !== "string") {
    throw new Error("route must be a string")
  }
  if (!raw.question.trim()) throw new Error("Question is empty.")
  if (raw.question.length > MAX_QUESTION_CHARS) {
    throw new Error("Question too long.")
  }
  if (typeof raw.route === "string" && raw.route.length > MAX_ROUTE_CHARS) {
    throw new Error("Route too long.")
  }
}

function auditTokenUsage(usage: GenerationUsage) {
  return {
    ...(usage.inputTokens !== undefined
      ? { promptTokens: usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { completionTokens: usage.outputTokens }
      : {}),
    ...(usage.totalTokens !== undefined
      ? { totalTokens: usage.totalTokens }
      : {}),
  }
}

function successAudit(
  selectedEngine: LocalAuditEngine,
  result: EngineGenerationResult
) {
  const selectedReasoning: ReasoningEffort | undefined = result.selected.effort
  if ("identityEvidence" in result) {
    const actual = result.actual
    return {
      kind: "help-answer" as const,
      selectedEngine,
      selectedModel: result.selected.model,
      ...(selectedReasoning ? { selectedReasoning } : {}),
      ...(actual
        ? {
            actualEngine: actual.engine,
            actualModel: actual.model,
            actualReasoning: actual.effort,
          }
        : {}),
      identityEvidence: result.identityEvidence,
      attempts: result.attempts,
      tokenUsage: auditTokenUsage(result.usage),
      success: true,
    }
  }

  return {
    kind: "help-answer" as const,
    selectedEngine,
    selectedModel: result.selected.model,
    ...(selectedReasoning ? { selectedReasoning } : {}),
    ...(result.actual.engine ? { actualEngine: result.actual.engine } : {}),
    ...(result.actual.model ? { actualModel: result.actual.model } : {}),
    ...(result.actual.effort ? { actualReasoning: result.actual.effort } : {}),
    identityEvidence: "runtime-observed" as const,
    attempts: result.attempts,
    tokenUsage: auditTokenUsage(result.usage),
    success: true,
  }
}

function recordField(
  value: unknown,
  key: string
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const field = (value as Record<string, unknown>)[key]
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined
}

function reasoningField(value: unknown): ReasoningEffort | undefined {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined
}

function failureAudit(
  selectedEngine: LocalAuditEngine,
  route: {
    readonly model?: string
    readonly effort?: ReasoningEffort
  },
  error: unknown
) {
  const safe =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined
  const selected = recordField(error, "selected")
  const selectedReasoning = route.effort ?? reasoningField(selected?.effort)
  const attempts: 0 | 1 | 2 =
    safe?.attempts === 0 || safe?.attempts === 1 || safe?.attempts === 2
      ? safe.attempts
      : 0
  const errorCode: GenerationErrorCategory = isGenerationErrorCategory(
    safe?.category
  )
    ? safe.category
    : "LOCAL_PROCESS_FAILED"

  return {
    kind: "help-answer" as const,
    selectedEngine,
    ...(route.model ? { selectedModel: route.model } : {}),
    ...(selectedReasoning ? { selectedReasoning } : {}),
    attempts,
    tokenUsage: {},
    success: false,
    errorCode,
  }
}

function generationResultFailure(
  error: unknown,
  generation: EngineGenerationResult,
  category: GenerationErrorCategory
): Error & {
  readonly category: GenerationErrorCategory
  readonly attempts: EngineGenerationResult["attempts"]
} {
  const message =
    error instanceof Error
      ? error.message
      : "The selected local AI returned incomplete or invalid help output."
  return Object.assign(new Error(message, { cause: error }), {
    category,
    attempts: generation.attempts,
  })
}

function assertGenerationUsesSelectedRoute(
  engineId: EngineId,
  route: { readonly model?: string; readonly effort?: ReasoningEffort },
  result: EngineGenerationResult
): void {
  const expected = LOCAL_AUDIT_ENGINES[engineId]
  if (result.selected.lane !== "local-build") {
    throw new Error("Local help returned a different selected lane.")
  }
  if (result.selected.engine !== expected) {
    throw new Error("Local help returned a different selected engine identity.")
  }
  if (route.model !== undefined && result.selected.model !== route.model) {
    throw new Error("Local help returned a different selected model identity.")
  }
  if (route.effort !== undefined && result.selected.effort !== route.effort) {
    throw new Error(
      "Local help returned a different selected reasoning identity."
    )
  }

  if (engineId === "codex") {
    if (
      !("identityEvidence" in result) ||
      result.identityEvidence !== "selected-only" ||
      ("actual" in result && result.actual)
    ) {
      throw new Error(
        "Codex help must remain selected-only without observed identity."
      )
    }
    return
  }

  if (
    !("actual" in result) ||
    !result.actual ||
    result.actual.engine !== expected
  ) {
    throw new Error("Local help returned a different observed engine identity.")
  }
  if (
    engineId === "claude" &&
    (!("identityEvidence" in result) ||
      result.identityEvidence !== "transcript-observed")
  ) {
    throw new Error("Claude help must include transcript-observed identity.")
  }
}

/** Answer one read-only help question through the effective Development route. */
export async function answerHelpQuestion(
  args: HelpQuestionArgs
): Promise<HelpAnswer> {
  return answerHelp(args, { localTool: false })
}

/** Set once the question goes to a local tool, so a failure gets its notice. */
type HelpRouteSeen = { localTool: boolean }

async function answerHelp(
  args: HelpQuestionArgs,
  seen: HelpRouteSeen
): Promise<HelpAnswer> {
  validateHelpQuestionArgs(args)
  if (!isLocalDevelopment()) {
    return fetchAuthAction(api.agents.helpAssistant.answer, args)
  }

  // Checks the owner before the local file is read, and refuses a local tool
  // from another device; never falls back (ADR-0057).
  const route = await resolveLocalAiRoute("grounded-help")
  if (route.engine === "off") {
    return fetchAuthAction(api.agents.helpAssistant.answer, args)
  }
  seen.localTool = true

  assertLocalDevelopment("Development-lane grounded help")
  const preflight = await fetchAuthAction(
    api.agents.localGeneration.preflight,
    { kind: "help-answer" }
  )
  if (!preflight.userPromptTemplate) {
    throw new Error("Help prompt configuration is unavailable.")
  }
  const input = buildHelpGenerationInput({
    question: args.question,
    route: args.route,
    systemPrompt: AGENTS["help-assistant"].defaultSystemPrompt,
    userPromptTemplate: preflight.userPromptTemplate,
  })
  const selectedEngine = LOCAL_AUDIT_ENGINES[route.engine]

  // The owner at run start: the audit after a long run is signed with it.
  const authorization = await authorizeLocalRun()
  const accounting = createLocalAccounting()
  let generation: EngineGenerationResult
  let parsed: ReturnType<typeof parseHelpGenerationOutput>
  try {
    const engine = createEngine(route.engine, {
      accounting,
      ...(route.model !== undefined ? { engineModel: route.model } : {}),
      ...(route.effort !== undefined ? { engineEffort: route.effort } : {}),
    })
    generation = await engine.generate({
      instructions: prependAssistantInstructions(
        preflight.assistantInstructions,
        input.system
      ),
      prompt: input.prompt,
      images: [],
      profile: preflight.profile,
      phase: preflight.phase,
    })
    try {
      assertGenerationUsesSelectedRoute(route.engine, route, generation)
    } catch (error) {
      throw generationResultFailure(error, generation, "VALIDATION_FAILED")
    }
    try {
      parsed = parseHelpGenerationOutput(generation.text)
    } catch (error) {
      throw generationResultFailure(error, generation, "INVALID_OUTPUT")
    }
  } catch (error) {
    await recordLocalAuditBestEffort(
      failureAudit(selectedEngine, route, error),
      authorization,
      accounting
    )
    throw error
  }

  await recordLocalAuditBestEffort(
    successAudit(selectedEngine, generation),
    authorization,
    accounting
  )
  return {
    answer: parsed.answer,
    sources: input.sources,
    ...(parsed.suggestedAction
      ? { suggestedAction: parsed.suggestedAction }
      : {}),
  }
}

function helpFailureCategory(
  error: unknown
): GenerationErrorCategory | "OTHER" {
  // A local tool chosen for Help but refused for this browser needs setup.
  if (error instanceof LocalToolRefusedError) return "CONFIG_MISSING"
  const data: unknown = error instanceof ConvexError ? error.data : error
  if (!data || typeof data !== "object") return "OTHER"
  // The rate limiter's own refusal (`isRateLimitError`, @convex-dev/rate-limiter).
  if ("kind" in data && data.kind === "RateLimited") return "RATE_LIMITED"
  return "category" in data && isGenerationErrorCategory(data.category)
    ? data.category
    : "OTHER"
}

/**
 * The Help chat's call in local development, whatever Help runs with: the
 * route is resolved here, when the question is sent, never from what the
 * screen showed when it loaded. A local tool answers with the saved choice;
 * otherwise Help's API service answers through Convex, as on the live site.
 * A failure is returned as its category and whether a local tool ran it,
 * never replaced by an answer from another engine.
 */
export async function askHelp(args: HelpQuestionArgs): Promise<HelpChatAnswer> {
  const seen: HelpRouteSeen = { localTool: false }
  try {
    return { ok: true, answer: await answerHelp(args, seen) }
  } catch (error) {
    const category = helpFailureCategory(error)
    return {
      ok: false,
      category,
      localTool: seen.localTool || error instanceof LocalToolRefusedError,
    }
  }
}
