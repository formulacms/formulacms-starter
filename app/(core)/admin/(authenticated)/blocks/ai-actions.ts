"use server"

// Dev-only Next server actions for the admin block-authoring flows.
//
// The retired Convex actions (create/text/tweak/renderer-proposal, see
// `convex/agents/blockAuthor.ts` for the retirement notice) shipped these on
// the runtime BYOK lane. ADR-0032's 2026-07-14 amendment moved block
// authoring back to the developer's machine: this file drives the local API
// engine (`scripts/lib/ai-api-engine.ts`) with the Block
// creator's saved settings (Convex `cms/aiSettings:blockCreator`, owner-only,
// AI module on) and the API key from the local environment, or the local
// tool (Claude Code, Codex) that Settings › AI chose for the Block creator
// (`ai-local-tool.ts`, ADR-0057). Convex never makes the model call and never
// returns a key. It is unreachable from a
// deployed admin — `assertLocalDevelopment` guards every entry point and
// `/admin/blocks/create` already returns `notFound()` in production.
//
// The four actions here mirror the retired Convex creation/model actions so
// the create and model-tweak components can use the build lane without changing
// their surrounding retry / persist orchestration. Interactive whole-renderer
// refinement was removed from block-sim by Plan 032 Phase 0.

import { createLocalAccounting } from "@/lib/ai/local-accounting"
import { localProviderKeyPresenceNow } from "@/lib/local-api-keys-file"
import { prependAssistantInstructions } from "@/lib/ai/task-profiles"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { api } from "@/convex/_generated/api"
import { renderTemplate } from "@/convex/lib/agents/registry"
import { buildMarkupSectionForLang } from "@/convex/lib/agents/markup"
import type { BlockCreatorProfile } from "@/convex/agents/localGeneration"
import { moduleFailureState } from "@/components/admin/module-gate"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { fetchAuthQuery } from "@/lib/auth/server"
import { requireInstallationOwner } from "@/lib/owner-server"
import { resolveBlockCreatorSelection } from "@/lib/blocks/authoring/creator-selection"
import { readBlockModelSourceRevision } from "@/lib/blocks/authoring/model-source-revision"
import {
  extractAuthorResult,
  formatPresentationTriageContext,
  type SectionBrief,
} from "@/lib/blocks/authoring/author-result"
import { readBlockPresentationCatalog } from "@/convex/lib/blocks/presentations"
import {
  BLOCK_AUTHOR_AGENT,
  BLOCK_CREATE_AUTHOR_AGENT,
  BLOCK_RENDERER_AGENT,
  rendererDesignSourceLine,
} from "@/lib/blocks/authoring/agent-prompts"
import {
  buildCreateBlockBrief,
  describeTargetSection,
  extractRendererJsxBody,
  extractBlockSpecJson,
  OUTPUT_CONTRACT,
  BLOCK_INPUT_CAPS,
  TEXT_OUTPUT_CONTRACT,
  TWEAK_OUTPUT_CONTRACT,
} from "@/lib/blocks/authoring/contracts"
import type { MarkupLang } from "@/convex/lib/agents/markup"
import { MAX_MARKUP_CHARS } from "@/convex/lib/agents/markup"
import {
  getBlockVerificationProposal,
  getBlockVerificationRenderer,
} from "@/lib/blocks/verification-fixtures"
import {
  resolveBlockVerificationScenario,
  type BlockVerificationScenario,
} from "@/lib/blocks/verification"
import {
  classifyBlockChangeIntent,
  mayReachBlockSpecModel,
} from "@/lib/blocks/visual-tweak/intent-routing"

// Deferred local API engine (provider adapters and key reads). Same rule as
// `translateFieldDev` in the sibling settings/ai/actions.ts: it stays in a
// lazy chunk behind the local-dev gate. `turbopackIgnore` MUST NOT be added — the "@/"
// alias would then reach raw Node unresolved at call time.
async function loadEngineRuntime() {
  assertLocalDevelopment("Block authoring in the admin")
  return import("@/scripts/lib/ai-api-engine")
}

// A proposed new Block Type gets the same content-model policy that saving
// applies (`persistBlockSpec`), but before the paid renderer call. Deferred
// like the engine: the persistence module stays behind the local-dev gate.
async function assertProposedContentModel(specJson: string): Promise<void> {
  assertLocalDevelopment("Block authoring in the admin")
  const [{ parseBlockSpecJson }, { assertNewBlockPolicy }] = await Promise.all([
    import("@/lib/blocks/authoring/persist"),
    import("@/lib/blocks/authoring/factory-policy"),
  ])
  try {
    assertNewBlockPolicy(parseBlockSpecJson(specJson))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`The proposed content model is not valid: ${reason}`)
  }
}

