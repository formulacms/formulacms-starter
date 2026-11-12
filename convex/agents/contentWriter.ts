import { isLegacyTitleHtml } from "../lib/richtext/write"
// convex/agents/contentWriter.ts
// AI-powered content writing (ADR-013: editorial copy only).
//
// Sibling of convex/agents/localizer.ts. Where localizer *translates* existing
// content field-by-field, the content writer generates new editorial copy from
// a short brief and refines existing content from a steering instruction. Same
// gating, same registry plumbing.
//
// Trust claim (ADR-013 mechanisms 1 & 2):
//   - Output surface is editorial text only — titles, subtitles, body, button
//     labels. Never an href, image URL, id, or styling field.
//   - For generation, rich-text fields go through buildPMDoc (paragraph-only,
//     mark-free): no node a link/image URL could ride in on.
//   - For refinement, rich-text fields are walked per text node (like the
//     localizer) so marks/links/structure survive byte-for-byte. The model
//     only sees and rewrites the text content of each segment, never the
//     surrounding marks.
//   - Generation: one model call per slice keeps each section's editorial copy
//     coherent. Refinement: one call per field (plain) or per text segment
//     (rich) — refinement is segment-independent by design.
//   - Page context + brand voice (convex/lib/agents/pageContext.ts) are
//     appended to the system prompt to anchor voice and topic across calls.
//   - Typed args/returns via slice/context validators reject anything off-shape
//     at the Convex boundary.
import { v, ConvexError } from "convex/values"
import { action, internalQuery } from "../_generated/server"
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server"
import { internal } from "../_generated/api"
import {
  generateRuntimeText,
  createRuntimeAccounting,
  resolveRuntimeAssistant,
  type RuntimeAssistant,
} from "../lib/ai"
import type { GenerationAccounting } from "../../lib/ai/accounting-contract"
import type {
  ProviderModelSelections,
  RuntimeSelectedProvider,
  TaskDefaults,
} from "../lib/aiConfig"
import {
  runtimeAssistantValidator,
  providerModelSelectionsValidator,
  runtimeSelectedProviderValidator,
  taskDefaultsValidator,
} from "../lib/aiValidators"
import { requireOwnerAndOptionalModule } from "../lib/modules/state"
import { enforceAiRateLimit } from "../lib/aiRateLimit"
import { AGENTS, languageName } from "../lib/agents/registry"
import { buildFieldDoc } from "../lib/richtext/build"
import type { FieldContract } from "../lib/richtext/contracts"
import { installedSliceValidator, type InstalledSlice } from "../lib/slices"
import {
  pageContextValidator,
  type PageContext,
} from "../lib/agents/pageContext"
import {
  assembleMeta,
  assembleOutline,
  assembleRefinedText,
  assembleSlice,
  assertSliceType,
  buildFieldGenerationInput,
  buildPageFillGenerationInput,
  buildPageMetaGenerationInput,
  buildPageOutlineGenerationInput,
  buildRefinementGenerationInput,
  buildSliceGenerationInput,
  refineRichTextSegments,
  type PageOutline,
} from "../lib/agents/contentWriterContract"
import {
  auditFailureFields,
  auditGenerationFields,
  resolveAuditModelId,
  sumUsage,
  toAuditGeneration,
  withAiAudit,
  type AuditGeneration,
  type AuditTokenUsage,
} from "./auditedGenerate"

/** Resolved content-agent config for one run. Includes the operator-edited
 *  brand voice; `undefined` when no voice is configured. */
export interface ContentConfig {
  assistant?: RuntimeAssistant
  accounting: GenerationAccounting
  modelId: string | undefined
  selectedProvider: RuntimeSelectedProvider | undefined
  providerDefaults: ProviderModelSelections | undefined
  taskDefaults: TaskDefaults | undefined
  modelOverrides: ProviderModelSelections | undefined
  systemPrompt: string
  userPromptTemplate: string
  brandVoice: string | undefined
  /** Better Auth `_id` of the caller, threaded through so the action can
   *  attribute an aiAuditLog row without a second auth round-trip. */
  authId: string
}

