import {
  REASONING_EFFORTS,
  TASK_PROFILES,
  type CapabilitySource,
  type InputModality,
  type ReasoningEffort,
  type TaskProfile,
} from "../../lib/ai/execution-contract"
import { isNotOffered } from "../../lib/ai/model-catalog"

export type SubscriptionCliEngine = "claude-cli" | "codex-cli"

function source(value: CapabilitySource): Readonly<CapabilitySource> {
  return Object.freeze(value)
}

export const SUBSCRIPTION_CLI_SOURCES = Object.freeze({
  "claude-cli": Object.freeze([
    source({
      url: "https://code.claude.com/docs/en/cli-reference",
      retrievedAt: "2026-11-15",
      claim:
        "Official CLI reference: claude -p is non-interactive print mode; --model accepts the sonnet, opus, haiku, and fable aliases or a full model name; --effort accepts named levels whose availability depends on the selected model.",
    }),
    source({
      url: "https://code.claude.com/docs/en/model-config",
      retrievedAt: "2026-11-15",
      claim:
        "Official model configuration: haiku, sonnet, and opus resolve to the newest version on the Anthropic API; fable is its own alias (Fable 5.2, Claude Code v2.1.321 or later), is never a plan default, and may bill to usage credits, without a prompt under -p; Settings offers it only on a Max or Ultra plan or an API-key sign-in. Opus 5.5, Sonnet 5.5, and Haiku 5.5 accept low, medium, high, xhigh, and max.",
    }),
  ]),
  "codex-cli": Object.freeze([
    source({
      url: "https://learn.chatgpt.com/codex/models",
      retrievedAt: "2026-11-15",
      claim:
        "Official Codex models page: gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, and gpt-6-luna are the recommended models and gpt-6-sol replaces gpt-5.4; gpt-5.5, gpt-5.4, and gpt-5.4-mini are retired for ChatGPT sign-in and gpt-5.3-codex-spark is retired on every Codex surface.",
    }),
    source({
      url: "https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/models-manager/models.json",
      retrievedAt: "2026-11-15",
      claim:
        "Codex CLI 0.169.0 bundled catalog: gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, and gpt-6-sol take low through ultra; gpt-6-luna takes low through max.",
    }),
    source({
      url: "https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md",
      retrievedAt: "2026-07-12",
      claim:
        "Official model/list interface: each installed-catalog entry reports model, supportedReasoningEfforts.reasoningEffort, defaultReasoningEffort, and inputModalities.",
    }),
    source({
      url: "https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts",
      retrievedAt: "2026-07-12",
      claim:
        "Official exec source: Codex exec accepts an explicit model, image paths, and modelReasoningEffort mapped to --config model_reasoning_effort.",
    }),
  ]),
} satisfies Readonly<
  Record<SubscriptionCliEngine, readonly Readonly<CapabilitySource>[]>
>)

export interface SubscriptionCliTuple {
  readonly engine: SubscriptionCliEngine
  readonly model: string
  readonly effort: ReasoningEffort
}

export interface SubscriptionCliTupleOverride {
  readonly model: string
  readonly effort: ReasoningEffort
}

export interface ObservedCodexModelCapability {
  readonly model: string
  readonly supportedReasoningEfforts: readonly {
    readonly reasoningEffort: ReasoningEffort
  }[]
  readonly inputModalities: readonly InputModality[]
  /** Hidden from the default picker; absent (older binaries) means visible. */
  readonly hidden?: boolean
  readonly displayName?: string
  /** Within the effort ceiling; absent when the vendor's default is above it. */
  readonly defaultReasoningEffort?: ReasoningEffort
  /** The model the vendor suggests instead. */
  readonly upgrade?: string
}

export interface ObservedCodexCatalog {
  readonly data: readonly ObservedCodexModelCapability[]
}

export interface ResolveSubscriptionCliTupleRequest {
  readonly engine: SubscriptionCliEngine
  readonly profile: TaskProfile
  readonly override?: SubscriptionCliTupleOverride
  readonly observedCodexCatalog?: ObservedCodexCatalog
}

export type ResolveSubscriptionCliRequestedTupleRequest = Pick<
  ResolveSubscriptionCliTupleRequest,
  "engine" | "profile" | "override"
>

export class SubscriptionCliCapabilityError extends Error {
  readonly category = "UNSUPPORTED_CAPABILITY" as const

