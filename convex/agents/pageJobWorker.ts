/** Identity-free workpool action: claim before any provider call. */
import { v } from "convex/values"
import type { FunctionReturnType } from "convex/server"
import { internalAction } from "../_generated/server"
import { internal } from "../_generated/api"
import { createRuntimeAccounting } from "../lib/ai"
import { generatePageSliceCore, type ContentConfig } from "./contentWriter"
import { createTranslationTraversal, type TranslationConfig } from "./localizer"
import { flattenSliceText } from "../lib/agents/pageContext"
import {
  assembleSlice,
  assertSliceType,
} from "../lib/agents/contentWriterContract"
import { readSlice } from "../lib/slices/identity"
import { Semaphore } from "../lib/semaphore"
import { translateSegment } from "../lib/agents/translationWorkflow"

export const runUnit = internalAction({
  args: { jobId: v.id("aiJobs"), unitId: v.id("aiJobUnits") },
  returns: v.null(),
  handler: async (ctx, { jobId, unitId }): Promise<null> => {
    const claim: FunctionReturnType<typeof internal.cms.aiJobs.claimUnit> =
      await ctx.runMutation(internal.cms.aiJobs.claimUnit, { jobId, unitId })
    if (!claim) return null
    const { job, unit, units, claimToken } = claim
    const accounting = createRuntimeAccounting(ctx, job.authId, {
      reservationKey: job.reservationKey!,
      runId: jobId,
      unitId,
    })
    const profile =
      job.kind === "write" ? "editorial-copy" : "brand-translation"
    const common = {
      accounting,
      assistant: {
        provider: job.tuple.provider,
        tuple: job.tuple.mode === "legacy" ? null : job.tuple,
        legacy: job.tuple.mode === "legacy",
        // Old jobs have no preamble and retain their existing contract.
        instructions: job.assistantInstructions ?? "",
      },
      authId: job.authId,
      modelId: job.tuple.model,
      selectedProvider:
        job.tuple.mode === "legacy" ? undefined : job.tuple.provider,
      providerDefaults: undefined,
      taskDefaults:
        job.tuple.mode === "legacy" ? undefined : { [profile]: job.tuple },
      modelOverrides: undefined,
      userPromptTemplate: job.userPromptTemplate!,
    }
    let output
    if (job.kind === "write") {
      const cfg: ContentConfig = {
        ...common,
        systemPrompt: job.systemPrompt!,
        brandVoice: job.brandVoice,
      }
      const generated = await generatePageSliceCore(cfg, {
        sliceType: unit.sliceType!,
        purpose: unit.purpose!,
        pageBrief: job.brief!,
        locale: job.locale,
        context: {
          pageTitle: job.title,
          siblings: units
            .filter((row) => row.index < unit.index && row.state === "saved")
            .map((row) => {
              if (!row.output || typeof row.output !== "object")
                throw new Error("Missing saved section.")
              return {
                type: readSlice(row.output).type,
                text: flattenSliceText(row.output),
              }
            }),
        },
      })
      output = assembleSlice(assertSliceType(unit.sliceType!), generated.text)
    } else {
      const cfg: TranslationConfig = {
        ...common,
        profile: "brand-translation",
        semaphore: new Semaphore(1),
        audit: { usages: [] },
      }
      output = await translateSegment(
        {
          index: unit.index,
          address: unit.address!,
          kind: unit.segmentKind!,
          text: unit.input!,
        },
        createTranslationTraversal(job.sourceLocale!, job.targetLocale!, cfg)
          .translateText
      )
    }
    await ctx.runMutation(internal.cms.aiJobs.saveUnit, {
      jobId,
      unitId,
      claimToken,
      output,
    })
    return null
  },
})