/**
 * Gate + config resolver. Throws UNAUTHORIZED if the caller lacks `content:ai`;
 * returns the operator's resolved model + prompt templates + brand voice.
 * Model resolution mirrors localizer: agentConfig.model →
 * siteSettings.aiDefaultModel → null (env/built-in default kicks in inside
 * the action).
 */
export const prepareGeneration = internalQuery({
  args: {},
  returns: v.object({
    assistant: runtimeAssistantValidator,
    modelId: v.union(v.string(), v.null()),
    selectedProvider: v.union(runtimeSelectedProviderValidator, v.null()),
    providerDefaults: v.union(providerModelSelectionsValidator, v.null()),
    taskDefaults: v.union(taskDefaultsValidator, v.null()),
    modelOverrides: v.union(providerModelSelectionsValidator, v.null()),
    systemPrompt: v.string(),
    userPromptTemplate: v.string(),
    brandVoice: v.union(v.string(), v.null()),
    authId: v.string(),
  }),
  handler: async (ctx) => {
    const auth = await requireOwnerAndOptionalModule(ctx, "ai")
    return readContentGenerationConfig(ctx, auth.authId)
  },
})

/** Identity-free config read; callers own the owner/job gate. */
export async function readContentGenerationConfig(
  ctx: QueryCtx | MutationCtx,
  authId: string
) {
  const settings = await ctx.db.query("siteSettings").first()
  const agentConfig = await ctx.db
    .query("agentConfigs")
    .withIndex("by_agent", (q) => q.eq("agent", "content"))
    .unique()
  const def = AGENTS.content
  return {
    assistant: await resolveRuntimeAssistant(
      ctx,
      "editorial-copy",
      "content-generation"
    ),
    modelId: agentConfig?.model ?? settings?.aiDefaultModel ?? null,
    selectedProvider: settings?.aiRuntime?.selectedProvider ?? null,
    providerDefaults: settings?.aiRuntime?.providerDefaults ?? null,
    taskDefaults: settings?.aiRuntime?.taskDefaults ?? null,
    modelOverrides: agentConfig?.modelOverrides ?? null,
    // Registry default only — the system prompt is unwritable by design. This
    // extends the §10 Q3 doctrine already stated below (mechanical constraints
    // live in code so an operator can't delete them) to the whole prompt: a bad
    // override here silently fell back to sample placeholder copy, with no error.
    systemPrompt: def.defaultSystemPrompt,
    userPromptTemplate:
      agentConfig?.userPromptTemplate ?? def.defaultUserPromptTemplate,
    brandVoice: settings?.brandVoice ?? null,
    authId,
  }
}

const MAX_BRIEF_CHARS = 2_000
const MAX_INSTRUCTION_CHARS = 1_000
const MAX_RICH_TEXT_CHARS = 200_000

async function gateAi(
  ctx: ActionCtx,
  opts: { pageOp?: boolean } = {}
): Promise<void> {
  await enforceAiRateLimit(ctx, opts)
}

async function gate(ctx: ActionCtx): Promise<ContentConfig> {
  const {
    assistant,
    modelId,
    selectedProvider,
    providerDefaults,
    taskDefaults,
    modelOverrides,
    systemPrompt,
    userPromptTemplate,
    brandVoice,
    authId,
  } = await ctx.runQuery(internal.agents.contentWriter.prepareGeneration, {})
  return {
    assistant,
    accounting: createRuntimeAccounting(ctx, authId),
    modelId: modelId ?? undefined,
    selectedProvider: selectedProvider ?? undefined,
    providerDefaults: providerDefaults ?? undefined,
    taskDefaults: taskDefaults ?? undefined,
    modelOverrides: modelOverrides ?? undefined,
    systemPrompt,
    userPromptTemplate,
    brandVoice: brandVoice ?? undefined,
    authId,
  }
}

/** Run one editorial-text generation call. Returns the raw model text, trimmed
 *  and stripped of any wrapping quotes the model added despite instructions. */
