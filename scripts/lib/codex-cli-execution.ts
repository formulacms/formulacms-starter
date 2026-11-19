import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import type { WorkflowPhase } from "../../lib/ai/execution-contract"
import type { EngineImage } from "./ai-api-engine"
import {
  buildCodexCliInvocation,
  classifyCodexCliFailure,
  CodexCliCapabilityError,
  CodexCliOutputError,
  parseCodexCliOutput,
  resolveCodexCliRequestedTuple,
  resolveCodexCliTuple,
  summarizeCodexTranscriptShape,
  type CodexCliProfile,
  type CodexCliTupleOverride,
} from "./codex-cli-adapter"
import { readCodexCliCatalog, CodexCliCatalogError } from "./codex-cli-catalog"
import {
  resolveCodexCommand,
  withCodexModelListTransport,
} from "./codex-app-server"
import {
  CODEX_SUBSCRIPTION_CLI_PROFILE_MAP,
  type ObservedCodexCatalog,
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

export interface CodexCliExecutionRequest {
  readonly systemPrompt: string
  readonly prompt: string
  readonly images: readonly EngineImage[]
  readonly profile: CodexCliProfile
  readonly phase: WorkflowPhase
  readonly override?: CodexCliTupleOverride
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
}

export interface StagedCodexCliRun {
  readonly cwd: string
  readonly instructionsFilename: string
  readonly imageFilenames: readonly string[]
  readonly cleanupPaths: readonly string[]
}

export type StageCodexCliRun = (request: {
  readonly systemPrompt: string
  readonly images: readonly EngineImage[]
}) => Promise<StagedCodexCliRun>

export type ReadCodexCatalog = () => Promise<ObservedCodexCatalog>

export type RunCodexCliProcess = (
  request: SubscriptionCliProcessRequest
) => Promise<{ stdout: string }>

export interface CodexCliExecutionDeps {
  readonly readCatalog?: ReadCodexCatalog
  readonly stageRun?: StageCodexCliRun
  readonly runProcess?: RunCodexCliProcess
  /** Transient, redacted event-shape diagnostic for a rejected transcript. */
  readonly onInvalidOutput?: (shape: string) => void
}

function defaultOnInvalidOutput(shape: string): void {
  console.error(shape)
}

function safeImageExtension(path: string): string {
  const extension = extname(path).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : ".png"
}

async function defaultStageRun(request: {
  readonly systemPrompt: string
  readonly images: readonly EngineImage[]
}): Promise<StagedCodexCliRun> {
  const cwd = await mkdtemp(join(tmpdir(), "formulacms-codex-"))
  const instructionsFilename = "model-instructions.txt"
  try {
    await writeFile(join(cwd, instructionsFilename), request.systemPrompt, {
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
      instructionsFilename,
      imageFilenames: Object.freeze(imageFilenames),
      cleanupPaths: Object.freeze([cwd]),
    })
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }
}

/** The installed catalog is the capability gate; it never proves what served us. */
async function defaultReadCatalog(): Promise<ObservedCodexCatalog> {
  return withCodexModelListTransport(async (requestPage) =>
    readCodexCliCatalog({ requestPage })
  )
}

/**
 * Codex generation. Mirrors executeClaudeCliGeneration, but its honest identity
 * evidence is `selected-only`: `codex exec --json` does not expose the resolved
 * starting model or effort, so the run reports what it SELECTED (argv, validated
 * against the installed catalog) and never fabricates an `actual`.
 */
export async function executeCodexCliGeneration(
  request: CodexCliExecutionRequest,
  deps: CodexCliExecutionDeps = {}
): Promise<SubscriptionCliGenerationResult> {
  const phase = request.phase

  const defaultSelected = Object.freeze({
    lane: "local-build" as const,
    engine: "codex-cli" as const,
    model: CODEX_SUBSCRIPTION_CLI_PROFILE_MAP["vision-spec"].model,
    effort: "high" as const,
  })
  let requestedTuple: ReturnType<typeof resolveCodexCliRequestedTuple>
  try {
    requestedTuple = resolveCodexCliRequestedTuple({
      profile: request.profile,
      override: request.override,
    })
  } catch {
    throw makeSubscriptionCliError("UNSUPPORTED_CAPABILITY", {
      selected: defaultSelected,
      attempts: 0,
      phase,
    })
  }
  const selectedForError = Object.freeze({
    lane: "local-build" as const,
    engine: "codex-cli" as const,
    model: requestedTuple.model,
    effort: requestedTuple.effort,
  })

  // Capability preflight BEFORE any customer input reaches disk: an unsupported
  // tuple must not be able to create staged data.
  let observedCatalog: ObservedCodexCatalog
  try {
    observedCatalog = await (deps.readCatalog ?? defaultReadCatalog)()
  } catch (error) {
    if (error instanceof SubscriptionCliProcessError) {
      throw makeSubscriptionCliError(processFailureCategory(error.kind), {
        selected: selectedForError,
        attempts: 0,
        phase,
      })
    }
    if (error instanceof CodexCliCatalogError) {
      throw makeSubscriptionCliError(error.category, {
        selected: selectedForError,
        attempts: 0,
        phase,
      })
    }
    throw makeSubscriptionCliError("LOCAL_PROCESS_FAILED", {
      selected: selectedForError,
      attempts: 0,
      phase,
    })
  }

  // Resolve the tuple against the installed catalog BEFORE writing any customer
  // input to disk, so an unsupported capability request cannot create staged
  // data. Mirrors the Claude path.
  const selectedFallback = selectedForError
  let resolved: ReturnType<typeof resolveCodexCliTuple>
  try {
    resolved = resolveCodexCliTuple({
      profile: request.profile,
      imageCount: request.images.length,
      observedCatalog,
      override: request.override,
    })
  } catch (error) {
    if (error instanceof CodexCliCapabilityError) {
      throw makeSubscriptionCliError("UNSUPPORTED_CAPABILITY", {
        selected: selectedFallback,
        attempts: 0,
        phase,
      })
    }
    throw error
  }

  const selected = Object.freeze({
    lane: "local-build" as const,
    engine: "codex-cli" as const,
    model: resolved.model,
    effort: resolved.effort,
  })

  let staged: StagedCodexCliRun
  let invocation: ReturnType<typeof buildCodexCliInvocation>
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

  try {
    invocation = buildCodexCliInvocation({
      profile: request.profile,
      prompt: request.prompt,
      instructionsFilename: staged.instructionsFilename,
      imageFilenames: staged.imageFilenames,
      observedCatalog,
      override: request.override,
    })
  } catch (error) {
    await rm(staged.cwd, { recursive: true, force: true }).catch(() => {})
    if (error instanceof CodexCliCapabilityError) {
      throw makeSubscriptionCliError("UNSUPPORTED_CAPABILITY", {
        selected,
        attempts: 0,
        phase,
      })
    }
    throw error
  }

  let processResult: { stdout: string }
  try {
    processResult = await (deps.runProcess ?? runSubscriptionCliProcess)({
      command: resolveCodexCommand(),
      args: invocation.args,
      stdin: invocation.stdin,
      cwd: staged.cwd,
      deadlineMs: request.deadlineMs ?? 5 * 60_000,
      signal: request.signal,
      cleanupPaths: staged.cleanupPaths,
      classifyFailure: ({ stdout, stderr }) =>
        classifyCodexCliFailure({ stdout, stderr }),
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

  let parsed: ReturnType<typeof parseCodexCliOutput>
  try {
    parsed = parseCodexCliOutput(processResult.stdout)
  } catch (error) {
    if (error instanceof CodexCliOutputError) {
      // The transcript dies with the process, so a rejection that says nothing
      // can only be diagnosed by re-running against the live CLI. Report the
      // redacted event shape to the developer's stderr — never into the error,
      // which is a returned value and must stay free of provider output.
      ;(deps.onInvalidOutput ?? defaultOnInvalidOutput)(
        summarizeCodexTranscriptShape(processResult.stdout)
      )
      throw makeSubscriptionCliError("INVALID_OUTPUT", {
        selected,
        attempts: 1,
        phase,
      })
    }
    throw error
  }

  return Object.freeze({
    text: parsed.text,
    output: parsed.text,
    selected,
    // Selection is proven (argv + installed catalog). Resolution is not, and is
    // therefore not claimed: no `actual`, ever, on this path.
    identityEvidence: "selected-only" as const,
    attempts: 1 as const,
    usage: parsed.usage,
    finishReason: "stop" as const,
  })
}
