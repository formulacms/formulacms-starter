import "server-only"

import { createHash } from "node:crypto"
import { api } from "@/convex/_generated/api"
import { AGENTS, languageName } from "@/convex/lib/agents/registry"
import {
  assembleOutline,
  buildPageOutlineGenerationInput,
  type PageOutline,
} from "@/convex/lib/agents/contentWriterContract"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { fetchAuthAction } from "@/lib/auth/server"
import { prependAssistantInstructions } from "@/lib/ai/task-profiles"
import { createLocalAccounting } from "@/lib/ai/local-accounting"
import type {
  GenerationErrorCategory,
  GenerationUsage,
  ReasoningEffort,
} from "@/lib/ai/execution-contract"
import { isGenerationErrorCategory } from "@/lib/ai/execution-contract"
import {
  assertGenerationResultsUseSelectedEngine,
  generationResultFailure,
  LOCAL_AUDIT_ENGINES,
  type LocalAuditEngine,
} from "@/lib/ai/local-engine-run"
import {
  createEngine,
  type AIEngine,
  type EngineGenerationResult,
  type EngineId,
} from "@/scripts/lib/ai-engine"
import {
  authorizeLocalRun,
  recordLocalAuditBestEffort,
} from "../local-ai-audit"

// The audited run of the selected local engine for a server action: the owner
// is authorized at run start and one audit row is recorded after the run
// (`local-ai-audit.ts`). Shared by the development-lane page actions
// (`ai-actions.ts`, starter-excluded) and the shipped local page job actions
// (`local-ai-job-actions.ts`). A plain server-only module: a "use server" file
// may export only server actions.

export type LocalAuditKind =
  | "field-translate"
  | "page-translate"
  | "field-generate"
  | "field-refine"
  | "block-generate"
  | "page-generate-fill"
  | "page-generate-meta"
  | "page-generate-outline"