async function generateOne(
  cfg: ContentConfig,
  language: string,
  sliceType: string,
  brief: string,
  fieldLabel: string,
  format: "plain" | "richText",
  context: PageContext | undefined,
  contract?: FieldContract
): Promise<{
  text: string
  usage?: AuditTokenUsage
  generation: AuditGeneration
}> {
  const generationInput = buildFieldGenerationInput({
    systemTemplate: cfg.systemPrompt,
    userTemplate: cfg.userPromptTemplate,
    language,
    sliceType,
    brief,
    fieldLabel,
    format,
    contract,
    context,
    brandVoice: cfg.brandVoice,
  })
  const result = await generateRuntimeText(
    cfg.modelId,
    {
      assistant: cfg.assistant,
      selectedProvider: cfg.selectedProvider,
      providerDefaults: cfg.providerDefaults,
      taskDefaults: cfg.taskDefaults,
      modelOverrides: cfg.modelOverrides,
      profile: "editorial-copy",
      phase: "content-generation",
      ...generationInput,
    },
    cfg.accounting
  )
  return {
    text: stripWrappingQuotes(result.text.trim()),
    usage: result.usage,
    generation: toAuditGeneration(result, "content-generation"),
  }
}

/** Models occasionally wrap a one-line value in quotes despite the rules. */
function stripWrappingQuotes(text: string): string {
  const m = text.match(/^[\s]*["“'']([\s\S]*?)["”'']\s*$/)
  return m && m[1] !== undefined ? m[1].trim() : text
}

// ──────────────────────────────────────────────────────────────────────────────
// Refinement (pure helpers + actions)
// ──────────────────────────────────────────────────────────────────────────────

/** Refine one short text against a steering instruction. Empty / whitespace
 *  segments pass through unchanged so the localizer-style PM-JSON walker can
 *  reuse this without producing zero-length text nodes (ADR-0009 invariant). */
async function refineString(
  text: string,
  instruction: string,
  cfg: ContentConfig,
  language: string,
  fieldLabel: string,
  context: PageContext | undefined
): Promise<{
  text: string
  usage?: AuditTokenUsage
  generation?: AuditGeneration
}> {
  const generationInput = buildRefinementGenerationInput({
    systemTemplate: cfg.systemPrompt,
    language,
    text,
    instruction,
    fieldLabel,
    context,
    brandVoice: cfg.brandVoice,
  })
  if (!generationInput) return { text }
  const result = await generateRuntimeText(
    cfg.modelId,
    {
      assistant: cfg.assistant,
      selectedProvider: cfg.selectedProvider,
      providerDefaults: cfg.providerDefaults,
      taskDefaults: cfg.taskDefaults,
      modelOverrides: cfg.modelOverrides,
      profile: "editorial-copy",
      phase: "content-refinement",
      ...generationInput,
    },
    cfg.accounting
  )
  return {
    text: assembleRefinedText(text, result.text),
    usage: result.usage,
    generation: toAuditGeneration(result, "content-refinement"),
  }
}

/** Public: refine one plain-text field against a steering instruction. */
export const refineField = action({
  args: {
    text: v.string(),
    instruction: v.string(),
    locale: v.string(),
    fieldLabel: v.string(),
    context: v.optional(pageContextValidator),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (args.text.length > MAX_RICH_TEXT_CHARS)
      throw new ConvexError("Text too large.")
    if (args.instruction.length > MAX_INSTRUCTION_CHARS)
      throw new ConvexError("Instruction too long.")
    if (!args.instruction.trim()) {
      throw new ConvexError("Instruction is empty.")
    }
    // F01 operation gate before the rate charge (AI-04): an unauthorized caller
    // must not consume a rate-limit token.
    const cfg = await gate(ctx)
    // A no-op still checks the module, but makes no rate/provider charge.
    if (!args.text.trim()) return args.text
    await gateAi(ctx)
    const modelId = resolveModelId(cfg)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "field-refine",
        modelId,
      },
      async () => {
        const { text, usage, generation } = await refineString(
          args.text,
          args.instruction,
          cfg,
          languageName(args.locale),
          args.fieldLabel,
          args.context
        )
        return { value: text, usage, generation }
      }
    )
  },
})

