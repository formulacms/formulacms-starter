"use server"

// Dev-only Next server actions for the admin slice-authoring flows.
//
// The retired Convex actions (create/text/tweak/renderer-proposal, see
// `convex/agents/sliceAuthor.ts` for the retirement notice) shipped these on
// the runtime BYOK lane. ADR-0032's 2026-07-14 amendment moved slice
// authoring back to the developer's machine: this file drives the local API
// engine (`scripts/lib/ai-api-engine.ts`) with the Slice
// creator's saved settings (Convex `cms/aiSettings:sliceCreator`, owner-only,
// AI module on) and the API key from the local environment. Convex never
// makes the model call and never returns a key. It is unreachable from a
// deployed admin — `assertLocalDevelopment` guards every entry point and
// `/admin/slices/create` already returns `notFound()` in production.
//
// The four actions here mirror the retired Convex creation/model actions so
// the create and model-tweak components can use the build lane without changing
// their surrounding retry / persist orchestration. Interactive whole-renderer
// refinement was removed from slice-sim by Plan 032 Phase 0.

import { createLocalAccounting } from "@/lib/ai/local-accounting"
import { localProviderKeyPresence } from "@/lib/local-api-keys"
import { prependAssistantInstructions } from "@/lib/ai/task-profiles"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { api } from "@/convex/_generated/api"
import { renderTemplate } from "@/convex/lib/agents/registry"
import { buildMarkupBlockForLang } from "@/convex/lib/agents/markup"
import { moduleFailureState } from "@/components/admin/module-gate"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { fetchAuthQuery } from "@/lib/auth-server"
import { requireInstallationOwner } from "@/lib/owner-server"
import { resolveSliceCreatorSelection } from "@/lib/slices/authoring/creator-selection"
import { readSliceModelSourceRevision } from "@/lib/slices/authoring/model-source-revision"
import {
  extractAuthorResult,
  formatPresentationTriageContext,
  type SectionBrief,
} from "@/lib/slices/authoring/author-result"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"
import {
  SLICE_AUTHOR_AGENT,
  SLICE_CREATE_AUTHOR_AGENT,
  SLICE_RENDERER_AGENT,
  rendererDesignSourceLine,
} from "@/lib/slices/authoring/agent-prompts"
import {
  buildCreateSliceBrief,
  describeTargetSection,
  extractRendererJsxBody,
  extractSliceSpecJson,
  OUTPUT_CONTRACT,
  SLICE_INPUT_CAPS,
  TEXT_OUTPUT_CONTRACT,
  TWEAK_OUTPUT_CONTRACT,
} from "@/lib/slices/authoring/contracts"
import type { MarkupLang } from "@/convex/lib/agents/markup"
import { MAX_MARKUP_CHARS } from "@/convex/lib/agents/markup"
import {
  getSliceVerificationProposal,
  getSliceVerificationRenderer,
} from "@/lib/slices/verification-fixtures"
import {
  resolveSliceVerificationScenario,
  type SliceVerificationScenario,
} from "@/lib/slices/verification"
import {
  classifySliceChangeIntent,
  mayReachSliceSpecModel,
} from "@/lib/slices/visual-tweak/intent-routing"

// Deferred local API engine (provider adapters and key reads). Same rule as
// `translateFieldDev` in the sibling settings/ai/actions.ts: it stays in a
// lazy chunk behind the local-dev gate. `turbopackIgnore` MUST NOT be added — the "@/"
// alias would then reach raw Node unresolved at call time.
async function loadEngineRuntime() {
  assertLocalDevelopment("Slice authoring in the admin")
  return import("@/scripts/lib/ai-api-engine")
}

// A proposed new Slice Type gets the same content-model policy that saving
// applies (`persistSliceSpec`), but before the paid renderer call. Deferred
// like the engine: the persistence module stays behind the local-dev gate.
async function assertProposedContentModel(specJson: string): Promise<void> {
  assertLocalDevelopment("Slice authoring in the admin")
  const [{ parseSliceSpecJson }, { assertNewSlicePolicy }] = await Promise.all([
    import("@/lib/slices/authoring/persist"),
    import("@/lib/slices/authoring/factory-policy"),
  ])
  try {
    assertNewSlicePolicy(parseSliceSpecJson(specJson))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`The proposed content model is not valid: ${reason}`)
  }
}

