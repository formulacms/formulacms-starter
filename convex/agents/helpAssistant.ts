// convex/agents/helpAssistant.ts
// Read-only help assistant (Phase 1 of the in-app agentic command bar).
//
// Sibling of convex/agents/localizer.ts and contentWriter.ts. Where those
// *change* content, the help assistant only *explains*: it answers an editor's
// "how do I…" question, grounded ONLY on a small curated corpus
// (convex/lib/help/corpus.ts) plus the live slice catalog. There is no vector
// store, no conversation memory, and no write path to content.
//
// Trust shape:
//   - Output is a short text answer + a best-effort list of source titles. The
//     model is told to answer from the injected context only and to admit
//     uncertainty rather than invent features.
//   - `sources` is computed deterministically (keyword overlap with the corpus),
//     not by the model, so it can't fabricate a citation.
//   - Gated on the F01 operation seam. One aiAuditLog row per
//     call records model + token usage, never the question text or the answer
//     (ADR-0015 privacy contract).
import { v, ConvexError } from "convex/values"
import { action, internalQuery } from "../_generated/server"
import type { ActionCtx } from "../_generated/server"
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
import { AGENTS } from "../lib/agents/registry"
import {
  buildHelpGenerationInput,
  parseHelpGenerationOutput,
} from "../lib/help/workflow"
import {
  auditFailureFields,
  auditGenerationFields,
  resolveAuditModelId,
  toAuditGeneration,
} from "./auditedGenerate"

/** Resolved help-agent config for one run: model + editable prompt templates +
 *  the caller's Better Auth `_id` (threaded through so the action can attribute
 *  an aiAuditLog row without a second auth round-trip). */
interface HelpConfig {
  assistant?: RuntimeAssistant
  accounting: GenerationAccounting
  modelId: string | undefined
  selectedProvider: RuntimeSelectedProvider | undefined
  providerDefaults: ProviderModelSelections | undefined
  taskDefaults: TaskDefaults | undefined
  modelOverrides: ProviderModelSelections | undefined
  systemPrompt: string
  userPromptTemplate: string
  authId: string
}

/** Hard cap on the question so a runaway client can't blow the prompt budget. */
const MAX_QUESTION_CHARS = 2_000

/** Hard cap on the admin route sent with a question (the removed server action
 *  enforced the same cap). */
const MAX_ROUTE_CHARS = 500

/**
 * Gate + config resolver, run as a transaction before the model call. Throws
 * UNAUTHORIZED if the caller lacks `content:ai`; returns the operator's
 * configured model + editable prompt templates (registry defaults when
 * unset). Model resolution mirrors the other agents:
 * agentConfig.model → siteSettings.aiDefaultModel → null (the action falls
 * back to env/built-in default).
 */
export const prepareHelp = internalQuery({
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
    authId: v.string(),
  }),
  handler: async (ctx) => {
    const auth = await requireOwnerAndOptionalModule(ctx, "ai")
    const settings = await ctx.db.query("siteSettings").first()
    const agentConfig = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agent", (q) => q.eq("agent", "help-assistant"))
      .unique()
    const def = AGENTS["help-assistant"]
    return {
      assistant: await resolveRuntimeAssistant(
        ctx,
        "grounded-help",
        "help-answer"
      ),
      modelId: agentConfig?.model ?? settings?.aiDefaultModel ?? null,
      selectedProvider: settings?.aiRuntime?.selectedProvider ?? null,
      providerDefaults: settings?.aiRuntime?.providerDefaults ?? null,
      taskDefaults: settings?.aiRuntime?.taskDefaults ?? null,
      modelOverrides: agentConfig?.modelOverrides ?? null,
      // Registry default only — the system prompt is unwritable by design.
      systemPrompt: def.defaultSystemPrompt,
      userPromptTemplate:
        agentConfig?.userPromptTemplate ?? def.defaultUserPromptTemplate,
      authId: auth.authId,
    }
  },
})

/** Run the F01 operation gate + config resolution for this run. */
async function gate(ctx: ActionCtx): Promise<HelpConfig> {
  const {
    assistant,
    modelId,
    selectedProvider,
    providerDefaults,
    taskDefaults,
    modelOverrides,
    systemPrompt,
    userPromptTemplate,
    authId,
  } = await ctx.runQuery(internal.agents.helpAssistant.prepareHelp, {})
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
    authId,
  }
}

