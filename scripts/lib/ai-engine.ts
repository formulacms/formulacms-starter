import type { GenerationAccounting } from "@/lib/ai/accounting-contract"
import { assertLocalToolRoute } from "@/lib/assert-local-dev"
// AIEngine seam for the build-lane block-authoring scripts (ADR-0032, Plan 026).
//
// Two lanes exist in formulacms. The RUNTIME lane (Convex actions) is BYOK-only and
// lives elsewhere; it never imports this file. This is the BUILD lane: local
// developer-machine scripts that may drive a subscription CLI (`claude`, later
// `codex`) OR a BYOK API engine (`openrouter`, `anthropic`, or `openai`). The
// engine is chosen per run — `--engine` flag > FORMULACMS_DEV_AI_ENGINE >
// "openrouter" — and never appears in Settings, onboarding, or any
// Convex/deployment config.
//
// Phase 0 finding (plans/026-phase0-findings.md): `claude -p` has no image flag;
// images go in via the Read tool from an ISOLATED cwd (a repo-rooted run makes
// the CLI agentic and it refuses to emit a spec). The seam therefore takes image
// FILE PATHS, and each engine delivers them its own way: API engines
// base64-encode them into the message; claude stages them into a temp cwd and
// prepends a Read preamble. The shared base `prompt` stays byte-for-byte
// identical across engines.

import type {
  ApiProvider,
  GenerationResult,
  ReasoningEffort,
  TaskProfile,
  WorkflowPhase,
} from "@/lib/ai/execution-contract"
import { generateWithLocalApi, type EngineImage } from "./ai-api-engine"
import { BUNDLED_MODEL_CATALOG } from "@/lib/ai/model-catalog"
import {
  executeClaudeCliGeneration,
  type ClaudeCliExecutionDeps,
} from "./claude-cli-execution"
import {
  executeCodexCliGeneration,
  type CodexCliExecutionDeps,
} from "./codex-cli-execution"
import type { ClaudeCliTupleOverride } from "./claude-cli-adapter"
import type { SubscriptionCliTupleOverride } from "./subscription-cli-capabilities"
import type { SubscriptionCliGenerationResult } from "./subscription-cli-contract"

export type { EngineImage } from "./ai-api-engine"

export type EngineId =
  "openrouter" | "anthropic" | "openai" | "claude" | "codex"

export interface GenerateRequest {
  /** Trusted workflow instructions; staged for subscription CLIs. */
  instructions: string
  /** Shared base prompt — byte-for-byte identical across engines. Via stdin. */
  prompt: string
  /** Image FILE PATHS (never base64); each engine delivers them its own way. */
  images: readonly EngineImage[]
  /** Task profile → per-engine model + effort. */
  profile: TaskProfile
  /** Explicit workflow phase retained in normalized failures and audit seams. */
  phase: WorkflowPhase
  /** Optional caller cancellation shared by local API engines. */
  signal?: AbortSignal
  /** Optional caller deadline capped by the shared five-minute local ceiling. */
  deadlineMs?: number
}

export interface AIEngine {
  readonly id: EngineId
  generate(req: GenerateRequest): Promise<EngineGenerationResult>
}

export type EngineGenerationResult =
  GenerationResult<string> | SubscriptionCliGenerationResult

export interface EngineOptions {
  accounting?: GenerationAccounting
  /** Operator model override, always validated with engineEffort as one tuple. */
  engineModel?: string
  /** Reasoning override, validated with engineModel for the selected engine. */
  engineEffort?: ReasoningEffort
  /** Injection seams for tests (fixture transcripts, no real CLI). */
  claudeDeps?: ClaudeCliExecutionDeps
  codexDeps?: CodexCliExecutionDeps
}

// ─── Engine resolution ──────────────────────────────────────────────────────

export const ENGINE_IDS: readonly EngineId[] = [
  "openrouter",
  "anthropic",
  "openai",
  "claude",
  "codex",
]

export function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as readonly string[]).includes(value)
}

/**
 * Precedence: explicit `--engine` flag > FORMULACMS_DEV_AI_ENGINE env > "openrouter".
 * Throws on an unrecognized value rather than silently falling back, so a typo
 * in the flag or env fails loudly.
 */