// The Block creator's saved settings (Convex, owner-only, AI module on).
async function readBlockCreatorSettings() {
  try {
    return await fetchAuthQuery(api.cms.aiSettings.blockCreator, {})
  } catch (error) {
    if (moduleFailureState(error) === "off") {
      throw new Error("AI is not enabled. You can enable it here.")
    }
    throw error
  }
}

type BlockCreatorRun = (step: {
  systemPrompt: string
  prompt: string
  images: import("@/scripts/lib/ai-api-engine").EngineImage[]
}) => Promise<{ text: string; modelId: string }>

const STEP_PHASES = {
  "vision-spec": "block-spec",
  "renderer-jsx": "renderer-jsx",
} as const

// Which engine runs a Block creator step. A local tool chosen in Settings ›
// AI runs it, with the saved model and effort, for a browser on this
// computer only: from another device the route check refuses, and the step
// never switches to an API service. Otherwise the Block creator runs with its
// saved provider, model and effort, or, with nothing saved, with the first
// provider whose key is in the local environment (each step then uses its own
// default model and effort, or the replacement Settings shows when that
// default is no longer offered: `resolveLocalApiTuple`). It fails closed when the AI module is off or the
// chosen provider has no key; it never switches to another provider on its
// own. The saved Instructions apply to both.
async function prepareBlockCreatorRun(
  profile: BlockCreatorProfile
): Promise<BlockCreatorRun> {
  assertLocalDevelopment("Block authoring in the admin")
  const phase = STEP_PHASES[profile]
  const { resolveLocalAiRoute } = await import("../pages/local-ai-routing")
  const route = await resolveLocalAiRoute(profile)
  const saved = await readBlockCreatorSettings()
  const request = (step: Parameters<BlockCreatorRun>[0]) => ({
    instructions: prependAssistantInstructions(
      saved.instructions,
      step.systemPrompt
    ),
    prompt: step.prompt,
    images: step.images,
    profile,
    phase,
  })
  if (route.engine === "claude" || route.engine === "codex") {
    const { runBlockCreatorStepOnLocalTool } = await import("./ai-local-tool")
    const tool = {
      engine: route.engine,
      ...(route.model !== undefined ? { model: route.model } : {}),
      ...(route.effort !== undefined ? { effort: route.effort } : {}),
    }
    return (step) => runBlockCreatorStepOnLocalTool(tool, request(step))
  }

  const selection = resolveBlockCreatorSelection(
    saved.tuple,
    localProviderKeyPresenceNow()
  )
  if (!selection.keyPresent || selection.provider === null) {
    throw new Error("The selected AI provider is not configured.")
  }
  const { provider, model, effort } = selection
  const { generateWithLocalApi } = await loadEngineRuntime()
  const { catalogFromEntries } = await import("@/lib/ai/model-catalog")
  const catalog = catalogFromEntries(saved.catalog)
  const accounting = createLocalAccounting()
  return async (step) => {
    const result = await generateWithLocalApi(
      { provider, model, effort, catalog, ...request(step) },
      accounting
    )
    // The requested model, as the retired Convex action reported it.
    return { text: result.text, modelId: result.selected.model }
  }
}

interface ImageInput {
  readonly imageDataUrl?: string
  readonly imageMediaType?: string
}

interface StagedImages {
  readonly images: import("@/scripts/lib/ai-api-engine").EngineImage[]
  readonly cleanup: () => Promise<void>
}

/** Refuse an attachment the engine must not receive. Runs before the engine is
 *  chosen and again before anything is written to a temporary folder. */
function assertInlineImage(input: ImageInput): void {
  if (!input.imageDataUrl) return
  if (!(input.imageMediaType ?? "image/png").startsWith("image/")) {
    throw new Error("Image attachment must have an image MIME type.")
  }
  if (input.imageDataUrl.length > BLOCK_INPUT_CAPS.imageDataUrl) {
    throw new Error(
      "Snapshot is too large for inline AI analysis. Use a smaller screenshot."
    )
  }
}