  constructor(message: string) {
    super(`UNSUPPORTED_CAPABILITY: ${message}`)
    this.name = "SubscriptionCliCapabilityError"
  }
}

function unsupported(message: string): never {
  throw new SubscriptionCliCapabilityError(message)
}

interface ApprovedModelEffort {
  readonly model: string
  readonly effort: ReasoningEffort
}

function approved(model: string, effort: ReasoningEffort): ApprovedModelEffort {
  return Object.freeze({ model, effort })
}

/** Versioned ids (owner 2026-11-15: "use full model with version"). */
export const CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP = Object.freeze({
  "mechanical-translation": approved("claude-sonnet-5-5", "high"),
  "brand-translation": approved("claude-sonnet-5-5", "medium"),
  "editorial-copy": approved("claude-sonnet-5-5", "medium"),
  "structured-outline-meta": approved("claude-sonnet-5-5", "medium"),
  "grounded-help": approved("claude-haiku-5-5", "low"),
  "vision-spec": approved("claude-sonnet-5-5", "high"),
  "renderer-jsx": approved("claude-sonnet-5-5", "high"),
  "judgment-transform": approved("claude-opus-5-5", "high"),
  "explicit-agentic-rescue": approved("claude-opus-5-5", "xhigh"),
} satisfies Partial<Record<TaskProfile, ApprovedModelEffort>>)

/** Mirrors the OpenAI API defaults (`API_TASK_PROFILES.openai`). */
export const CODEX_SUBSCRIPTION_CLI_PROFILE_MAP = Object.freeze({
  "mechanical-translation": approved("gpt-6-luna", "high"),
  "brand-translation": approved("gpt-6.1-terra", "low"),
  "editorial-copy": approved("gpt-6.1-terra", "low"),
  "structured-outline-meta": approved("gpt-6.1-terra", "medium"),
  "grounded-help": approved("gpt-6-luna", "low"),
  "vision-spec": approved("gpt-6.1-sol", "high"),
  "renderer-jsx": approved("gpt-6.1-sol", "high"),
  "judgment-transform": approved("gpt-6.1-sol", "high"),
  "explicit-agentic-rescue": approved("gpt-6.1-sol", "xhigh"),
} satisfies Partial<Record<TaskProfile, ApprovedModelEffort>>)

/**
 * Owner ceiling (2026-07-13): a subscription CLI never runs above `xhigh`.
 *
 * The single source of truth for which efforts a subscription CLI may select.
 * `max` (Claude and Codex) and `ultra` (Codex) sit above the ceiling: they are
 * never selected, and an installed catalog that advertises them is still read
 * normally — the values are simply not selectable. Deliberately narrower than
 * the shared `REASONING_EFFORTS` union, which also serves the BYOK lane.
 */
export const SUBSCRIPTION_CLI_SELECTABLE_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ReasoningEffort[])

export function isSelectableSubscriptionCliEffort(
  value: string
): value is ReasoningEffort {
  return (SUBSCRIPTION_CLI_SELECTABLE_EFFORTS as readonly string[]).includes(
    value
  )
}

/** Both subscription CLIs share the owner-approved `xhigh` ceiling. */
export const CODEX_CLI_SELECTABLE_EFFORTS = SUBSCRIPTION_CLI_SELECTABLE_EFFORTS

export function isSelectableCodexCliEffort(
  value: string
): value is ReasoningEffort {
  return (CODEX_CLI_SELECTABLE_EFFORTS as readonly string[]).includes(value)
}

/**
 * The Claude Code models Settings offers when the installed Claude Code
 * cannot list its own (https://code.claude.com/docs/en/model-config,
 * 2026-11-15), as versioned ids; release units update it. Fable is listed
 * but runs only on a Max or Ultra plan or with an API key, checked again by
 * every Fable run (`checkClaudeFablePlan`): under `-p` Claude Code bills
 * Fable to usage credits without asking.
 */
export const CLAUDE_CLI_MODELS = Object.freeze([
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-2",
] as const)

export const CLAUDE_CLI_MODEL_NAMES = Object.freeze({
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
  "claude-fable-5-2": "Fable 5.2",
} satisfies Record<(typeof CLAUDE_CLI_MODELS)[number], string>)

