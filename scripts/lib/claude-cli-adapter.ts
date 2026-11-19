import type {
  GenerationUsage,
  ReasoningEffort,
  TaskProfile,
} from "../../lib/ai/execution-contract"
import {
  CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP,
  SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  isAdmittedClaudeCliTuple,
  isClaudeFableModel,
  isClaudeCliSavedAlias,
  isSelectableClaudeCliTuple,
  type ClaudeOfferedModels,
} from "./subscription-cli-capabilities"
import type { SubscriptionCliProcessFailureKind } from "./subscription-cli-process"

/** A versioned id (`claude-sonnet-5-5`) or a saved alias (`sonnet`); the run
 * admits only `isSelectableClaudeCliTuple`. */
export type ClaudeCliModel = string
// Owner ceiling (2026-07-13): a subscription CLI never runs above `xhigh`.
// `max` is deliberately absent — it is not selectable, not even as an explicit
// override or rescue.
export type ClaudeCliEffort = Extract<
  ReasoningEffort,
  "low" | "medium" | "high" | "xhigh"
>

export const CLAUDE_CLI_EFFORTS = SUBSCRIPTION_CLI_SELECTABLE_EFFORTS

export interface ClaudeCliTuple {
  readonly engine: "claude-cli"
  readonly model: ClaudeCliModel
  readonly effort: ClaudeCliEffort
}

export interface ClaudeCliTupleOverride {
  readonly model: ClaudeCliModel
  readonly effort: ClaudeCliEffort
}

export interface ResolveClaudeCliTupleRequest {
  readonly profile: TaskProfile
  readonly override?: ClaudeCliTupleOverride
  /** The installed tool's list (membership only). Without it only the
   * committed models and saved aliases resolve, and Fable never does. */
  readonly offered?: ClaudeOfferedModels
}

export class ClaudeCliCapabilityError extends Error {
  readonly category = "UNSUPPORTED_CAPABILITY" as const

  constructor(message: string) {
    super(`UNSUPPORTED_CAPABILITY: ${message}`)
    this.name = "ClaudeCliCapabilityError"
  }
}

type ApprovedClaudeCliTuple = Omit<ClaudeCliTuple, "engine">

function unsupported(message: string): never {
  throw new ClaudeCliCapabilityError(message)
}

export function resolveClaudeCliTuple(
  request: ResolveClaudeCliTupleRequest
): Readonly<ClaudeCliTuple> {
  const mapped = (
    CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP as Partial<
      Record<TaskProfile, Readonly<ApprovedClaudeCliTuple>>
    >
  )[request.profile]
  if (!mapped) {
    unsupported(
      `task profile ${String(request.profile)} is not mapped for claude-cli`
    )
  }

  if (request.override === undefined) {
    return Object.freeze({ engine: "claude-cli", ...mapped })
  }

  const override = request.override as Partial<ClaudeCliTupleOverride>
  if (
    typeof override !== "object" ||
    override === null ||
    typeof override.model !== "string" ||
    typeof override.effort !== "string" ||
    !(request.offered
      ? isAdmittedClaudeCliTuple(override.model, override.effort, request.offered)
      : isSelectableClaudeCliTuple(override.model, override.effort))
  ) {
    unsupported(
      "override must contain a supported Claude model and effort"
    )
  }

  return Object.freeze({
    engine: "claude-cli",
    model: override.model as ClaudeCliModel,
    effort: override.effort as ClaudeCliEffort,
  })
}

export interface BuildClaudeCliInvocationRequest extends ResolveClaudeCliTupleRequest {
  /** Safe basename of the system prompt staged in the isolated run directory. */
  readonly systemPromptFilename: string
  readonly prompt: string
  readonly imageFilenames?: readonly string[]
  /** True only after this run's fresh Fable plan check passed
   * (`executeClaudeCliGeneration`); without it a Fable model is refused. */
  readonly fablePlanChecked?: boolean
}

export interface ClaudeCliInvocation {
  readonly command: "claude"
  readonly args: readonly string[]
  readonly stdin: string
  readonly selected: Readonly<ClaudeCliTuple>
}

function imageReadPreamble(filenames: readonly string[]): string {
  if (filenames.length === 0) return ""
  const plural = filenames.length > 1
  return `First use your Read tool to read the design snapshot image${
    plural ? "s" : ""
  } at ${filenames.map((filename) => `./${filename}`).join(", ")} so you can see ${
    plural ? "them" : "it"
  }.\n\n`
}

function isSafeStagedBasename(filename: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/iu.test(filename)
}

export function buildClaudeCliInvocation(
  request: BuildClaudeCliInvocationRequest
): Readonly<ClaudeCliInvocation> {
  const selected = resolveClaudeCliTuple(request)
  if (isClaudeFableModel(selected.model) && request.fablePlanChecked !== true) {
    unsupported("a Fable run needs a passed plan check")
  }
  const imageFilenames = request.imageFilenames ?? []
  if (!isSafeStagedBasename(request.systemPromptFilename)) {
    unsupported(
      "staged system prompt filename must be a safe relative basename"
    )
  }
  if (imageFilenames.some((filename) => !isSafeStagedBasename(filename))) {
    unsupported("staged image filename must be a safe relative basename")
  }
  const args = Object.freeze([
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    selected.model,
    "--effort",
    selected.effort,
    "--tools",
    imageFilenames.length > 0 ? "Read" : "",
    "--system-prompt-file",
    `./${request.systemPromptFilename}`,
    "--setting-sources",
    "",
    // A request a safety classifier flags ends as an error instead of
    // switching to another model (https://code.claude.com/docs/en/settings-reference#switchmodelsonflag).
    // No `--fallback-model` is ever passed.
    "--settings",
    '{"switchModelsOnFlag":false}',
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ])

  return Object.freeze({
    command: "claude",
    args,
    stdin: imageReadPreamble(imageFilenames) + request.prompt,
    selected,
  })
}