async function stageImages(inputs: ImageInput[]): Promise<StagedImages> {
  const present = inputs.filter((i) => i.imageDataUrl)
  present.forEach(assertInlineImage)
  if (present.length === 0) {
    return { images: [], cleanup: async () => {} }
  }
  const dir = await mkdtemp(join(tmpdir(), "formulacms-devai-block-"))
  const images: import("@/scripts/lib/ai-api-engine").EngineImage[] = []
  for (const [idx, input] of present.entries()) {
    if (!input.imageDataUrl) continue
    const mediaType = input.imageMediaType ?? "image/png"
    const commaAt = input.imageDataUrl.indexOf(",")
    const base64 =
      commaAt >= 0 ? input.imageDataUrl.slice(commaAt + 1) : input.imageDataUrl
    const ext =
      mediaType === "image/jpeg"
        ? "jpg"
        : mediaType === "image/webp"
          ? "webp"
          : mediaType === "image/gif"
            ? "gif"
            : "png"
    const path = join(dir, `image-${idx}.${ext}`)
    await writeFile(path, Buffer.from(base64, "base64"))
    images.push({ path, mediaType })
  }
  return {
    images,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        // Best-effort — a leaked temp dir would be swept by the OS.
      }
    },
  }
}

// The Create screen sends only the user's own text and suggested name; the
// server builds every instruction around them (buildCreateBlockBrief).
function assertCreateInputWithinCaps(brief: string, suggestedName?: string) {
  if (brief.length > BLOCK_INPUT_CAPS.brief) {
    throw new Error(
      "Your instructions are too long. Shorten them and try again."
    )
  }
  const name = suggestedName?.replace(/\s+/g, " ").trim() ?? ""
  if (name.length > BLOCK_INPUT_CAPS.suggestedName) {
    throw new Error("The suggested name is too long. Shorten it and try again.")
  }
}

// Shared caller-facing return shape for all local admin authoring paths.
export interface BlockProposalResult {
  readonly proposal: string
  readonly specJson: string | null
  readonly decomposition: SectionBrief[] | null
  readonly modelId: string
}

export interface BlockRendererResult {
  readonly proposal: string
  readonly rendererBody: string | null
  readonly modelId: string
}

export interface CreateBlockProposalArgs {
  /** The user's own note; may be empty. */
  readonly brief: string
  readonly suggestedName?: string
  readonly imageDataUrl?: string
  readonly imageMediaType?: string
  readonly sourceMarkup?: string
  readonly markupLang?: MarkupLang
  readonly verificationScenario?: BlockVerificationScenario
}