/**
 * Public: refine one rich-text (PM-JSON) field against a steering instruction.
 *
 * Strategy is per-text-node, matching the localizer: each segment is refined
 * independently so marks (bold/italic/link), structure (paragraphs, lists,
 * tables) and attrs all survive. Known trade-off (documented in the plan):
 * "make this shorter overall" can't compose across segments — each is
 * rewritten in isolation. Use the field-level Write action when restructuring
 * is needed.
 */
export const refineRichText = action({
  args: {
    json: v.string(),
    instruction: v.string(),
    locale: v.string(),
    fieldLabel: v.string(),
    context: v.optional(pageContextValidator),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (isLegacyTitleHtml(args.json))
      throw new ConvexError("RICH_TEXT_REQUIRES_EDITOR_ADOPTION")
    if (args.json.length > MAX_RICH_TEXT_CHARS)
      throw new ConvexError("Rich text too large.")
    if (args.instruction.length > MAX_INSTRUCTION_CHARS)
      throw new ConvexError("Instruction too long.")
    if (!args.instruction.trim()) {
      throw new ConvexError("Instruction is empty.")
    }
    const cfg = await gate(ctx)
    await gateAi(ctx)
    const modelId = resolveModelId(cfg)
    const language = languageName(args.locale)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "field-refine",
        modelId,
      },
      async () => {
        const usages: Array<AuditTokenUsage | undefined> = []
        // First call's generation metadata is representative — selection is
        // uniform across the fan-out (mirrors the localizer's accumulator).
        let generation: AuditGeneration | undefined
        const json = await refineRichTextSegments(
          args.json,
          async (segment) => {
            const result = await refineString(
              segment,
              args.instruction,
              cfg,
              language,
              args.fieldLabel,
              args.context
            )
            usages.push(result.usage)
            generation ??= result.generation
            return result.text
          }
        )
        return { value: json, usage: sumUsage(usages), generation }
      }
    )
  },
})

// ──────────────────────────────────────────────────────────────────────────────
// Public field-level generation actions
// ──────────────────────────────────────────────────────────────────────────────

/** Generate plain text for one field from a brief. Returns the raw string. */
export const generateField = action({
  args: {
    brief: v.string(),
    locale: v.string(),
    /** UX hint shown to the model (e.g. "title", "subtitle", "button label").
     *  Kept as a string — it doesn't need to be a closed union for the tracer. */
    fieldLabel: v.string(),
    /** Slice type for context; default "section" when called outside a slice. */
    sliceType: v.optional(v.string()),
    context: v.optional(pageContextValidator),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (args.brief.length > MAX_BRIEF_CHARS)
      throw new ConvexError("Brief too long.")
    if (!args.brief.trim()) {
      throw new ConvexError("Brief is empty.")
    }
    const cfg = await gate(ctx)
    await gateAi(ctx)
    const modelId = resolveModelId(cfg)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "field-generate",
        modelId,
      },
      async () => {
        const { text, usage, generation } = await generateOne(
          cfg,
          languageName(args.locale),
          args.sliceType ?? "section",
          args.brief,
          args.fieldLabel,
          "plain",
          args.context
        )
        return { value: text, usage, generation }
      }
    )
  },
})

// ──────────────────────────────────────────────────────────────────────────────
// Slice-level generation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate one slice from a brief. Assembles a same-type `Slice` with editorial
 * text from the model and structural fields left as the type's defaults — image
 * stays empty, button hrefs are empty, alignment/mode are the schema defaults.
 * The agent never touches links/images/ids/variants (ADR-013 mechanism 2).
 */
async function generateSliceInternal(
  cfg: ContentConfig,
  sliceType: InstalledSlice["type"],
  locale: string,
  brief: string,
  context: PageContext | undefined
): Promise<{
  slice: InstalledSlice
  usage?: AuditTokenUsage
  generation: AuditGeneration
}> {
  const language = languageName(locale)
  const generationInput = buildSliceGenerationInput({
    systemTemplate: cfg.systemPrompt,
    userTemplate: cfg.userPromptTemplate,
    language,
    sliceType,
    brief,
    context,
    brandVoice: cfg.brandVoice,
  })
  const result = await generateRuntimeText(
    cfg.modelId,
    {
      assistant: cfg.assistant,
      selectedProvider: cfg.selectedProvider,
      providerDefaults: cfg.providerDefaults,
      taskDefaults: cfg.taskDefaults,
      modelOverrides: cfg.modelOverrides,
      profile: "editorial-copy",
      phase: "content-generation",
      ...generationInput,
    },
    cfg.accounting
  )
  return {
    slice: assembleSlice(sliceType, result.text),
    usage: result.usage,
    generation: toAuditGeneration(result, "content-generation"),
  }
}

