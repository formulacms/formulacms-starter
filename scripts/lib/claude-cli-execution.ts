import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import type {
  ReasoningEffort,
  TaskProfile,
  WorkflowPhase,
} from "../../lib/ai/execution-contract"
import type { EngineImage } from "./ai-api-engine"
import {
  buildClaudeCliInvocation,
  classifyClaudeCliFailure,
  ClaudeCliCapabilityError,
  ClaudeCliOutputError,
  parseClaudeCliOutput,
  resolveClaudeCliTuple,
  type ClaudeCliTupleOverride,
} from "./claude-cli-adapter"
import { isTestRun, NativeLaunchBlockedError } from "./native-launch-guard"
import {
  isClaudeCliSavedAlias,
  isClaudeFableModel,
  isSafeLocalToolModelId,
  isSelectableClaudeCliTuple,
  isSelectableSubscriptionCliEffort,
  type ClaudeOfferedModels,
} from "./subscription-cli-capabilities"
import {
  runSubscriptionCliProcess,
  SubscriptionCliProcessError,
  type SubscriptionCliProcessRequest,
} from "./subscription-cli-process"
import {
  makeSubscriptionCliError,
  processFailureCategory,
  type SubscriptionCliGenerationResult,
} from "./subscription-cli-contract"

export type ClaudeCliExecutionProfile = TaskProfile

export interface ClaudeCliExecutionRequest {
  readonly systemPrompt: string
  readonly prompt: string
  readonly images: readonly EngineImage[]
  readonly profile: ClaudeCliExecutionProfile
  readonly phase: WorkflowPhase
  readonly override?: ClaudeCliTupleOverride
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
}

export interface StagedClaudeCliRun {
  readonly cwd: string
  readonly systemPromptFilename: string
  readonly imageFilenames: readonly string[]
  readonly cleanupPaths: readonly string[]
}

export type StageClaudeCliRun = (request: {
  readonly systemPrompt: string
  readonly images: readonly EngineImage[]
}) => Promise<StagedClaudeCliRun>

export type RunClaudeCliProcess = (
  request: SubscriptionCliProcessRequest
) => Promise<{ stdout: string }>

export interface ClaudeCliExecutionDeps {
  readonly stageRun?: StageClaudeCliRun
  readonly runProcess?: RunClaudeCliProcess
  /** The models the installed Claude Code offers, as Settings › AI last read
   * them (membership only); defaults to the local mirror
   * (`.formulacms/local/local-tool-models.json`). */
  readonly readOffered?: () => ClaudeOfferedModels | Promise<ClaudeOfferedModels>
  /** The models the installed Claude Code lists right now, read only when
   * the cached list lacks the versioned model of a tuple outside the
   * committed ones; defaults to a fresh handshake
   * (starts the installed Claude Code, sends no prompt). It may reject: a
   * failed read changes nothing. */
  readonly readOfferedFresh?: (request: {
    readonly signal?: AbortSignal
  }) => Promise<ClaudeOfferedModels>
  /** Fable's fresh plan check, run by every Fable run before staging;
   * defaults to `checkClaudeFablePlan` (starts the installed Claude Code). */
  readonly checkFablePlan?: (request: { readonly signal?: AbortSignal }) => Promise<boolean>
}

async function defaultCheckFablePlan(request: {
  readonly signal?: AbortSignal
}): Promise<boolean> {
  // Loaded here only, like the list reader. Under a test it throws
  // NativeLaunchBlockedError before any lookup or process.
  const { checkClaudeFablePlan } = await import("./dev-ai-connections")
  return checkClaudeFablePlan(request.signal ? { signal: request.signal } : {})
}

async function defaultReadOffered(): Promise<ClaudeOfferedModels> {
  // Tests never read the owner's local file: they inject `readOffered`.
  if (isTestRun()) throw new Error("A test reached the local model list. Inject readOffered instead.")
  // Loaded here only: it reads the local file and must not load with the
  // engine module (that module graph includes this one).
  const { peekClaudeOfferedModels } = await import("./local-tool-models")
  return peekClaudeOfferedModels()
}

async function defaultReadOfferedFresh(request: {
  readonly signal?: AbortSignal
}): Promise<ClaudeOfferedModels> {
  // Loaded here only. Under a test the handshake throws
  // NativeLaunchBlockedError before any lookup or process.
  const { readClaudeCodeHandshake } = await import("./claude-cli-discovery")
  const { claudeOfferedFromHandshake } = await import("./local-tool-models")
  const handshake = await readClaudeCodeHandshake(
    request.signal ? { signal: request.signal } : {}
  )
  return claudeOfferedFromHandshake(handshake.models)
}

const lists = (offered: ClaudeOfferedModels | undefined, model: string) =>
  offered?.models.some((item) => item.model === model) === true

function safeImageExtension(path: string): string {
  const extension = extname(path).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : ".png"
}

async function defaultStageRun(request: {
  readonly systemPrompt: string
  readonly images: readonly EngineImage[]
}): Promise<StagedClaudeCliRun> {
  const cwd = await mkdtemp(join(tmpdir(), "formulacms-claude-"))
  const systemPromptFilename = "system-prompt.txt"
  try {
    await writeFile(join(cwd, systemPromptFilename), request.systemPrompt, {
      encoding: "utf8",
      mode: 0o600,
    })
    const imageFilenames: string[] = []
    for (const [index, image] of request.images.entries()) {
      const suffix = request.images.length === 1 ? "" : `-${index + 1}`
      const filename = `snapshot${suffix}${safeImageExtension(image.path)}`
      await copyFile(image.path, join(cwd, filename))
      imageFilenames.push(filename)
    }
    return Object.freeze({
      cwd,
      systemPromptFilename,
      imageFilenames: Object.freeze(imageFilenames),
      cleanupPaths: Object.freeze([cwd]),
    })
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }
}