export async function createBlockProposalDev(
  args: CreateBlockProposalArgs
): Promise<BlockProposalResult> {
  assertLocalDevelopment("Block authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  const brief = args.brief.trim()
  const markup = args.sourceMarkup?.trim()
  if (!args.imageDataUrl && !markup) {
    throw new Error("Provide a snapshot image or source markup.")
  }
  if (args.verificationScenario !== undefined) {
    const scenario = resolveBlockVerificationScenario(args.verificationScenario)
    if (!scenario) throw new Error("Invalid or disabled verification scenario.")
    return getBlockVerificationProposal(scenario)
  }
  assertCreateInputWithinCaps(brief, args.suggestedName)
  if (markup && markup.length > MAX_MARKUP_CHARS) {
    throw new Error(
      "Source markup is too large for inline AI analysis. Trim it to the relevant section."
    )
  }

  assertInlineImage(args)
  const run = await prepareBlockCreatorRun("vision-spec")

  const markupBlock = markup
    ? buildMarkupSectionForLang(markup, args.markupLang ?? "html")
    : ""
  const prompt =
    renderTemplate(BLOCK_CREATE_AUTHOR_AGENT.userPromptTemplate, {
      brief: buildCreateBlockBrief({
        source: markup ? "markup" : "snapshot",
        hasImage: Boolean(args.imageDataUrl),
        userText: brief,
        suggestedName: args.suggestedName,
      }),
    }) +
    markupBlock +
    OUTPUT_CONTRACT +
    "\n\n" +
    formatPresentationTriageContext(await readBlockPresentationCatalog())

  const staged = await stageImages([
    { imageDataUrl: args.imageDataUrl, imageMediaType: args.imageMediaType },
  ])
  try {
    const result = await run({
      systemPrompt: BLOCK_CREATE_AUTHOR_AGENT.systemPrompt,
      prompt,
      images: staged.images,
    })
    const authored = extractAuthorResult(
      result.text,
      await readBlockPresentationCatalog()
    )
    if (authored?.kind === "single-block") {
      await assertProposedContentModel(authored.specJson)
    }
    return {
      proposal: result.text.trim(),
      specJson: authored?.kind === "single-block" ? authored.specJson : null,
      decomposition:
        authored?.kind === "decomposition" ? authored.sections : null,
      modelId: result.modelId,
    }
  } finally {
    await staged.cleanup()
  }
}

export interface CreateTextBlockProposalArgs {
  /** The user's own description of the block. */
  readonly brief: string
  readonly suggestedName?: string
  readonly verificationScenario?: BlockVerificationScenario
}

export async function createTextBlockProposalDev(
  args: CreateTextBlockProposalArgs
): Promise<BlockProposalResult> {
  assertLocalDevelopment("Block authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  const brief = args.brief.trim()
  if (!brief) throw new Error("Brief is required.")
  if (args.verificationScenario !== undefined) {
    const scenario = resolveBlockVerificationScenario(args.verificationScenario)
    if (!scenario) throw new Error("Invalid or disabled verification scenario.")
    return getBlockVerificationProposal(scenario)
  }
  assertCreateInputWithinCaps(brief, args.suggestedName)

  const run = await prepareBlockCreatorRun("vision-spec")

  const prompt =
    renderTemplate(BLOCK_CREATE_AUTHOR_AGENT.userPromptTemplate, {
      brief: buildCreateBlockBrief({
        source: "description",
        hasImage: false,
        userText: brief,
        suggestedName: args.suggestedName,
      }),
    }) +
    TEXT_OUTPUT_CONTRACT +
    "\n\n" +
    formatPresentationTriageContext(await readBlockPresentationCatalog())

  const result = await run({
    systemPrompt: BLOCK_CREATE_AUTHOR_AGENT.systemPrompt,
    prompt,
    images: [],
  })
  const authored = extractAuthorResult(
    result.text,
    await readBlockPresentationCatalog()
  )
  if (authored?.kind === "single-block") {
    await assertProposedContentModel(authored.specJson)
  }
  return {
    proposal: result.text.trim(),
    specJson: authored?.kind === "single-block" ? authored.specJson : null,
    decomposition:
      authored?.kind === "decomposition" ? authored.sections : null,
    modelId: result.modelId,
  }
}

export interface TweakBlockProposalArgs {
  readonly brief: string
  readonly currentSpecJson: string
  readonly expectedType: string
  readonly expectedSourceRevision: string
  readonly imageDataUrl?: string
  readonly imageMediaType?: string
  readonly target?: {
    readonly fieldPath: string
    readonly humanLabel: string
    readonly text?: string
  }
}

export async function tweakBlockProposalDev(
  args: TweakBlockProposalArgs
): Promise<
  BlockProposalResult | { status: "refused"; reason: "stale_source" }
> {
  assertLocalDevelopment("Block authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  const brief = args.brief.trim()
  if (!brief) throw new Error("Brief is required.")
  if (brief.length > BLOCK_INPUT_CAPS.brief) {
    throw new Error(
      "Your instructions are too long. Shorten them and try again."
    )
  }
  if (!args.currentSpecJson.trim()) {
    throw new Error("Current block spec is required.")
  }
  if (args.currentSpecJson.length > BLOCK_INPUT_CAPS.specJson) {
    throw new Error("This block's definition is too large to process.")
  }
  if (
    args.target &&
    (args.target.text?.length ?? 0) > BLOCK_INPUT_CAPS.targetText
  ) {
    throw new Error(
      "The selected text is too long. Select a shorter part of the preview."
    )
  }

  const intent = classifyBlockChangeIntent(brief)
  if (!mayReachBlockSpecModel(intent)) {
    throw new Error(intent.message)
  }

  const refusal = { status: "refused", reason: "stale_source" } as const
  async function baseIsCurrent() {
    try {
      return (
        JSON.parse(args.currentSpecJson).type === args.expectedType &&
        /^[a-f0-9]{64}$/.test(args.expectedSourceRevision ?? "") &&
        (await readBlockModelSourceRevision(args.expectedType)) ===
          args.expectedSourceRevision
      )
    } catch {
      return false
    }
  }
  if (!(await baseIsCurrent())) return refusal

  assertInlineImage(args)
  const run = await prepareBlockCreatorRun("vision-spec")

  const prompt = [
    renderTemplate(BLOCK_AUTHOR_AGENT.userPromptTemplate, { brief }),
    describeTargetSection(args.target),
    TWEAK_OUTPUT_CONTRACT,
    "## Current BlockSpec",
    "",
    "```json",
    args.currentSpecJson,
    "```",
  ]
    .filter(Boolean)
    .join("\n")

  const staged = await stageImages([
    { imageDataUrl: args.imageDataUrl, imageMediaType: args.imageMediaType },
  ])
  try {
    const result = await run({
      systemPrompt: BLOCK_AUTHOR_AGENT.systemPrompt,
      prompt,
      images: staged.images,
    })
    if (!(await baseIsCurrent())) return refusal
    return {
      proposal: result.text.trim(),
      specJson: extractBlockSpecJson(result.text),
      decomposition: null,
      modelId: result.modelId,
    }
  } catch (error) {
    // An engine failure is also an obsolete result when its reviewed source
    // has changed. Preserve genuine failures only for the current base.
    if (!(await baseIsCurrent())) return refusal
    throw error
  } finally {
    await staged.cleanup()
  }
}

export interface CreateBlockRendererProposalArgs {
  readonly specJson: string
  readonly imageDataUrl?: string
  readonly imageMediaType?: string
  readonly sourceMarkup?: string
  readonly markupLang?: MarkupLang
  readonly previousAttempt?: string
  readonly previousError?: string
  readonly verificationScenario?: BlockVerificationScenario
}

export async function createBlockRendererProposalDev(
  args: CreateBlockRendererProposalArgs
): Promise<BlockRendererResult> {
  assertLocalDevelopment("Block authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  if (!args.specJson.trim()) throw new Error("Block spec is required.")
  if (args.verificationScenario !== undefined) {
    const scenario = resolveBlockVerificationScenario(args.verificationScenario)
    if (!scenario) throw new Error("Invalid or disabled verification scenario.")
    return getBlockVerificationRenderer(scenario)
  }
  if (args.specJson.length > BLOCK_INPUT_CAPS.specJson) {
    throw new Error("This block's definition is too large to process.")
  }
  if ((args.previousAttempt?.length ?? 0) > BLOCK_INPUT_CAPS.previousAttempt) {
    throw new Error(
      "The previous attempt is too large to retry. Start a new request."
    )
  }
  if ((args.previousError?.length ?? 0) > BLOCK_INPUT_CAPS.previousError) {
    throw new Error(
      "The previous error report is too large to retry. Start a new request."
    )
  }
  const markup = args.sourceMarkup?.trim()
  if (markup && markup.length > MAX_MARKUP_CHARS) {
    throw new Error(
      "Source markup is too large for inline AI analysis. Trim it to the relevant section."
    )
  }

  assertInlineImage(args)
  const run = await prepareBlockCreatorRun("renderer-jsx")

  const sections = [
    renderTemplate(BLOCK_RENDERER_AGENT.userPromptTemplate, {
      designSource: rendererDesignSourceLine({
        hasImage: Boolean(args.imageDataUrl),
        hasMarkup: Boolean(markup),
      }),
      specJson: args.specJson.trim(),
    }),
  ]
  if (markup) {
    sections.push(buildMarkupSectionForLang(markup, args.markupLang ?? "html"))
  }
  if (args.previousError) {
    sections.push(
      "## Previous attempt failed",
      "",
      args.previousAttempt
        ? "Your previous JSX body did not pass the typecheck / verify gate. Fix the issue and try again."
        : "The previous renderer request failed before it returned usable JSX. Address the error and try again.",
      "",
      "Error message:",
      "```",
      args.previousError.trim(),
      "```"
    )
    if (args.previousAttempt) {
      sections.push(
        "",
        "Previous JSX (reject this one):",
        "```jsx",
        args.previousAttempt.trim(),
        "```"
      )
    }
  }
  const prompt = sections.join("\n")

  const staged = await stageImages([
    { imageDataUrl: args.imageDataUrl, imageMediaType: args.imageMediaType },
  ])
  try {
    const result = await run({
      systemPrompt: BLOCK_RENDERER_AGENT.systemPrompt,
      prompt,
      images: staged.images,
    })
    return {
      proposal: result.text.trim(),
      rendererBody: extractRendererJsxBody(result.text),
      modelId: result.modelId,
    }
  } finally {
    await staged.cleanup()
  }
}