/**
 * Family aliases Settings offered before 2026-11-15. A saved one is never
 * rewritten: it still parses and still runs (Claude Code resolves it to the
 * newest model of its family); a saved `fable` follows the Fable rule.
 */
export const CLAUDE_CLI_SAVED_ALIASES = Object.freeze([
  "haiku",
  "sonnet",
  "opus",
  "fable",
] as const)

/** A Fable model (`claude-fable-*`) or the saved `fable` alias. */
export function isClaudeFableModel(model: string): boolean {
  return model === "fable" || model.startsWith("claude-fable-")
}

export function isClaudeCliSavedAlias(model: string): boolean {
  return (CLAUDE_CLI_SAVED_ALIASES as readonly string[]).includes(model)
}

/** Every model a Claude run admits, with the efforts it accepts: `low`
 * through `xhigh` (and `max`, above the ceiling). Keep this per-model matrix
 * at the contract boundary so the settings menu and execution resolver
 * cannot create a selectable-but-unexecutable tuple. */
export const CLAUDE_CLI_EFFORTS_BY_MODEL: Readonly<
  Record<
    | (typeof CLAUDE_CLI_MODELS)[number]
    | (typeof CLAUDE_CLI_SAVED_ALIASES)[number],
    readonly (typeof SUBSCRIPTION_CLI_SELECTABLE_EFFORTS)[number][]
  >
> = Object.freeze({
  "claude-haiku-5-5": SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  "claude-sonnet-5-5": SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  "claude-opus-5-5": SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  "claude-fable-5-2": SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  haiku: SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  sonnet: SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  opus: SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  fable: SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
})

/** A tuple a Claude run admits without the installed tool's list: a
 * committed model or a saved alias, at an effort it accepts, and never
 * Fable (the plan is not known here). Anything else needs
 * `isAdmittedClaudeCliTuple`, or is refused before any process starts. */
export function isSelectableClaudeCliTuple(
  model: string,
  effort: string
): boolean {
  return (
    !isClaudeFableModel(model) &&
    Object.hasOwn(CLAUDE_CLI_EFFORTS_BY_MODEL, model) &&
    (
      CLAUDE_CLI_EFFORTS_BY_MODEL[
        model as keyof typeof CLAUDE_CLI_EFFORTS_BY_MODEL
      ] as readonly string[]
    ).includes(effort)
  )
}

/** The models the installed Claude Code offers, as last read on Settings ›
 * AI (`scripts/lib/local-tool-models.ts`); reading it starts no process. It
 * holds no plan: membership is a separate check from Fable's plan, which
 * every Fable run checks again itself. */
export interface ClaudeOfferedModels {
  /** True only for a list a run just read from the installed Claude Code
   * that came from the tool's own rows (`claudeOfferedFromHandshake`). The
   * cached list leaves it unset: it may be the committed fallback. A run
   * uses a fresh list only when it is observed. */
  readonly observed?: boolean
  /** The menu rows and the other versioned models the tool lists. */
  readonly models: readonly {
    readonly model: string
    readonly efforts: readonly string[]
  }[]
}

/** A tuple a Claude run admits with the installed tool's list (membership
 * only): a listed model or a saved alias, at an effort it accepts. */
export function isAdmittedClaudeCliTuple(
  model: string,
  effort: string,
  offered: ClaudeOfferedModels
): boolean {
  if (isClaudeCliSavedAlias(model))
    return (
      CLAUDE_CLI_EFFORTS_BY_MODEL[
        model as (typeof CLAUDE_CLI_SAVED_ALIASES)[number]
      ] as readonly string[]
    ).includes(effort)
  const row = offered.models.find((item) => item.model === model)
  return row !== undefined && row.efforts.includes(effort)
}

/**
 * The Codex models Settings offers when the installed Codex cannot list its
 * own (https://learn.chatgpt.com/codex/models and the Codex CLI 0.169.0
 * bundled catalog, 2026-11-15); the default first. Every entry accepts `low`
 * through `xhigh`. `gpt-6-sol` is never offered (owner 2026-11-15,
 * `NOT_OFFERED_MODELS`). The runtime still validates the chosen tuple against
 * the machine's live observed catalog in `resolveSubscriptionCliTuple`.
 */
export const CODEX_CLI_MODELS = Object.freeze([
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-terra",
  "gpt-6-luna",
] as const)