/** Public: generate one slice (editor's current locale) from a short brief.
 *  Returns a fully-formed `Slice` — text fields populated, structural fields
 *  at their registry defaults. The orchestration merges this onto the slice
 *  the editor added so the slice's `id` and any user-set structural choices
 *  (image, alignment) survive. */
export const generateSlice = action({
  args: {
    sliceType: v.string(),
    brief: v.string(),
    locale: v.string(),
    context: v.optional(pageContextValidator),
  },
  returns: installedSliceValidator,
  handler: async (ctx, args): Promise<InstalledSlice> => {
    if (args.brief.length > MAX_BRIEF_CHARS)
      throw new ConvexError("Brief too long.")
    if (!args.brief.trim()) {
      throw new ConvexError("Brief is empty.")
    }
    const sliceType = assertSliceType(args.sliceType)
    const cfg = await gate(ctx)
    await gateAi(ctx)
    const modelId = resolveModelId(cfg)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "slice-generate",
        modelId,
        sliceCount: 1,
      },
      async () => {
        const { slice, usage, generation } = await generateSliceInternal(
          cfg,
          sliceType,
          args.locale,
          args.brief,
          args.context
        )
        return { value: slice, usage, generation }
      }
    )
  },
})

/** Generate rich-text (paragraph-only PM-JSON) for one field from a brief. */
export const generateRichText = action({
  args: {
    brief: v.string(),
    locale: v.string(),
    fieldLabel: v.string(),
    profile: v.union(
      v.literal("inline"),
      v.literal("basic"),
      v.literal("full")
    ),
    contract: v.optional(
      v.union(
        v.literal("title"),
        v.literal("inline"),
        v.literal("basic"),
        v.literal("full")
      )
    ),
    headingRole: v.optional(
      v.union(v.literal("sliceTitle"), v.literal("itemTitle"))
    ),
    sliceType: v.optional(v.string()),
    context: v.optional(pageContextValidator),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (args.brief.length > MAX_BRIEF_CHARS)
      throw new ConvexError("Brief too long.")
    if (!args.brief.trim()) {
      throw new ConvexError("Brief is empty.")
    }
    const contract = args.contract ?? args.profile
    if (args.headingRole !== undefined && contract !== "title") {
      throw new ConvexError("headingRole is only valid for title contract")
    }
    const cfg = await gate(ctx)
    await gateAi(ctx)
    const modelId = resolveModelId(cfg)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "field-generate",
        modelId,
      },
      async () => {
        const { text, usage, generation } = await generateOne(
          cfg,
          languageName(args.locale),
          args.sliceType ?? "section",
          args.brief,
          args.fieldLabel,
          "richText",
          args.context,
          args.contract
        )
        return {
          value: JSON.stringify(
            buildFieldDoc(text, contract, args.headingRole, { emphasis: true })
          ),
          usage,
          generation,
        }
      }
    )
  },
})

// ──────────────────────────────────────────────────────────────────────────────
// Page-level meta generation (UC #3 from spec-ai-page-generation.md §7.3)
// ──────────────────────────────────────────────────────────────────────────────

function resolveModelId(cfg: ContentConfig): string {
  return resolveAuditModelId(cfg.modelId)
}

/**
 * Public: generate `metaTitle` + `metaDescription` for the current page from
 * the existing page copy (title + slice text already in `context`) plus the
 * configured brand voice. No editor brief — the page is its own brief.
 *
 * Writes one `aiAuditLog` row with `kind: "page-generate-meta"`, capturing
 * model id and token usage but never the page text or the generated output
 * (ADR-0015 retention/privacy contract). `sliceCount` is 0 because this
 * action does not produce slices.
 */
