import type {
  GenerationUsage,
  ReasoningEffort,
  TaskProfile,
} from "../../lib/ai/execution-contract"
import {
  resolveSubscriptionCliRequestedTuple,
  resolveSubscriptionCliTuple,
  type ObservedCodexCatalog,
  type SubscriptionCliTupleOverride,
} from "./subscription-cli-capabilities"
import type { SubscriptionCliProcessFailureKind } from "./subscription-cli-process"

export type CodexCliProfile = TaskProfile

export type CodexCliEffort = Extract<ReasoningEffort, "low" | "medium" | "high">

export interface CodexCliTuple {
  readonly engine: "codex-cli"
  readonly model: string
  readonly effort: CodexCliEffort
}

export type CodexCliTupleOverride = SubscriptionCliTupleOverride

export function resolveCodexCliRequestedTuple(request: {
  readonly profile: CodexCliProfile
  readonly override?: CodexCliTupleOverride
}): Readonly<CodexCliTuple> {
  const selected = resolveSubscriptionCliRequestedTuple({
    engine: "codex-cli",
    profile: request.profile,
    override: request.override,
  })
  return Object.freeze({
    engine: "codex-cli",
    model: selected.model,
    effort: selected.effort as CodexCliEffort,
  })
}

export class CodexCliCapabilityError extends Error {
  readonly category = "UNSUPPORTED_CAPABILITY" as const

  constructor(message: string) {
    super(`UNSUPPORTED_CAPABILITY: ${message}`)
    this.name = "CodexCliCapabilityError"
  }
}

export class CodexCliOutputError extends Error {
  readonly category = "INVALID_OUTPUT" as const

  constructor() {
    super("The Codex CLI returned incomplete or invalid output.")
    this.name = "CodexCliOutputError"
  }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidOutput(): never {
  throw new CodexCliOutputError()
}

/**
 * The single reader of the `codex exec --json` stream. The parser, its failure
 * classifier, and its shape diagnostic must agree on what counts as an event —
 * three separate line-splitters could disagree, and the two that must agree most
 * are the parser and the diagnostic that explains why the parser rejected a run.
 *
 * A line that is not a JSON object is not an event. Callers decide what that
 * means: the parser rejects the run, the classifier ignores it, the diagnostic
 * counts it.
 */
function readJsonlEvents(stdout: string): {
  readonly events: readonly JsonObject[]
  readonly nonEventLines: number
} {
  const events: JsonObject[] = []
  let nonEventLines = 0
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      nonEventLines += 1
      continue
    }
    if (isObject(value)) events.push(value)
    else nonEventLines += 1
  }
  return { events, nonEventLines }
}

function failedEventText(stdout: string): string {
  const fragments: string[] = []
  // Non-JSON stdout is not trusted as a diagnostic channel.
  for (const value of readJsonlEvents(stdout).events) {
    if (value.type === "error" && typeof value.message === "string") {
      fragments.push(value.message)
    }
    if (
      value.type === "turn.failed" &&
      isObject(value.error) &&
      typeof value.error.message === "string"
    ) {
      fragments.push(value.error.message)
    }
  }
  return fragments.join(" ")
}