/** Menu names of known Codex models: one table, shared with the admin. */
export { CODEX_CLI_MODEL_NAMES } from "../../lib/local-model-names"

/** A model id the local file may hold and a CLI may receive: shape only.
 * Whether the tool offers it is checked when the owner saves and again when
 * a run starts. */
export function isSafeLocalToolModelId(model: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(model)
}

/**
 * Models Settings offered before 2026-11-15. A saved choice may still name one:
 * the local file keeps parsing and Settings shows it as the saved choice, but
 * it is not offered again, and the run-time catalog check decides whether it
 * still runs. Nothing replaces it by itself.
 */
export const CODEX_CLI_RETIRED_MODELS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
] as const)

/** A Codex model the menu may list: not hidden, never offered or retired. */
export function isOfferedCodexCliModel(model: string): boolean {
  return (
    isSafeLocalToolModelId(model) &&
    !isNotOffered("codex", model) &&
    !(CODEX_CLI_RETIRED_MODELS as readonly string[]).includes(model)
  )
}

export function resolveSubscriptionCliRequestedTuple(
  request: ResolveSubscriptionCliRequestedTupleRequest
): Readonly<SubscriptionCliTuple> {
  if (request.engine !== "claude-cli" && request.engine !== "codex-cli")
    unsupported(`unknown subscription CLI engine ${String(request.engine)}`)

  if (!(TASK_PROFILES as readonly unknown[]).includes(request.profile))
    unsupported(`unknown task profile ${String(request.profile)}`)

  const profileMap =
    request.engine === "claude-cli"
      ? CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP
      : CODEX_SUBSCRIPTION_CLI_PROFILE_MAP
  const approvedTuple = (
    profileMap as Partial<Record<TaskProfile, ApprovedModelEffort>>
  )[request.profile]

  if (!approvedTuple)
    unsupported(
      `task profile ${request.profile} is not mapped for ${request.engine}`
    )

  let selectedTuple = approvedTuple
  if (request.override !== undefined) {
    const override = request.override as Partial<SubscriptionCliTupleOverride>
    const complete =
      typeof override === "object" &&
      override !== null &&
      typeof override.model === "string" &&
      typeof override.effort === "string" &&
      (REASONING_EFFORTS as readonly string[]).includes(override.effort)

    if (!complete) unsupported("override must contain both model and effort")

    if (
      request.engine === "claude-cli" &&
      !isSelectableClaudeCliTuple(override.model, override.effort)
    ) {
      unsupported(
        `override ${override.model}/${override.effort} is not source-verified for claude-cli`
      )
    }
    if (
      request.engine === "codex-cli" &&
      !isSelectableCodexCliEffort(override.effort)
    ) {
      unsupported(
        `override ${override.model}/${override.effort} exceeds the selectable codex-cli effort ceiling`
      )
    }
    selectedTuple = approved(override.model, override.effort)
  }

  // Refused before the installed catalog is read, so no process starts.
  if (
    request.engine === "codex-cli" &&
    isNotOffered("codex", selectedTuple.model)
  )
    unsupported(`codex-cli model ${selectedTuple.model} is not offered`)

  return Object.freeze({ engine: request.engine, ...selectedTuple })
}

export function resolveSubscriptionCliTuple(
  request: ResolveSubscriptionCliTupleRequest
): Readonly<SubscriptionCliTuple> {
  const selectedTuple = resolveSubscriptionCliRequestedTuple(request)

  if (request.engine === "codex-cli") {
    const catalog = request.observedCodexCatalog
    if (!catalog)
      unsupported("an observed installed Codex model/list catalog is required")

    const observedModel = catalog.data.find(
      (capability) => capability.model === selectedTuple.model
    )
    const exposesEffort = observedModel?.supportedReasoningEfforts.some(
      (item) => item.reasoningEffort === selectedTuple.effort
    )

    if (!observedModel || observedModel.hidden === true || !exposesEffort)
      unsupported(
        `installed Codex catalog does not expose exact tuple ${selectedTuple.model}/${selectedTuple.effort}`
      )

    if (
      request.profile === "vision-spec" &&
      !observedModel.inputModalities.includes("image")
    )
      unsupported(
        `installed Codex catalog does not report image input for ${selectedTuple.model}`
      )
  }

  return selectedTuple
}
