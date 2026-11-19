import "server-only"

import type {
  GenerationErrorCategory,
  ReasoningEffort,
} from "@/lib/ai/execution-contract"
import {
  createEngine,
  type EngineGenerationResult,
  type EngineId,
  type GenerateRequest,
} from "@/scripts/lib/ai-engine"

// One run of the selected local engine, without any request API (no cookies,
// no headers, no owner check), so both a server action and the local job
// runner (`local-job-runner.ts`) can use it. Every run goes through
// `createEngine`, so the engine's own checks run for every run (for Claude
// Code, the Fable check before each run). Moved from `pages/ai-actions.ts`
// (starter-excluded) so the shipped local job code can use it.

export type LocalAuditEngine =
  | "openrouter-api"
  | "anthropic-api"
  | "openai-api"
  | "claude-cli"
  | "codex-cli"

export const LOCAL_AUDIT_ENGINES = {
  openrouter: "openrouter-api",
  anthropic: "anthropic-api",
  openai: "openai-api",
  claude: "claude-cli",
  codex: "codex-cli",
} as const satisfies Record<EngineId, LocalAuditEngine>

/** A local tool route frozen for a run: the tool, its model and its effort. */
export type LocalToolRoute = Readonly<{
  engine: "claude" | "codex"
  model: string
  effort: ReasoningEffort
}>

export function generationResultFailure(
  error: unknown,
  generation: EngineGenerationResult,
  category: GenerationErrorCategory
): Error & {
  readonly category: GenerationErrorCategory
  readonly selected: EngineGenerationResult["selected"]
  readonly attempts: EngineGenerationResult["attempts"]
} {
  const safe =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined
  const message =
    error instanceof Error
      ? error.message
      : typeof safe?.data === "string"
        ? safe.data
        : "The selected local AI returned incomplete or invalid output."
  return Object.assign(new Error(message, { cause: error }), {
    category,
    selected: generation.selected,
    ...("actual" in generation && generation.actual
      ? { actual: generation.actual }
      : {}),
    ...("identityEvidence" in generation
      ? { identityEvidence: generation.identityEvidence }
      : {}),
    attempts: generation.attempts,
  })
}

/** Throws unless every result names the selected engine, model and effort. */
export function assertGenerationResultsUseSelectedEngine(
  engineId: EngineId,
  results: readonly EngineGenerationResult[],
  route?: {
    readonly model?: string
    readonly effort?: ReasoningEffort
  }
): void {
  const expected = LOCAL_AUDIT_ENGINES[engineId]
  for (const result of results) {
    if (result.selected.lane !== "local-build") {
      throw new Error("Local generation returned a different selected lane.")
    }
    if (result.selected.engine !== expected) {
      throw new Error(
        "Local generation returned a different selected engine identity."
      )
    }
    if (route?.model !== undefined && result.selected.model !== route.model) {
      throw new Error(
        "Local generation returned a different selected model identity."
      )
    }
    if (
      route?.effort !== undefined &&
      result.selected.effort !== route.effort
    ) {
      throw new Error(
        "Local generation returned a different selected reasoning identity."
      )
    }

    if (engineId === "codex") {
      if (
        !("identityEvidence" in result) ||
        result.identityEvidence !== "selected-only" ||
        ("actual" in result && result.actual)
      ) {
        throw new Error(
          "Codex generation must remain selected-only without observed identity."
        )
      }
      continue
    }

    if (
      !("actual" in result) ||
      !result.actual ||
      result.actual.engine !== expected
    ) {
      throw new Error(
        "Local generation returned a different observed engine identity."
      )
    }
    if (
      engineId === "claude" &&
      (!("identityEvidence" in result) ||
        result.identityEvidence !== "transcript-observed")
    ) {
      throw new Error(
        "Claude generation must include transcript-observed identity."
      )
    }
  }
}

/**
 * Runs one generation on a local tool with the route's model and effort and
 * checks that the result names that route. A mismatch fails as
 * `VALIDATION_FAILED`. The request's `signal` stops the tool process.
 */
export async function generateWithLocalTool(
  route: LocalToolRoute,
  request: GenerateRequest
): Promise<EngineGenerationResult> {
  const engine = createEngine(route.engine, {
    engineModel: route.model,
    engineEffort: route.effort,
  })
  const generation = await engine.generate(request)
  try {
    assertGenerationResultsUseSelectedEngine(route.engine, [generation], route)
  } catch (error) {
    throw generationResultFailure(error, generation, "VALIDATION_FAILED")
  }
  return generation
}