// Provider diagnostics are inspected transiently and never copied into a
// result or Error object. Agent-message text is customer output, not evidence.
export function classifyCodexCliFailure(input: {
  readonly stderr?: string
  readonly stdout?: string
}): SubscriptionCliProcessFailureKind {
  const diagnostic = `${input.stderr ?? ""} ${failedEventText(
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
    /not logged in|\bauth(?:entication|orization)?\b|\bunauthorized\b|invalid (?:api )?key|(?:^|\D)401(?:\D|$)/u.test(
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

export function resolveCodexCliTuple(request: {
  readonly profile: CodexCliProfile
  readonly imageCount: number
  readonly observedCatalog: ObservedCodexCatalog
  readonly override?: CodexCliTupleOverride
}): Readonly<CodexCliTuple> {
  let selected: ReturnType<typeof resolveSubscriptionCliTuple>
  try {
    selected = resolveSubscriptionCliTuple({
      engine: "codex-cli",
      profile: request.profile,
      override: request.override,
      observedCodexCatalog: request.observedCatalog,
    })
  } catch (error) {
    throw new CodexCliCapabilityError(
      error instanceof Error ? error.message.replace(/^UNSUPPORTED_CAPABILITY:\s*/u, "") : "unsupported tuple"
    )
  }
  const capability = request.observedCatalog.data.find(
    (item) => item.model === selected.model
  )
  if (
    request.imageCount > 0 &&
    (!capability || !capability.inputModalities.includes("image"))
  ) {
    throw new CodexCliCapabilityError(
      `installed Codex catalog does not expose image input for ${selected.model}`
    )
  }

  return Object.freeze({
    engine: "codex-cli",
    model: selected.model,
    effort: selected.effort as CodexCliEffort,
  })
}

export interface CodexCliInvocation {
  readonly command: "codex"
  readonly args: readonly string[]
  readonly stdin: string
  readonly selected: Readonly<CodexCliTuple>
}

function isSafeStagedBasename(filename: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/iu.test(filename)
}

export function buildCodexCliInvocation(request: {
  readonly profile: CodexCliProfile
  readonly prompt: string
  /** Safe basename of the instruction file staged in the isolated run directory. */
  readonly instructionsFilename: string
  readonly imageFilenames: readonly string[]
  readonly observedCatalog: ObservedCodexCatalog
  readonly override?: CodexCliTupleOverride
}): Readonly<CodexCliInvocation> {
  const selected = resolveCodexCliTuple({
    profile: request.profile,
    imageCount: request.imageFilenames.length,
    observedCatalog: request.observedCatalog,
    override: request.override,
  })
  if (!isSafeStagedBasename(request.instructionsFilename)) {
    throw new CodexCliCapabilityError(
      "staged instruction filename must be a safe relative basename"
    )
  }
  if (
    request.imageFilenames.some(
      (filename) => !isSafeStagedBasename(filename)
    )
  ) {
    throw new CodexCliCapabilityError(
      "staged image filename must be a safe relative basename"
    )
  }
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--config",
    'web_search="disabled"',
    "--config",
    "features.shell_tool=false",
    "--config",
    "features.multi_agent=false",
    "--config",
    "features.apps=false",
    "--config",
    `model_instructions_file=${JSON.stringify(`./${request.instructionsFilename}`)}`,
    "--model",
    selected.model,
    "--config",
    `model_reasoning_effort=${JSON.stringify(selected.effort)}`,
  ]
  for (const filename of request.imageFilenames) {
    args.push("--image", `./${filename}`)
  }
  args.push("-")

  return Object.freeze({
    command: "codex",
    args: Object.freeze(args),
    stdin: request.prompt,
    selected,
  })
}

export interface UnprovedCodexCliOutput {
  readonly status: "unproved-effective-identity"
  readonly text: string
  readonly usage: GenerationUsage
}

/** The only item the parser reads. Everything else is context, not artifact. */
const ARTIFACT_ITEM_TYPE = "agent_message"

/**
 * Items that carry no capability signal, and so are ignored rather than fatal.
 *
 * The distinction that matters is NOT "did we model this item?" but "could this
 * item represent an action outside the sandbox?". Codex reports local advisory
 * notices as `error`-typed items (e.g. skill descriptions truncated to fit a
 * context budget) — a notice about the machine, unrelated to the generation.
 * Treating those as fatal discarded complete, valid artifacts, and looked like
 * vendor flakiness because whether a notice fires depends on the operator's
 * installed skills rather than on our request.
 *
 * Tool and execution items stay fatal by omission: the invocation disables the
 * shell, web search, apps and multi-agent, so a `command_execution`,
 * `file_change`, `mcp_tool_call` or `web_search` item means a feature-disable
 * flag did not hold, and that canary is worth keeping. An item type in neither
 * set is fatal too — a new type is unclassified until a human classifies it,
 * because a false acceptance here is worse than a false rejection.
 *
 * Names are the wire (snake_case) spellings of the installed thread-item schema
 * (`codex app-server generate-json-schema`), not documentation.
 */
const TOLERATED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "error",
  "plan",
  "todo_list",
  "image_view",
  "context_compaction",
])

function safeToken(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidOutput()
  }
  return value
}

/** A streaming run can emit thousands of item.updated deltas; stdout is capped
 * by bytes, not by event count. The diagnostic names the shape, not every event. */
const MAX_SHAPE_EVENTS = 40
const MAX_TOKEN_CHARS = 40

function boundedToken(value: string): string {
  return value.length <= MAX_TOKEN_CHARS
    ? value
    : `${value.slice(0, MAX_TOKEN_CHARS)}…`
}

/**
 * A developer-facing, redacted description of a transcript's EVENT SHAPE, for
 * the stderr of a rejected run. An unknown item type is fatal by design, so a
 * future Codex release will eventually reject a run here; without this, that
 * arrives as a bare INVALID_OUTPUT and costs a live investigation to localize.
 *
 * Structure only: event types, item kinds, and counts. Never message text,
 * artifact text, usage values, thread ids, or the content of a non-JSON line —
 * those are prompts, customer content, or session identity. Mirrors the gate
 * diagnostic precedent: say what shape arrived, never what it said.
 */
export function summarizeCodexTranscriptShape(stdout: string): string {
  const { events, nonEventLines } = readJsonlEvents(stdout)

  // Every string here is provider-controlled, so it is bounded before it is
  // printed: a type is an enum in practice, but this function's whole promise is
  // that nothing unbounded from the provider reaches the diagnostic.
  const parts: string[] = []
  for (const event of events.slice(0, MAX_SHAPE_EVENTS)) {
    const type =
      typeof event.type === "string" ? boundedToken(event.type) : "<untyped>"
    const itemType =
      isObject(event.item) && typeof event.item.type === "string"
        ? `(${boundedToken(event.item.type)})`
        : ""
    parts.push(`${type}${itemType}`)
  }

  const elided = events.length - parts.length
  const shape = parts.length > 0 ? parts.join(" → ") : "no events"
  const more = elided > 0 ? ` … +${elided} more event(s)` : ""
  const noise =
    nonEventLines > 0 ? ` + ${nonEventLines} non-JSON line(s) on stdout` : ""
  return `Codex transcript shape: ${shape}${more}${noise}`
}

export function parseCodexCliOutput(
  stdout: string
): Readonly<UnprovedCodexCliOutput> {
  const { events, nonEventLines } = readJsonlEvents(stdout)
  // Stricter than the diagnostic: stdout is the artifact channel, so a line that
  // is not an event means we are not reading what we think we are reading.
  if (nonEventLines > 0) invalidOutput()

  const allowedEventTypes = new Set([
    "thread.started",
    "turn.started",
    "item.started",
    "item.updated",
    "item.completed",
    "turn.completed",
  ])
  for (const event of events) {
    if (typeof event.type !== "string" || !allowedEventTypes.has(event.type)) {
      invalidOutput()
    }
    if (event.type.startsWith("item.")) {
      if (
        !isObject(event.item) ||
        typeof event.item.type !== "string" ||
        (event.item.type !== ARTIFACT_ITEM_TYPE &&
          !TOLERATED_ITEM_TYPES.has(event.item.type))
      ) {
        invalidOutput()
      }
    }
  }
  const threadStartIndex = events.findIndex(
    (event) => event.type === "thread.started"
  )
  const turnStartIndex = events.findIndex(
    (event) => event.type === "turn.started"
  )
  const turnCompleteIndex = events.findIndex(
    (event) => event.type === "turn.completed"
  )
  if (
    events.filter((event) => event.type === "thread.started").length !== 1 ||
    events.filter((event) => event.type === "turn.started").length !== 1 ||
    events.filter((event) => event.type === "turn.completed").length !== 1 ||
    threadStartIndex !== 0 ||
    turnStartIndex <= threadStartIndex ||
    turnCompleteIndex !== events.length - 1 ||
    events.some(
      (event, index) =>
        typeof event.type === "string" &&
        event.type.startsWith("item.") &&
        (index <= turnStartIndex || index >= turnCompleteIndex)
    )
  ) {
    invalidOutput()
  }

  const completedMessages = events.filter((event) => {
    if (event.type !== "item.completed" || !isObject(event.item)) return false
    return event.item.type === "agent_message"
  })
  if (completedMessages.length !== 1) invalidOutput()
  const item = completedMessages[0].item
  if (!isObject(item) || typeof item.text !== "string" || item.text.trim() === "") {
    invalidOutput()
  }

  const completedTurns = events.filter((event) => event.type === "turn.completed")
  if (!isObject(completedTurns[0].usage)) {
    invalidOutput()
  }
  const usage = completedTurns[0].usage
  const inputTokens = safeToken(usage.input_tokens)
  const outputTokens = safeToken(usage.output_tokens)

  return Object.freeze({
    status: "unproved-effective-identity",
    text: item.text,
    usage: Object.freeze({
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    }),
  })
}
