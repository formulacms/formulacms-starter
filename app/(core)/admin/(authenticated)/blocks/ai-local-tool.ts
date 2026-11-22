import "server-only"

import {
  isGenerationErrorCategory,
  type GenerationErrorCategory,
  type ReasoningEffort,
} from "@/lib/ai/execution-contract"
import { createEngine, type EngineImage } from "@/scripts/lib/ai-engine"
import {
  authorizeLocalRun,
  recordLocalAuditBestEffort,
} from "../local-ai-audit"

// One Block creator step on the local tool that Settings › AI chose for it
// (ADR-0057). It runs Claude Code or Codex with the saved model and effort.
// A tool run is not metered (ADR-0053 §D): no accounting; the audit row,
// with how the run was funded, is its record. The owner is authorized when
// the step starts, so the audit is kept even if the session token expires
// during a long run (`../local-ai-audit.ts`). Loaded lazily by
// `ai-actions.ts`, only after the route check allowed the tool.

export type BlockCreatorLocalToolRoute = Readonly<{
  engine: "claude" | "codex"
  model?: string
  effort?: ReasoningEffort
}>

export type BlockCreatorStep = Readonly<{
  instructions: string
  prompt: string
  images: readonly EngineImage[]
  profile: "vision-spec" | "renderer-jsx"
  phase: "block-spec" | "renderer-jsx"
}>

const AUDIT_ENGINES = { claude: "claude-cli", codex: "codex-cli" } as const

function failureCategory(error: unknown): GenerationErrorCategory {
  const category =
    error && typeof error === "object" && "category" in error
      ? error.category
      : undefined
  return isGenerationErrorCategory(category)
    ? category
    : "LOCAL_PROCESS_FAILED"
}

function failureAttempts(error: unknown): 0 | 1 | 2 {
  const attempts =
    error && typeof error === "object" && "attempts" in error
      ? error.attempts
      : undefined
  return attempts === 1 || attempts === 2 ? attempts : 0
}

export async function runBlockCreatorStepOnLocalTool(
  route: BlockCreatorLocalToolRoute,
  step: BlockCreatorStep
): Promise<{ text: string; modelId: string }> {
  const selectedEngine = AUDIT_ENGINES[route.engine]
  const kind =
    step.profile === "vision-spec"
      ? ("block-spec" as const)
      : ("block-renderer" as const)
  const authorization = await authorizeLocalRun()
  let result
  try {
    result = await createEngine(route.engine, {
      ...(route.model !== undefined ? { engineModel: route.model } : {}),
      ...(route.effort !== undefined ? { engineEffort: route.effort } : {}),
    }).generate(step)
  } catch (error) {
    await recordLocalAuditBestEffort(
      {
        kind,
        selectedEngine,
        ...(route.model !== undefined ? { selectedModel: route.model } : {}),
        ...(route.effort !== undefined
          ? { selectedReasoning: route.effort }
          : {}),
        attempts: failureAttempts(error),
        tokenUsage: {},
        success: false,
        errorCode: failureCategory(error),
      },
      authorization
    )
    throw error
  }
  const actual = "actual" in result ? result.actual : undefined
  const usage = result.usage
  await recordLocalAuditBestEffort(
    {
    kind,
    selectedEngine,
    selectedModel: result.selected.model,
    ...(result.selected.effort
      ? { selectedReasoning: result.selected.effort }
      : {}),
    ...(actual?.engine ? { actualEngine: actual.engine } : {}),
    ...(actual?.model ? { actualModel: actual.model } : {}),
    ...(actual?.effort ? { actualReasoning: actual.effort } : {}),
    identityEvidence:
      "identityEvidence" in result
        ? result.identityEvidence
        : ("runtime-observed" as const),
    attempts: result.attempts,
    tokenUsage: {
      ...(usage.inputTokens !== undefined
        ? { promptTokens: usage.inputTokens }
        : {}),
      ...(usage.outputTokens !== undefined
        ? { completionTokens: usage.outputTokens }
        : {}),
      ...(usage.totalTokens !== undefined
        ? { totalTokens: usage.totalTokens }
        : {}),
    },
    success: true,
    },
    authorization
  )
  return { text: result.text, modelId: result.selected.model }
}