export function resolveEngineId(
  flag: string | undefined,
  env: string | undefined = process.env.FORMULACMS_DEV_AI_ENGINE?.trim()
    ? process.env.FORMULACMS_DEV_AI_ENGINE
    : process.env.NEXTCMS_DEV_AI_ENGINE
): EngineId {
  const raw = (flag ?? env ?? "openrouter").trim()
  if (!isEngineId(raw)) {
    throw new Error(
      `Unknown AI engine "${raw}". Valid engines: ${ENGINE_IDS.join(", ")}. ` +
        `Set --engine or FORMULACMS_DEV_AI_ENGINE.`
    )
  }
  return raw
}

export function createEngine(id: EngineId, opts: EngineOptions = {}): AIEngine {
  switch (id) {
    case "openrouter":
    case "anthropic":
    case "openai":
      return new ApiEngine(
        id,
        opts.engineModel,
        opts.engineEffort,
        opts.accounting
      )
    case "claude":
      return new ClaudeEngine(
        subscriptionOverride(opts) as ClaudeCliTupleOverride | undefined,
        opts.claudeDeps
      )
    case "codex":
      return new CodexEngine(subscriptionOverride(opts), opts.codexDeps)
  }
}

function subscriptionOverride(
  options: Pick<EngineOptions, "engineModel" | "engineEffort">
): SubscriptionCliTupleOverride | undefined {
  const model = options.engineModel
  const effort = options.engineEffort
  if ((model === undefined) !== (effort === undefined)) {
    throw new Error(
      "Subscription CLI overrides require both --engine-model and --engine-effort."
    )
  }
  if (model === undefined || effort === undefined) return undefined
  return { model, effort }
}

// ─── Local BYOK API engines ─────────────────────────────────────────────────

class ApiEngine implements AIEngine {
  constructor(
    readonly id: ApiProvider,
    private readonly model?: string,
    private readonly effort?: ReasoningEffort,
    private readonly accounting?: GenerationAccounting
  ) {}

  generate(req: GenerateRequest): Promise<GenerationResult<string>> {
    return generateWithLocalApi(
      {
        provider: this.id,
        instructions: req.instructions,
        prompt: req.prompt,
        images: req.images,
        profile: req.profile,
        phase: req.phase,
        model: this.model,
        effort: this.effort,
        catalog: BUNDLED_MODEL_CATALOG,
        signal: req.signal,
        deadlineMs: req.deadlineMs,
      },
      this.accounting
    )
  }
}

class ClaudeEngine implements AIEngine {
  readonly id = "claude" as const
  constructor(
    private readonly override?: ClaudeCliTupleOverride,
    private readonly deps: ClaudeCliExecutionDeps = {}
  ) {}

  async generate(
    req: GenerateRequest
  ): Promise<SubscriptionCliGenerationResult> {
    assertLocalToolRoute(this.id)
    return executeClaudeCliGeneration(
      {
        systemPrompt: req.instructions,
        prompt: req.prompt,
        images: req.images,
        profile: req.profile,
        phase: req.phase,
        override: this.override,
        signal: req.signal,
        deadlineMs: req.deadlineMs,
      },
      this.deps
    )
  }
}

// ─── Codex subscription CLI engine ──────────────────────────────────────────
//
// Enabled 2026-07-13. Its identity evidence is `selected-only`: `codex exec
// --json` does not expose the resolved starting model/effort, so the run proves
// what it SELECTED (argv validated against the installed `model/list` catalog)
// and never fabricates an `actual`. That is an honest success state, not a
// failure — see the 2026-07-13 owner amendment in the switching contract.
//
// The tuple is fixed at gpt-6.1-sol/high by the committed task profiles, so
// --engine-model/--engine-effort have nothing to override here yet; a partial
// override still fails loudly at engine creation.

class CodexEngine implements AIEngine {
  readonly id = "codex" as const
  constructor(
    private readonly override?: SubscriptionCliTupleOverride,
    private readonly deps: CodexCliExecutionDeps = {}
  ) {}

  async generate(
    req: GenerateRequest
  ): Promise<SubscriptionCliGenerationResult> {
    assertLocalToolRoute(this.id)
    return executeCodexCliGeneration(
      {
        systemPrompt: req.instructions,
        prompt: req.prompt,
        images: req.images,
        profile: req.profile,
        phase: req.phase,
        override: this.override,
        signal: req.signal,
        deadlineMs: req.deadlineMs,
      },
      this.deps
    )
  }
}