export const generatePageMeta = action({
  args: {
    locale: v.string(),
    context: pageContextValidator,
  },
  returns: v.object({
    metaTitle: v.string(),
    metaDescription: v.string(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ metaTitle: string; metaDescription: string }> => {
    const cfg = await gate(ctx)
    // Meta generation is a page-level operation (AI-12): charge the page-op
    // bucket like outline/translate-page do.
    await gateAi(ctx, { pageOp: true })
    const modelId = resolveModelId(cfg)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "page-generate-meta",
        modelId,
        sliceCount: 0,
      },
      async () => {
        const generationInput = buildPageMetaGenerationInput({
          systemTemplate: cfg.systemPrompt,
          language: languageName(args.locale),
          context: args.context,
          brandVoice: cfg.brandVoice,
        })
        const result = await generateRuntimeText(
          cfg.modelId,
          {
            assistant: cfg.assistant,
            selectedProvider: cfg.selectedProvider,
            providerDefaults: cfg.providerDefaults,
            taskDefaults: cfg.taskDefaults,
            modelOverrides: cfg.modelOverrides,
            profile: "structured-outline-meta",
            phase: "page-meta",
            ...generationInput,
          },
          cfg.accounting
        )
        return {
          value: assembleMeta(result.text),
          usage: result.usage,
          generation: toAuditGeneration(result, "page-meta"),
        }
      }
    )
  },
})

// ──────────────────────────────────────────────────────────────────────────────
// Page-level outline + fill (UC #1 from spec-ai-page-generation.md §4)
// ──────────────────────────────────────────────────────────────────────────────

/** sha256 hex of `input`, using the Web Crypto API (Convex actions run on
 *  a V8-style runtime — `node:crypto` is unavailable). 64 lowercase hex chars. */
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Convex validator for one outline row — closed union mirrors the installed profile. */
const outlineRowValidator = v.object({
  type: v.string(),
  purpose: v.string(),
})

const pageOutlineValidator = v.object({
  title: v.string(),
  slug: v.string(),
  metaTitle: v.string(),
  metaDescription: v.string(),
  outline: v.array(outlineRowValidator),
})

/**
 * Public: Stage A — turn a short brief into a structural plan (no editorial
 * text yet). One model call. Returns a validated outline the editor can review
 * before paying for the more expensive fill stage. Writes one
 * `aiAuditLog` row with `kind: "page-generate-outline"` and the brief sha256.
 */
export const generatePageOutline = action({
  args: {
    brief: v.string(),
    locale: v.string(),
  },
  returns: pageOutlineValidator,
  handler: async (ctx, args): Promise<PageOutline> => {
    if (args.brief.length > MAX_BRIEF_CHARS)
      throw new ConvexError("Brief too long.")
    if (!args.brief.trim()) {
      throw new ConvexError("Brief is empty.")
    }
    const cfg = await gate(ctx)
    await gateAi(ctx, { pageOp: true })
    const modelId = resolveModelId(cfg)
    const briefHash = await sha256Hex(args.brief)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "page-generate-outline",
        modelId,
        briefHash,
      },
      async () => {
        const generationInput = buildPageOutlineGenerationInput({
          systemTemplate: cfg.systemPrompt,
          userTemplate: cfg.userPromptTemplate,
          language: languageName(args.locale),
          brief: args.brief,
          brandVoice: cfg.brandVoice,
        })
        const result = await generateRuntimeText(
          cfg.modelId,
          {
            assistant: cfg.assistant,
            selectedProvider: cfg.selectedProvider,
            providerDefaults: cfg.providerDefaults,
            taskDefaults: cfg.taskDefaults,
            modelOverrides: cfg.modelOverrides,
            profile: "structured-outline-meta",
            phase: "page-outline",
            ...generationInput,
          },
          cfg.accounting
        )
        const outline = assembleOutline(result.text)
        return {
          value: outline,
          usage: result.usage,
          generation: toAuditGeneration(result, "page-outline"),
          sliceCount: outline.outline.length,
        }
      }
    )
  },
})

