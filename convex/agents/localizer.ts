import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
import { assertTranslationInput } from "../lib/agents/translationWorkflow"

import { isLegacyTitleHtml, writeBlockFields } from "../lib/richtext/write"
// convex/agents/localizer.ts
// AI-powered localization (ADR-002: translation is the killer demo).
//
// Plain-text fields (titles, button labels) go through `translateField`.
// Rich-text fields are PM-JSON strings (ADR-0009): we walk the tree and
// translate only the text nodes, so marks and structure survive (pmText.ts).
// `localizePage` translates a whole page's title + blocks in one gated call.
// All public entry points require the F01 operation seam and honor
// siteSettings.aiDefaultModel.
import { v, ConvexError } from "convex/values"
import { action, internalQuery } from "../_generated/server"
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server"
import { internal } from "../_generated/api"
import {
  catalogModelEntryValidator,
  loadRuntimeCatalogEntries,
} from "../lib/aiCatalog"
import { catalogFromEntries, type ModelCatalog } from "../../lib/ai/model-catalog"
import { ASSISTANT_PROFILES } from "../../lib/ai/task-profiles"
import {
  generateRuntimeText,
  createRuntimeAccounting,
  resolveRuntimeAssistant,
  type RuntimeAssistant,
  requireAiTranslationModule,
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
import { blockValidator, type Block } from "../lib/blocks"
import {
  translatePageContent,
  translatePlainText,
  translateRichText as translateRichTextContent,
  type TranslationTraversal,
} from "../lib/agents/translationWorkflow"
import {
  AGENTS,
  buildTranslationSystemPrompt,
  renderTemplate,
} from "../lib/agents/registry"
import {
  resolveAuditModelId,
  sumUsage,
  toAuditGeneration,
  withAiAudit,
  type AuditGeneration,
  type AuditTokenUsage,
} from "./auditedGenerate"

// Shared home is convex/lib/semaphore.ts; re-exported here so existing
// imports and tests keep working.
export { MAX_CONCURRENT_LLM_CALLS, Semaphore } from "../lib/semaphore"
import { MAX_CONCURRENT_LLM_CALLS, Semaphore } from "../lib/semaphore"

/** Resolved translation-agent config for a run: model + editable prompt
 *  templates. Built in `gate()` from the operator's `agentConfigs` overrides
 *  (or registry defaults) and threaded through every translate helper. */
export interface TranslationConfig {
  assistant?: RuntimeAssistant
  accounting: GenerationAccounting
  modelId: string | undefined
  selectedProvider: RuntimeSelectedProvider | undefined
  providerDefaults: ProviderModelSelections | undefined
  taskDefaults: TaskDefaults | undefined
  modelOverrides: ProviderModelSelections | undefined
  /** Shared catalog entries for every candidate tuple (prepare query). */
  catalog: ModelCatalog
  /** User-message template; {text} ⇒ the content being translated. */
  userPromptTemplate: string
  semaphore: Semaphore
  profile: "mechanical-translation" | "brand-translation"
  /** Convex Auth user id of the caller, threaded through so the action can
   *  attribute an aiAuditLog row without a second auth round-trip. */
  authId: string
  /** Per-run audit accumulator: every model call pushes its usage here; the
   *  first call records representative generation metadata (selection is
   *  uniform across a fan-out). The owning action sums it into one row. */
  audit: {
    usages: Array<AuditTokenUsage | undefined>
    generation?: AuditGeneration
  }
}

function resolveModelId(cfg: TranslationConfig): string {
  return resolveAuditModelId(cfg.modelId)
}

const MAX_TRANSLATE_TEXT_CHARS = 5_000
const MAX_TRANSLATE_RICH_CHARS = 200_000

export function createTranslationTraversal(
  sourceLocale: string,
  targetLocale: string,
  cfg: TranslationConfig,
  fieldType?: string
): TranslationTraversal {
  return {
    enabled: sourceLocale !== targetLocale,
    validateText: (text) => {
      if (text.length > MAX_TRANSLATE_TEXT_CHARS) {
        throw new ConvexError("Text too long.")
      }
    },
    validateRichText: (json) => {
      if (json.length > MAX_TRANSLATE_RICH_CHARS) {
        throw new ConvexError("Rich text too large.")
      }
    },
    translateText: async (text) => {
      await cfg.semaphore.acquire()
      try {
        const result = await generateRuntimeText(
          cfg.modelId,
          {
            assistant: cfg.assistant,
            selectedProvider: cfg.selectedProvider,
            providerDefaults: cfg.providerDefaults,
            taskDefaults: cfg.taskDefaults,
            modelOverrides: cfg.modelOverrides,
            catalog: cfg.catalog,
            profile: cfg.profile,
            phase: "translation",
            instructions: buildTranslationSystemPrompt(
              sourceLocale,
              targetLocale,
              fieldType === "slug"
            ),
            prompt: renderTemplate(cfg.userPromptTemplate, { text }),
          },
          cfg.accounting
        )
        cfg.audit.usages.push(result.usage)
        cfg.audit.generation ??= toAuditGeneration(result, "translation")
        return result.text
      } finally {
        cfg.semaphore.release()
      }
    },
  }
}

/** Translate one plain string. Empty/whitespace and no-op locales pass through. */
async function translateString(
  text: string,
  sourceLocale: string,
  targetLocale: string,
  cfg: TranslationConfig,
  fieldType?: string
): Promise<string> {
  return translatePlainText(
    text,
    createTranslationTraversal(sourceLocale, targetLocale, cfg, fieldType)
  )
}

async function translateRichTextValue(
  json: string,
  sourceLocale: string,
  targetLocale: string,
  cfg: TranslationConfig
): Promise<string> {
  return translateRichTextContent(
    json,
    createTranslationTraversal(sourceLocale, targetLocale, cfg)
  )
}

/**
 * Gate + config resolver, run as a transaction before any model call. Throws
 * UNAUTHORIZED if the caller lacks `translation:ai`; returns the operator's
 * configured model + editable prompt templates. Model resolution:
 * agentConfig.model → siteSettings.aiDefaultModel → null (action falls back to
 * env/default). Prompts fall back to the registry defaults.
 */
export const prepareTranslation = internalQuery({
  args: {},
  returns: v.object({
    assistant: runtimeAssistantValidator,
    modelId: v.union(v.string(), v.null()),
    selectedProvider: v.union(runtimeSelectedProviderValidator, v.null()),
    providerDefaults: v.union(providerModelSelectionsValidator, v.null()),
    taskDefaults: v.union(taskDefaultsValidator, v.null()),
    modelOverrides: v.union(providerModelSelectionsValidator, v.null()),
    catalog: v.array(catalogModelEntryValidator),
    userPromptTemplate: v.string(),
    authId: v.string(),
  }),
  handler: async (ctx) => {
    const auth = await requireOwnerAndOptionalModule(ctx, "ai")
    await requireAiTranslationModule(ctx)
    return readTranslationConfig(ctx, auth.authId)
  },
})

/** Identity-free config read; callers own the owner/job gate. */
export async function readTranslationConfig(
  ctx: QueryCtx | MutationCtx,
  authId: string
) {
  const settings = await ctx.db.query("siteSettings").first()
  const agentConfig = await ctx.db
    .query("agentConfigs")
    .withIndex("by_agent", (q) => q.eq("agent", "translation"))
    .unique()
  const def = AGENTS.translation
  const assistant = await resolveRuntimeAssistant(
    ctx,
    "mechanical-translation",
    "translation"
  )
  const catalog = await loadRuntimeCatalogEntries(ctx, {
    providers: [assistant.provider],
    profiles: ASSISTANT_PROFILES.translation,
    tuples: [assistant.tuple],
    providerDefaults: settings?.aiRuntime?.providerDefaults,
    taskDefaults: settings?.aiRuntime?.taskDefaults,
    modelOverrides: agentConfig?.modelOverrides,
  })
  return {
    assistant,
    modelId: agentConfig?.model ?? settings?.aiDefaultModel ?? null,
    selectedProvider: settings?.aiRuntime?.selectedProvider ?? null,
    providerDefaults: settings?.aiRuntime?.providerDefaults ?? null,
    taskDefaults: settings?.aiRuntime?.taskDefaults ?? null,
    modelOverrides: agentConfig?.modelOverrides ?? null,
    catalog,
    // The system prompt is the output contract, not an operator knob: only
    // the registry default runs, built in code by
    // `buildTranslationSystemPrompt`. Translation had no output parser at all,
    // so a bad override corrupted translations silently — that is the hole
    // this closes.
    userPromptTemplate:
      agentConfig?.userPromptTemplate ?? def.defaultUserPromptTemplate,
    authId,
  }
}

/** Run the F01 operation gate + config resolution; returns the resolved
 *  translation config (model + prompt templates) for this run. */
async function gate(
  ctx: ActionCtx,
  profile: TranslationConfig["profile"]
): Promise<TranslationConfig> {
  const {
    assistant,
    modelId,
    selectedProvider,
    providerDefaults,
    taskDefaults,
    modelOverrides,
    catalog,
    userPromptTemplate,
    authId,
  } = await ctx.runQuery(internal.agents.localizer.prepareTranslation, {})
  return {
    assistant,
    accounting: createRuntimeAccounting(ctx, authId),
    modelId: modelId ?? undefined,
    selectedProvider: selectedProvider ?? undefined,
    providerDefaults: providerDefaults ?? undefined,
    taskDefaults: taskDefaults ?? undefined,
    modelOverrides: modelOverrides ?? undefined,
    catalog: catalogFromEntries(catalog),
    userPromptTemplate,
    semaphore: new Semaphore(MAX_CONCURRENT_LLM_CALLS),
    profile,
    authId,
    audit: { usages: [] },
  }
}

/** Public: translate one plain-text field. */
export const translateField = action({
  args: {
    text: v.string(),
    sourceLocale: v.string(),
    targetLocale: v.string(),
    fieldType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (args.text.length > MAX_TRANSLATE_TEXT_CHARS)
      throw new ConvexError("Text too long.")
    const cfg = await gate(ctx, "mechanical-translation")
    await enforceAiRateLimit(ctx)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "field-translate",
        modelId: resolveModelId(cfg),
      },
      async () => {
        const text = await translateString(
          args.text,
          args.sourceLocale,
          args.targetLocale,
          cfg,
          args.fieldType
        )
        return {
          value: text,
          usage: sumUsage(cfg.audit.usages),
          generation: cfg.audit.generation,
        }
      }
    )
  },
})