/**
 * Public: answer one editor "how do I…" question, grounded on the help corpus +
 * the live slice catalog. Explains only — no content is written. `route` is the
 * admin screen the editor is on, used for situational phrasing.
 *
 * Writes one `aiAuditLog` row with `kind: "help-answer"` (model + token usage
 * only, never the question or the answer). `sliceCount` is 0: this action does
 * not produce slices. A failed model call still logs `success:false` then
 * rethrows.
 */
export const answer = action({
  args: {
    question: v.string(),
    route: v.optional(v.string()),
  },
  returns: v.object({
    answer: v.string(),
    sources: v.array(v.string()),
    suggestedAction: v.optional(
      v.object({
        id: v.string(),
        label: v.string(),
        href: v.string(),
      })
    ),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    answer: string
    sources: string[]
    suggestedAction?: { id: string; label: string; href: string }
  }> => {
    if (args.question.length > MAX_QUESTION_CHARS) {
      throw new ConvexError("Question too long.")
    }
    if (args.route !== undefined && args.route.length > MAX_ROUTE_CHARS) {
      throw new ConvexError("Route too long.")
    }
    if (!args.question.trim()) {
      throw new ConvexError("Question is empty.")
    }
    // F01 operation gate before the rate charge (AI-04): an unauthorized caller
    // must not consume a rate-limit token.
    const cfg = await gate(ctx)
    await enforceAiRateLimit(ctx)

    const { system, prompt, sources } = buildHelpGenerationInput({
      question: args.question,
      route: args.route,
      systemPrompt: cfg.systemPrompt,
      userPromptTemplate: cfg.userPromptTemplate,
    })

    // The actual model id for the audit row: mirror getAIModel's fallback so a
    // null config logs the built-in default, not an empty string.
    const resolvedModelId = resolveAuditModelId(cfg.modelId)
    let result: Awaited<ReturnType<typeof generateRuntimeText>> | undefined
    let invalidOutput = false
    let tokenUsage: {
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
    } = {}
    try {
      // `generateBoundedText` takes the model id as a separate first arg and
      // forwards it to getAIModel, which treats a falsy id as env/default — so
      // an unconfigured model passes "" and falls through cleanly.
      result = await generateRuntimeText(
        cfg.modelId ?? "",
        {
          assistant: cfg.assistant,
          selectedProvider: cfg.selectedProvider,
          providerDefaults: cfg.providerDefaults,
          taskDefaults: cfg.taskDefaults,
          modelOverrides: cfg.modelOverrides,
          profile: "grounded-help",
          phase: "help-answer",
          system,
          prompt,
        },
        cfg.accounting
      )
      // AI SDK v6 names (inputTokens/outputTokens); the audit schema uses the
      // older promptTokens/completionTokens labels — map at the boundary.
      tokenUsage = {
        promptTokens: result.usage?.inputTokens,
        completionTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
      }
      // Parse and bound the workflow output before recording success. Invalid
      // prose is a failed generation, even when the provider returned 200.
      let parsed: ReturnType<typeof parseHelpGenerationOutput>
      try {
        parsed = parseHelpGenerationOutput(result.text)
      } catch (error) {
        invalidOutput = true
        throw error
      }
      try {
        await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, {
          ...(cfg.accounting.anchorAttemptKey
            ? { attemptId: cfg.accounting.anchorAttemptKey }
            : {}),
          authId: cfg.authId,
          kind: "help-answer",
          sliceCount: 0,
          modelId: resolvedModelId,
          ...auditGenerationFields(toAuditGeneration(result, "help-answer")),
          tokenUsage,
          success: true,
        })
      } catch {
        // Audit is best effort and must never mask a successful answer.
      }
      return {
        answer: parsed.answer,
        sources,
        ...(parsed.suggestedAction
          ? { suggestedAction: parsed.suggestedAction }
          : {}),
      }
    } catch (e) {
      const failureFields =
        invalidOutput && result
          ? {
              ...auditGenerationFields(
                toAuditGeneration(result, "help-answer")
              ),
              errorCode: "INVALID_OUTPUT",
            }
          : auditFailureFields(e)
      try {
        await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, {
          ...(cfg.accounting.anchorAttemptKey
            ? { attemptId: cfg.accounting.anchorAttemptKey }
            : {}),
          authId: cfg.authId,
          kind: "help-answer",
          sliceCount: 0,
          modelId: resolvedModelId,
          tokenUsage,
          success: false,
          ...failureFields,
        })
      } catch {
        // Preserve the original generation or validation failure.
      }
      throw e
    }
  },
})