export async function executeClaudeCliGeneration(
  request: ClaudeCliExecutionRequest,
  deps: ClaudeCliExecutionDeps = {}
): Promise<SubscriptionCliGenerationResult> {
  // Resolve the operator-controlled tuple before writing any customer input to
  // disk. Invalid capability requests therefore cannot create staged data.
  // A committed tuple (a committed model or saved alias, not Fable, at a
  // committed effort) needs no list and goes to the tool as it is (owner,
  // 2026-11-17: keeping Claude Code current is the owner's job). Any other
  // tuple (Fable included) is checked against the models
  // Settings › AI last read, and takes its efforts from that list. When that
  // cached list lacks a versioned model, the run reads the installed Claude
  // Code's list once more (the cache may predate an update) and uses it
  // only when the tool itself gave it; a failed or fallback read changes
  // nothing.
  const override = request.override
  const model = String(override?.model)
  const effort = String(override?.effort)
  const wellFormed =
    override !== undefined &&
    isSafeLocalToolModelId(model) &&
    isSelectableSubscriptionCliEffort(effort)
  const versioned = wellFormed && !isClaudeCliSavedAlias(model)
  const needsList = wellFormed && !isSelectableClaudeCliTuple(model, effort)
  const phase = request.phase
  let offered: ClaudeOfferedModels | undefined
  if (needsList) {
    const cached = await (deps.readOffered ?? defaultReadOffered)()
    let fresh: ClaudeOfferedModels | undefined
    if (versioned && !lists(cached, model)) {
      try {
        fresh = await (deps.readOfferedFresh ?? defaultReadOfferedFresh)(
          request.signal ? { signal: request.signal } : {}
        )
      } catch (error) {
        if (error instanceof NativeLaunchBlockedError) throw error
        fresh = undefined
      }
      const selected = Object.freeze({
        lane: "local-build" as const,
        engine: "claude-cli" as const,
        model,
        effort: effort as ReasoningEffort,
      })
      if (request.signal?.aborted) {
        throw makeSubscriptionCliError("CANCELLED", { selected, attempts: 0, phase })
      }
    }
    offered = fresh?.observed === true ? fresh : cached
  }
  const resolved = resolveClaudeCliTuple({
    profile: request.profile,
    override,
    offered,
  })
  const selected = Object.freeze({
    lane: "local-build" as const,
    engine: "claude-cli" as const,
    model: resolved.model,
    effort: resolved.effort,
  })
  // Fable (owner, 2026-11-15; ADR-0057): a fresh check of the installed
  // Claude Code decides, every run, before staging or the generation process.
  // The plan cached for the menu has no say here.
  let fablePlanChecked = false
  if (isClaudeFableModel(resolved.model)) {
    const passed = await (deps.checkFablePlan ?? defaultCheckFablePlan)(
      request.signal ? { signal: request.signal } : {}
    )
    if (request.signal?.aborted) {
      throw makeSubscriptionCliError("CANCELLED", { selected, attempts: 0, phase })
    }
    if (!passed) {
      throw new ClaudeCliCapabilityError(
        "Fable runs only on a Max or Ultra plan or with an API key, and Claude Code did not confirm one"
      )
    }
    fablePlanChecked = true
  }
  let staged: StagedClaudeCliRun
  try {
    staged = await (deps.stageRun ?? defaultStageRun)({
      systemPrompt: request.systemPrompt,
      images: request.images,
    })
  } catch {
    throw makeSubscriptionCliError("LOCAL_PROCESS_FAILED", {
      selected,
      attempts: 0,
      phase,
    })
  }
  const invocation = buildClaudeCliInvocation({
    profile: request.profile,
    override,
    offered,
    fablePlanChecked,
    systemPromptFilename: staged.systemPromptFilename,
    prompt: request.prompt,
    imageFilenames: staged.imageFilenames,
  })
  let processResult: { stdout: string }
  try {
    processResult = await (deps.runProcess ?? runSubscriptionCliProcess)({
      command: invocation.command,
      args: invocation.args,
      stdin: invocation.stdin,
      cwd: staged.cwd,
      deadlineMs: request.deadlineMs ?? 5 * 60_000,
      signal: request.signal,
      cleanupPaths: staged.cleanupPaths,
      classifyFailure: ({ stdout, stderr }) =>
        classifyClaudeCliFailure({ stdout, stderr }),
    })
  } catch (error) {
    if (error instanceof SubscriptionCliProcessError) {
      throw makeSubscriptionCliError(processFailureCategory(error.kind), {
        selected,
        attempts: error.attempts,
        phase,
      })
    }
    throw error
  }
  let parsed: ReturnType<typeof parseClaudeCliOutput>
  try {
    parsed = parseClaudeCliOutput(processResult.stdout, invocation.selected.model)
  } catch (error) {
    if (error instanceof ClaudeCliOutputError) {
      throw makeSubscriptionCliError("INVALID_OUTPUT", {
        selected,
        attempts: 1,
        phase,
      })
    }
    throw error
  }
  const configuredEffort: ReasoningEffort = invocation.selected.effort

  return Object.freeze({
    text: parsed.text,
    output: parsed.text,
    selected,
    // The transcript proves the MODEL. The effort remains configured evidence —
    // Claude's stream-json does not independently prove it.
    identityEvidence: "transcript-observed" as const,
    actual: Object.freeze({
      engine: "claude-cli" as const,
      model: parsed.actualModel,
      effort: configuredEffort,
      modelEvidence: "transcript" as const,
      effortEvidence: "configured" as const,
    }),
    attempts: 1 as const,
    usage: parsed.usage,
    finishReason: "stop" as const,
  })
}