/** Public: translate one rich-text (PM-JSON) field. */
export const translateRichText = action({
  args: {
    json: v.string(),
    sourceLocale: v.string(),
    targetLocale: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (args.sourceLocale !== args.targetLocale && isLegacyTitleHtml(args.json))
      throw new ConvexError("RICH_TEXT_REQUIRES_EDITOR_ADOPTION")
    if (args.json.length > MAX_TRANSLATE_RICH_CHARS)
      throw new ConvexError("Rich text too large.")
    const cfg = await gate(ctx, "mechanical-translation")
    await enforceAiRateLimit(ctx)
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "field-translate",
        modelId: resolveModelId(cfg),
      },
      async () => {
        const json = await translateRichTextValue(
          args.json,
          args.sourceLocale,
          args.targetLocale,
          cfg
        )
        return {
          value: json,
          usage: sumUsage(cfg.audit.usages),
          generation: cfg.audit.generation,
        }
      }
    )
  },
})

/**
 * Descriptor-field translatable leaf (plan 029 C9a). Kept intentionally
 * descriptor-agnostic — the action doesn't know which content type it's
 * translating; it just translates each leaf by `kind` and returns them
 * indexed by `path` so the client reapplies them into its
 * `localizedFieldValues` bag via `setValueAtFieldPath`. Avoids having to
 * union-encode every descriptor's localized shape at the action boundary.
 *
 * The plan calls out "never translate shared identity fields" (`author.name`,
 * post `authorId`, etc.) — the client-side collector filters to
 * `SYSTEM_OWNED_LOCALIZED_FIELDS`-excluded, text/richText leaves of
 * `descriptor.localizedFields` only, so shared identity fields cannot enter
 * this transport by construction.
 */