// The Slice creator runs with its saved provider, model and effort, or, with
// nothing saved, with the first provider whose key is in the local
// environment (each step then uses its own default model and effort). It
// fails closed when the AI module is off or the chosen provider has no key;
// it never switches to another provider on its own.
async function resolveSliceCreatorOrThrow(): Promise<{
  provider: import("@/scripts/lib/ai-api-engine").LocalApiRequest["provider"]
  model?: string
  effort?: import("@/lib/ai/execution-contract").ReasoningEffort
  instructions?: string
}> {
  let saved
  try {
    saved = await fetchAuthQuery(api.cms.aiSettings.sliceCreator, {})
  } catch (error) {
    if (moduleFailureState(error) === "off") {
      throw new Error("AI is not enabled. You can enable it here.")
    }
    throw error
  }
  const selection = resolveSliceCreatorSelection(
    saved.tuple,
    localProviderKeyPresence()
  )
  if (!selection.keyPresent || selection.provider === null) {
    throw new Error("The selected AI provider is not configured.")
  }
  return {
    provider: selection.provider,
    model: selection.model,
    effort: selection.effort,
    instructions: saved.instructions,
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
  if (input.imageDataUrl.length > SLICE_INPUT_CAPS.imageDataUrl) {
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
  const dir = await mkdtemp(join(tmpdir(), "formulacms-devai-slice-"))
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

// The local API engine reports the provider's `finalStep.response.modelId` on
// `actual` and the requested model on `selected.model`, which is what the
// admin surface used to report — mirror the retired action's contract by
// picking that.
function reportedModelId(
  result: import("@/lib/ai/execution-contract").GenerationResult<string>
): string {
  return result.selected.model
}

// The Create screen sends only the user's own text and suggested name; the
// server builds every instruction around them (buildCreateSliceBrief).
function assertCreateInputWithinCaps(brief: string, suggestedName?: string) {
  if (brief.length > SLICE_INPUT_CAPS.brief) {
    throw new Error(
      "Your instructions are too long. Shorten them and try again."
    )
  }
  const name = suggestedName?.replace(/\s+/g, " ").trim() ?? ""
  if (name.length > SLICE_INPUT_CAPS.suggestedName) {
    throw new Error("The suggested name is too long. Shorten it and try again.")
  }
}

// Shared caller-facing return shape for all local admin authoring paths.
export interface SliceProposalResult {
  readonly proposal: string
  readonly specJson: string | null
  readonly decomposition: SectionBrief[] | null
  readonly modelId: string
}

export interface SliceRendererResult {
  readonly proposal: string
  readonly rendererBody: string | null
  readonly modelId: string
}

export interface CreateSliceProposalArgs {
  /** The user's own note; may be empty. */
  readonly brief: string
  readonly suggestedName?: string
  readonly imageDataUrl?: string
  readonly imageMediaType?: string
  readonly sourceMarkup?: string
  readonly markupLang?: MarkupLang
  readonly verificationScenario?: SliceVerificationScenario
}

export async function createSliceProposalDev(
  args: CreateSliceProposalArgs
): Promise<SliceProposalResult> {
  assertLocalDevelopment("Slice authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  const brief = args.brief.trim()
  const markup = args.sourceMarkup?.trim()
  if (!args.imageDataUrl && !markup) {
    throw new Error("Provide a snapshot image or source markup.")
  }
  if (args.verificationScenario !== undefined) {
    const scenario = resolveSliceVerificationScenario(args.verificationScenario)
    if (!scenario) throw new Error("Invalid or disabled verification scenario.")
    return getSliceVerificationProposal(scenario)
  }
  assertCreateInputWithinCaps(brief, args.suggestedName)
  if (markup && markup.length > MAX_MARKUP_CHARS) {
    throw new Error(
      "Source markup is too large for inline AI analysis. Trim it to the relevant section."
    )
  }

  assertInlineImage(args)
  const selection = await resolveSliceCreatorOrThrow()
  const { generateWithLocalApi } = await loadEngineRuntime()
  const accounting = createLocalAccounting()

  const markupBlock = markup
    ? buildMarkupBlockForLang(markup, args.markupLang ?? "html")
    : ""
  const prompt =
    renderTemplate(SLICE_CREATE_AUTHOR_AGENT.userPromptTemplate, {
      brief: buildCreateSliceBrief({
        source: markup ? "markup" : "snapshot",
        hasImage: Boolean(args.imageDataUrl),
        userText: brief,
        suggestedName: args.suggestedName,
      }),
    }) +
    markupBlock +
    OUTPUT_CONTRACT +
    "\n\n" +
    formatPresentationTriageContext(await readSlicePresentationCatalog())

  const staged = await stageImages([
    { imageDataUrl: args.imageDataUrl, imageMediaType: args.imageMediaType },
  ])
  try {
    const result = await generateWithLocalApi(
      {
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort,
        instructions: prependAssistantInstructions(
          selection.instructions,
          SLICE_CREATE_AUTHOR_AGENT.systemPrompt
        ),
        prompt,
        images: staged.images,
        profile: "vision-spec",
        phase: "slice-spec",
      },
      accounting
    )
    const authored = extractAuthorResult(
      result.text,
      await readSlicePresentationCatalog()
    )
    if (authored?.kind === "single-slice") {
      await assertProposedContentModel(authored.specJson)
    }
    return {
      proposal: result.text.trim(),
      specJson: authored?.kind === "single-slice" ? authored.specJson : null,
      decomposition:
        authored?.kind === "decomposition" ? authored.sections : null,
      modelId: reportedModelId(result),
    }
  } finally {
    await staged.cleanup()
  }
}

export interface CreateTextSliceProposalArgs {
  /** The user's own description of the slice. */
  readonly brief: string
  readonly suggestedName?: string
  readonly verificationScenario?: SliceVerificationScenario
}

export async function createTextSliceProposalDev(
  args: CreateTextSliceProposalArgs
): Promise<SliceProposalResult> {
  assertLocalDevelopment("Slice authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  const brief = args.brief.trim()
  if (!brief) throw new Error("Brief is required.")
  if (args.verificationScenario !== undefined) {
    const scenario = resolveSliceVerificationScenario(args.verificationScenario)
    if (!scenario) throw new Error("Invalid or disabled verification scenario.")
    return getSliceVerificationProposal(scenario)
  }
  assertCreateInputWithinCaps(brief, args.suggestedName)

  const selection = await resolveSliceCreatorOrThrow()
  const { generateWithLocalApi } = await loadEngineRuntime()
  const accounting = createLocalAccounting()

  const prompt =
    renderTemplate(SLICE_CREATE_AUTHOR_AGENT.userPromptTemplate, {
      brief: buildCreateSliceBrief({
        source: "description",
        hasImage: false,
        userText: brief,
        suggestedName: args.suggestedName,
      }),
    }) +
    TEXT_OUTPUT_CONTRACT +
    "\n\n" +
    formatPresentationTriageContext(await readSlicePresentationCatalog())

  const result = await generateWithLocalApi(
    {
      provider: selection.provider,
      model: selection.model,
      effort: selection.effort,
      instructions: prependAssistantInstructions(
        selection.instructions,
        SLICE_CREATE_AUTHOR_AGENT.systemPrompt
      ),
      prompt,
      images: [],
      profile: "vision-spec",
      phase: "slice-spec",
    },
    accounting
  )
  const authored = extractAuthorResult(
    result.text,
    await readSlicePresentationCatalog()
  )
  if (authored?.kind === "single-slice") {
    await assertProposedContentModel(authored.specJson)
  }
  return {
    proposal: result.text.trim(),
    specJson: authored?.kind === "single-slice" ? authored.specJson : null,
    decomposition:
      authored?.kind === "decomposition" ? authored.sections : null,
    modelId: reportedModelId(result),
  }
}

export interface TweakSliceProposalArgs {
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

export async function tweakSliceProposalDev(
  args: TweakSliceProposalArgs
): Promise<
  SliceProposalResult | { status: "refused"; reason: "stale_source" }
> {
  assertLocalDevelopment("Slice authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  const brief = args.brief.trim()
  if (!brief) throw new Error("Brief is required.")
  if (brief.length > SLICE_INPUT_CAPS.brief) {
    throw new Error(
      "Your instructions are too long. Shorten them and try again."
    )
  }
  if (!args.currentSpecJson.trim()) {
    throw new Error("Current block spec is required.")
  }
  if (args.currentSpecJson.length > SLICE_INPUT_CAPS.specJson) {
    throw new Error("This block's definition is too large to process.")
  }
  if (
    args.target &&
    (args.target.text?.length ?? 0) > SLICE_INPUT_CAPS.targetText
  ) {
    throw new Error(
      "The selected text is too long. Select a shorter part of the preview."
    )
  }

  const intent = classifySliceChangeIntent(brief)
  if (!mayReachSliceSpecModel(intent)) {
    throw new Error(intent.message)
  }

  const refusal = { status: "refused", reason: "stale_source" } as const
  async function baseIsCurrent() {
    try {
      return (
        JSON.parse(args.currentSpecJson).type === args.expectedType &&
        /^[a-f0-9]{64}$/.test(args.expectedSourceRevision ?? "") &&
        (await readSliceModelSourceRevision(args.expectedType)) ===
          args.expectedSourceRevision
      )
    } catch {
      return false
    }
  }
  if (!(await baseIsCurrent())) return refusal

  assertInlineImage(args)
  const selection = await resolveSliceCreatorOrThrow()
  const { generateWithLocalApi } = await loadEngineRuntime()
  const accounting = createLocalAccounting()

  const prompt = [
    renderTemplate(SLICE_AUTHOR_AGENT.userPromptTemplate, { brief }),
    describeTargetSection(args.target),
    TWEAK_OUTPUT_CONTRACT,
    "## Current SliceSpec",
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
    const result = await generateWithLocalApi(
      {
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort,
        instructions: prependAssistantInstructions(
          selection.instructions,
          SLICE_AUTHOR_AGENT.systemPrompt
        ),
        prompt,
        images: staged.images,
        profile: "vision-spec",
        phase: "slice-spec",
      },
      accounting
    )
    if (!(await baseIsCurrent())) return refusal
    return {
      proposal: result.text.trim(),
      specJson: extractSliceSpecJson(result.text),
      decomposition: null,
      modelId: reportedModelId(result),
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

export interface CreateSliceRendererProposalArgs {
  readonly specJson: string
  readonly imageDataUrl?: string
  readonly imageMediaType?: string
  readonly sourceMarkup?: string
  readonly markupLang?: MarkupLang
  readonly previousAttempt?: string
  readonly previousError?: string
  readonly verificationScenario?: SliceVerificationScenario
}

export async function createSliceRendererProposalDev(
  args: CreateSliceRendererProposalArgs
): Promise<SliceRendererResult> {
  assertLocalDevelopment("Slice authoring in the admin")
  await requireInstallationOwner(
    "Only the installation owner can author blocks."
  )

  if (!args.specJson.trim()) throw new Error("Block spec is required.")
  if (args.verificationScenario !== undefined) {
    const scenario = resolveSliceVerificationScenario(args.verificationScenario)
    if (!scenario) throw new Error("Invalid or disabled verification scenario.")
    return getSliceVerificationRenderer(scenario)
  }
  if (args.specJson.length > SLICE_INPUT_CAPS.specJson) {
    throw new Error("This block's definition is too large to process.")
  }
  if ((args.previousAttempt?.length ?? 0) > SLICE_INPUT_CAPS.previousAttempt) {
    throw new Error(
      "The previous attempt is too large to retry. Start a new request."
    )
  }
  if ((args.previousError?.length ?? 0) > SLICE_INPUT_CAPS.previousError) {
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
  const selection = await resolveSliceCreatorOrThrow()
  const { generateWithLocalApi } = await loadEngineRuntime()
  const accounting = createLocalAccounting()

  const sections = [
    renderTemplate(SLICE_RENDERER_AGENT.userPromptTemplate, {
      designSource: rendererDesignSourceLine({
        hasImage: Boolean(args.imageDataUrl),
        hasMarkup: Boolean(markup),
      }),
      specJson: args.specJson.trim(),
    }),
  ]
  if (markup) {
    sections.push(buildMarkupBlockForLang(markup, args.markupLang ?? "html"))
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
    const result = await generateWithLocalApi(
      {
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort,
        instructions: prependAssistantInstructions(
          selection.instructions,
          SLICE_RENDERER_AGENT.systemPrompt
        ),
        prompt,
        images: staged.images,
        profile: "renderer-jsx",
        phase: "renderer-jsx",
      },
      accounting
    )
    return {
      proposal: result.text.trim(),
      rendererBody: extractRendererJsxBody(result.text),
      modelId: reportedModelId(result),
    }
  } finally {
    await staged.cleanup()
  }
}