/**
 * Public: Stage B — generate one slice as part of a page-level fill. Reuses
 * `assembleSlice` so the trust boundary (ADR-013 mechanism 2) is identical to
 * slice-level Write; the difference is the *brief* sent to the model — it
 * carries the page-level brief, the outline row's purpose, and (via `context`)
 * the title + previously-filled siblings, so the call sees what the rest of
 * the page is becoming.
 *
 * Client-orchestrated: the editor calls this once per outline row, sequentially,
 * appending each result to `context.siblings` for the next call. Cancellation
 * is "stop calling" — no server-side marker needed.
 *
 * Writes one `aiAuditLog` row with `kind: "page-generate-fill"`. `briefHash`
 * is sha256 of `pageBrief|purpose` so two different outline rows from the
 * same brief hash differently (useful for forensic correlation).
 */
export const generatePageSlice = action({
  args: {
    sliceType: v.string(),
    pageBrief: v.string(),
    purpose: v.string(),
    locale: v.string(),
    context: v.optional(pageContextValidator),
  },
  returns: installedSliceValidator,
  handler: async (ctx, args): Promise<InstalledSlice> => {
    if (args.pageBrief.length > MAX_BRIEF_CHARS)
      throw new ConvexError("Brief too long.")
    if (args.purpose.length > 500) throw new ConvexError("Purpose too long.")
    if (!args.pageBrief.trim()) {
      throw new ConvexError("Brief is empty.")
    }
    if (!args.purpose.trim()) {
      throw new ConvexError("Slice purpose is empty.")
    }
    const sliceType = assertSliceType(args.sliceType)
    const cfg = await gate(ctx)
    await gateAi(ctx)
    const modelId = resolveModelId(cfg)
    const briefHash = await sha256Hex(`${args.pageBrief}|${args.purpose}`)

    let success = false
    let tokenUsage: {
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
    } = {}
    try {
      const result = await generatePageSliceCore(cfg, { ...args, sliceType })
      tokenUsage = {
        promptTokens: result.usage?.inputTokens,
        completionTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
      }
      const slice = assembleSlice(sliceType, result.text)
      success = true
      try {
        await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, {
          ...(cfg.accounting.anchorAttemptKey
            ? { attemptId: cfg.accounting.anchorAttemptKey }
            : {}),
          authId: cfg.authId,
          kind: "page-generate-fill",
          briefHash,
          sliceCount: 1,
          modelId,
          ...auditGenerationFields(toAuditGeneration(result, "page-fill")),
          tokenUsage,
          success: true,
        })
      } catch {
        // Audit is best effort and must never mask generated content.
      }
      return slice
    } catch (e) {
      if (!success) {
        try {
          await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, {
            ...(cfg.accounting.anchorAttemptKey
              ? { attemptId: cfg.accounting.anchorAttemptKey }
              : {}),
            authId: cfg.authId,
            kind: "page-generate-fill",
            briefHash,
            sliceCount: 0,
            modelId,
            tokenUsage,
            success: false,
            ...auditFailureFields(e),
          })
        } catch {
          // Preserve the original generation failure.
        }
      }
      throw e
    }
  },
})

/** Shared prompt + runner. Callers keep their existing assembly/audit ordering. */
export async function generatePageSliceCore(
  cfg: ContentConfig,
  args: {
    sliceType: string
    pageBrief: string
    purpose: string
    locale: string
    context?: PageContext
  }
) {
  const sliceType = assertSliceType(args.sliceType)
  const language = languageName(args.locale)
  const generationInput = buildPageFillGenerationInput({
    systemTemplate: cfg.systemPrompt,
    userTemplate: cfg.userPromptTemplate,
    language,
    sliceType,
    pageBrief: args.pageBrief,
    purpose: args.purpose,
    context: args.context,
    brandVoice: cfg.brandVoice,
  })
  const result = await generateRuntimeText(
    cfg.modelId,
    {
      assistant: cfg.assistant,
      selectedProvider: cfg.selectedProvider,
      providerDefaults: cfg.providerDefaults,
      taskDefaults: cfg.taskDefaults,
      modelOverrides: cfg.modelOverrides,
      profile: "editorial-copy",
      phase: "page-fill",
      ...generationInput,
    },
    cfg.accounting
  )
  return result
}