const translatableLeafValidator = v.object({
  path: v.string(),
  kind: v.union(v.literal("text"), v.literal("richText")),
  value: v.string(),
})

/** Public: translate a whole page (title + all blocks + descriptor
 *  localized text/richText fields) in one gated call — the AI-translate
 *  path behind the page editor's locale "Translate" menu. */
export const localizePage = action({
  args: {
    title: v.string(),
    metaTitle: v.optional(v.string()),
    metaDescription: v.optional(v.string()),
    blocks: v.array(blockValidator),
    sourceLocale: v.string(),
    targetLocale: v.string(),
    /** Plan 029 C9a — descriptor localized text/richText leaves the client
     *  extracted from the source locale's `localizedFieldValues`. Optional
     *  for back-compat and for pages whose type has no translatable
     *  descriptor fields. */
    translatables: v.optional(v.array(translatableLeafValidator)),
  },
  returns: v.object({
    title: v.string(),
    metaTitle: v.optional(v.string()),
    metaDescription: v.optional(v.string()),
    blocks: v.array(blockValidator),
    translatables: v.array(translatableLeafValidator),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    title: string
    metaTitle?: string
    metaDescription?: string
    blocks: Block[]
    translatables: { path: string; kind: "text" | "richText"; value: string }[]
  }> => {
    for (const block of args.sourceLocale === args.targetLocale
      ? []
      : args.blocks) {
      writeBlockFields(block)
      const definition = readBlockDefinition(readBlock(block).type)
      if (!definition) throw new Error("Block descriptor is unavailable.")
      assertTranslationInput(definition.primary, readBlock(block).primary, {
        blockType: readBlock(block).type,
        fieldPath: "primary",
      })
      if (definition.items !== undefined && "items" in block)
        assertTranslationInput(definition.items, readBlock(block).items, {
          blockType: readBlock(block).type,
          fieldPath: "items",
        })
    }
    const cfg = await gate(ctx, "brand-translation")
    await enforceAiRateLimit(ctx, { pageOp: true })
    const translatables = args.translatables ?? []
    return withAiAudit(
      ctx,
      {
        accounting: cfg.accounting,
        authId: cfg.authId,
        kind: "page-translate",
        modelId: resolveModelId(cfg),
      },
      async () => {
        const translated = await translatePageContent(
          {
            title: args.title,
            ...(args.metaTitle !== undefined
              ? { metaTitle: args.metaTitle }
              : {}),
            ...(args.metaDescription !== undefined
              ? { metaDescription: args.metaDescription }
              : {}),
            blocks: args.blocks,
            translatables,
          },
          createTranslationTraversal(args.sourceLocale, args.targetLocale, cfg)
        )
        return {
          value: translated,
          usage: sumUsage(cfg.audit.usages),
          generation: cfg.audit.generation,
        }
      }
    )
  },
})