function failedEnvelopeText(stdout: string): string {
  const fragments: string[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    try {
      const value: unknown = JSON.parse(line)
      if (!isObject(value) || value.is_error !== true) continue
      for (const field of ["result", "subtype", "terminal_reason"] as const) {
        if (typeof value[field] === "string") fragments.push(value[field])
      }
    } catch {
      // Non-JSON stdout is not trusted as a diagnostic channel.
    }
  }
  return fragments.join(" ")
}

// This deliberately returns only the shared enum. Provider diagnostics are
// inspected transiently and never copied into the result or an Error object.
export function classifyClaudeCliFailure(input: {
  readonly stderr?: string
  readonly stdout?: string
}): SubscriptionCliProcessFailureKind {
  const diagnostic = `${input.stderr ?? ""} ${failedEnvelopeText(
    input.stdout ?? ""
  )}`.toLowerCase()

  if (
    /rate[_ -]?limit(?:ed|_error)?|too many requests|(?:^|\D)429(?:\D|$)/u.test(
      diagnostic
    )
  ) {
    return "rate-limited"
  }
  if (
    /\b(?:quota|usage limit|credits?|billing|subscription limit|exhausted)\b/u.test(
      diagnostic
    )
  ) {
    return "quota-exhausted"
  }
  if (
    /not logged in|run\s+\/login|\bauth(?:entication|orization)?\b|\bunauthorized\b|invalid (?:api )?key|(?:^|\D)401(?:\D|$)/u.test(
      diagnostic
    )
  ) {
    return "auth-required"
  }
  if (
    /prompt (?:is )?too long|input (?:is )?too (?:large|long)|context (?:window|length)|maximum context|request (?:is )?too large/u.test(
      diagnostic
    )
  ) {
    return "input-too-large"
  }
  if (
    /unsupported|not supported|does not support|invalid model|unknown model|invalid effort|unknown (?:option|argument)/u.test(
      diagnostic
    )
  ) {
    return "unsupported-capability"
  }
  return "local-process-failed"
}

export interface ParsedClaudeCliEnvelope {
  readonly text: string
  readonly actualModel: string
  readonly usage: GenerationUsage
}

export class ClaudeCliOutputError extends Error {
  readonly category = "INVALID_OUTPUT" as const

  constructor() {
    super("The Claude CLI returned incomplete or invalid output.")
    this.name = "ClaudeCliOutputError"
  }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidOutput(): never {
  throw new ClaudeCliOutputError()
}

function parseStreamEvents(stdout: string): JsonObject[] {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  if (lines.length === 0) invalidOutput()

  return lines.map((line) => {
    try {
      const value: unknown = JSON.parse(line)
      if (!isObject(value)) invalidOutput()
      return value
    } catch (error) {
      if (error instanceof ClaudeCliOutputError) throw error
      return invalidOutput()
    }
  })
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function normalizedUsage(value: unknown): GenerationUsage {
  if (!isObject(value)) return Object.freeze({})
  const inputTokens = safeTokenCount(value.input_tokens)
  const outputTokens = safeTokenCount(value.output_tokens)
  return Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
  })
}

/** The init event must name the model the run passed: exactly, for a
 * versioned id; any model of the family, for a saved alias. */
function isModelForRequest(model: string, requested: ClaudeCliModel): boolean {
  if (!isClaudeCliSavedAlias(requested)) return model === requested
  return new RegExp(`^claude-${requested}-[a-z0-9][a-z0-9.-]*$`, "u").test(model)
}

export function parseClaudeCliOutput(
  stdout: string,
  expectedModel: ClaudeCliModel
): Readonly<ParsedClaudeCliEnvelope> {
  const events = parseStreamEvents(stdout)
  const initEvents = events.filter(
    (event) => event.type === "system" && event.subtype === "init"
  )
  if (initEvents.length !== 1 || typeof initEvents[0].model !== "string") {
    invalidOutput()
  }
  const actualModel = initEvents[0].model as string
  if (!isModelForRequest(actualModel, expectedModel)) invalidOutput()

  const initIndex = events.indexOf(initEvents[0])
  const firstAssistantIndex = events.findIndex(
    (event) => event.type === "assistant"
  )
  const assistantModels = events
    .filter((event) => event.type === "assistant")
    .map((event) => (isObject(event.message) ? event.message.model : undefined))
  if (
    assistantModels.length === 0 ||
    firstAssistantIndex <= initIndex ||
    assistantModels.some((model) => model !== actualModel)
  ) {
    invalidOutput()
  }

  const resultEvents = events.filter((event) => event.type === "result")
  const result = events.at(-1)
  if (
    resultEvents.length !== 1 ||
    !result ||
    result.type !== "result" ||
    result.subtype !== "success" ||
    result.is_error !== false ||
    typeof result.result !== "string" ||
    result.result.trim().length === 0
  ) {
    invalidOutput()
  }

  return Object.freeze({
    text: result.result as string,
    actualModel,
    usage: normalizedUsage(result.usage),
  })
}