export type LocalAuditMetadata = {
  readonly briefHash?: string
  readonly blockCount?: number
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
  kind: LocalAuditKind,
  selectedEngine: LocalAuditEngine,
  result: EngineGenerationResult
) {
  const selectedReasoning: ReasoningEffort | undefined = result.selected.effort
  if ("identityEvidence" in result) {
    const actual = result.actual
    return {
      kind,
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
    kind,
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

export function failureAudit(
  kind: LocalAuditKind,
  selectedEngine: LocalAuditEngine,
  route: { readonly model?: string; readonly effort?: ReasoningEffort },
  error: unknown
) {
  const safe =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined
  const selected = recordField(error, "selected")
  const actual = recordField(error, "actual")
  const selectedReasoning = reasoningField(selected?.effort) ?? route.effort
  const selectedModel =
    route.model ??
    (typeof selected?.model === "string" ? selected.model : undefined)
  const identityEvidence:
    | "runtime-observed"
    | "transcript-observed"
    | "selected-only"
    | undefined =
    safe?.identityEvidence === "runtime-observed" ||
    safe?.identityEvidence === "transcript-observed" ||
    safe?.identityEvidence === "selected-only"
      ? safe.identityEvidence
      : undefined
  const actualEngine =
    actual?.engine === selectedEngine ? selectedEngine : undefined
  const actualModel =
    actualEngine && typeof actual?.model === "string" ? actual.model : undefined
  const actualReasoning = actualEngine
    ? reasoningField(actual?.effort)
    : undefined
  const compatibleIdentityEvidence =
    selectedEngine === "codex-cli"
      ? identityEvidence === "selected-only"
        ? identityEvidence
        : undefined
      : actualEngine &&
          identityEvidence ===
            (selectedEngine === "claude-cli"
              ? "transcript-observed"
              : "runtime-observed")
        ? identityEvidence
        : undefined
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
    kind,
    selectedEngine,
    ...(selectedModel ? { selectedModel } : {}),
    ...(selectedReasoning ? { selectedReasoning } : {}),
    ...(actualEngine ? { actualEngine } : {}),
    ...(actualModel ? { actualModel } : {}),
    ...(actualReasoning ? { actualReasoning } : {}),
    ...(compatibleIdentityEvidence
      ? { identityEvidence: compatibleIdentityEvidence }
      : {}),
    attempts,
    tokenUsage: {},
    success: false,
    errorCode,
  }
}

export async function runSelectedLocalEngine<T>(
  kind: LocalAuditKind,
  route: {
    readonly engine: EngineId | "off"
    readonly model?: string
    readonly effort?: ReasoningEffort
  },
  run: (
    engine: AIEngine,
    validateGeneration: (generation: EngineGenerationResult) => void
  ) => Promise<{
    value: T
    generation?: EngineGenerationResult
    auditMetadata?: LocalAuditMetadata
  }>,
  auditMetadata: LocalAuditMetadata = {}
): Promise<T> {
  const engineId = route.engine
  if (engineId === "off") {
    throw new Error("A disabled local AI route cannot run an engine.")
  }
  // The owner at run start: the audit after a long run is signed with it.
  const authorization = await authorizeLocalRun()
  const accounting = createLocalAccounting()
  let completed: {
    value: T
    generation?: EngineGenerationResult
    auditMetadata?: LocalAuditMetadata
  }
  try {
    const engine = createEngine(engineId, {
      accounting,
      ...(route.model !== undefined ? { engineModel: route.model } : {}),
      ...(route.effort !== undefined ? { engineEffort: route.effort } : {}),
    })
    const validateGeneration = (generation: EngineGenerationResult): void => {
      try {
        assertGenerationResultsUseSelectedEngine(engineId, [generation], route)
      } catch (error) {
        throw generationResultFailure(error, generation, "VALIDATION_FAILED")
      }
    }
    completed = await run(engine, validateGeneration)
    if (completed.generation) {
      validateGeneration(completed.generation)
    }
  } catch (error) {
    await recordLocalAuditBestEffort(
      {
        ...failureAudit(kind, LOCAL_AUDIT_ENGINES[engineId], route, error),
        ...auditMetadata,
      },
      authorization,
      accounting
    )
    throw error
  }

  if (!completed.generation) return completed.value

  await recordLocalAuditBestEffort(
    {
      ...successAudit(
        kind,
        LOCAL_AUDIT_ENGINES[engineId],
        completed.generation
      ),
      ...auditMetadata,
      ...completed.auditMetadata,
    },
    authorization,
    accounting
  )
  return completed.value
}

const MAX_OUTLINE_BRIEF_CHARS = 2_000

export interface PageOutlineArgs {
  readonly brief: string
  readonly locale: string
}

/** The outline step's input crosses the client boundary: check it here. */
export function validatePageOutlineArgs(
  value: PageOutlineArgs
): asserts value is PageOutlineArgs {
  const input: unknown = value
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Page-outline input must be an object.")
  }
  const raw = input as Record<string, unknown>
  if (typeof raw.brief !== "string") {
    throw new Error("brief must be a string")
  }
  if (typeof raw.locale !== "string") {
    throw new Error("locale must be a string")
  }
  if (raw.brief.length > MAX_OUTLINE_BRIEF_CHARS) {
    throw new Error("Brief too long.")
  }
  if (!raw.brief.trim()) {
    throw new Error("Brief is empty.")
  }
}

/**
 * The page outline step on a local tool route: Convex supplies the prompt
 * template, brand voice and the assistant's Instructions (`preflight`), the
 * tool writes the outline, and one audit row is recorded. Shared by the
 * development-lane `generatePageOutline` and the shipped
 * `generatePageOutlineLocal`.
 */
export async function runPageOutlineLocally(
  args: PageOutlineArgs,
  route: {
    readonly engine: EngineId | "off"
    readonly model?: string
    readonly effort?: ReasoningEffort
  }
): Promise<PageOutline> {
  assertLocalDevelopment("Development-lane page outline")
  const preflight = await fetchAuthAction(
    api.agents.localGeneration.preflight,
    { kind: "page-generate-outline" }
  )
  if (!preflight.userPromptTemplate) {
    throw new Error("Content generation prompt configuration is unavailable.")
  }
  const generationInput = buildPageOutlineGenerationInput({
    systemTemplate: AGENTS.content.defaultSystemPrompt,
    userTemplate: preflight.userPromptTemplate,
    language: languageName(args.locale),
    brief: args.brief,
    brandVoice: preflight.brandVoice ?? undefined,
  })
  const briefHash = createHash("sha256").update(args.brief).digest("hex")
  return runSelectedLocalEngine(
    "page-generate-outline",
    route,
    async (engine, validateGeneration) => {
      const generation = await engine.generate({
        ...generationInput,
        instructions: prependAssistantInstructions(
          preflight.assistantInstructions,
          generationInput.instructions
        ),
        images: [],
        profile: preflight.profile,
        phase: preflight.phase,
      })
      validateGeneration(generation)
      let value: PageOutline
      try {
        value = assembleOutline(generation.text)
      } catch (error) {
        throw generationResultFailure(error, generation, "INVALID_OUTPUT")
      }
      return {
        value,
        generation,
        auditMetadata: { blockCount: value.outline.length },
      }
    },
    { briefHash }
  )
}
