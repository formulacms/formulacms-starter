// convex/cms/agents.ts
// Read/write the operator-editable AI agent configs. Defaults live in
// convex/lib/agents/registry.ts; the DB (`agentConfigs`) stores only overrides.
import { v, ConvexError } from "convex/values"
import { mutation, query } from "../_generated/server"
import { requireOwnerAndOptionalModule } from "../lib/modules/state"
import {
  AGENTS,
  requiredUserPlaceholders,
  type AgentId,
} from "../lib/agents/registry"
import {
  providerModelSelectionsValidator,
  taskProfileValidator,
} from "../lib/aiValidators"
import { assertTupleSelectable } from "../lib/aiCatalog"
import type { TaskProfile } from "../../lib/ai/execution-contract"

// block-author / block-renderer retired 2026-07-14 (ADR-0032 amendment):
// build-lane work is no longer a runtime agent. The literal union stays
// tighter than the schema table's own union so `updateAgent` refuses those
// keys even if a legacy client sends them; the schema keeps them so existing
// rows remain schema-valid. Fresh installs do not create those rows.
const agentLiteral = v.union(
  v.literal("translation"),
  v.literal("content"),
  v.literal("help-assistant")
)
const presetValidator = v.object({ label: v.string(), body: v.string() })

export const AGENT_TASK_PROFILES = {
  translation: ["mechanical-translation", "brand-translation"],
  content: ["editorial-copy", "structured-outline-meta"],
  "help-assistant": ["grounded-help"],
} as const satisfies Record<AgentId, readonly TaskProfile[]>

/** Normalize a list of presets coming from a form: trim each field, drop rows
 *  where the label is empty after trimming so the picker never shows blank
 *  entries. An empty body is allowed (a label-only entry just doesn't fill the
 *  dialog input on click). */
function normalizePresets(
  presets: Array<{ label: string; body: string }> | undefined
): Array<{ label: string; body: string }> | undefined {
  if (presets === undefined) return undefined
  return presets
    .map((p) => ({ label: p.label.trim(), body: p.body.trim() }))
    .filter((p) => p.label.length > 0)
}

/** Effective config for every registered agent: registry defaults merged with
 *  any stored override. `model: null` means "inherit the site default model".
 *  `isCustomized` flags whether any field has been overridden (for UI hints). */
export const listAgents = query({
  args: {},
  returns: v.array(
    v.object({
      id: agentLiteral,
      label: v.string(),
      description: v.string(),
      userPlaceholders: v.array(v.string()),
      defaultModel: v.union(v.string(), v.null()),
      model: v.union(v.string(), v.null()),
      modelOverrides: providerModelSelectionsValidator,
      profiles: v.array(taskProfileValidator),
      userPromptTemplate: v.string(),
      defaultUserPromptTemplate: v.string(),
      /** Placeholders the template MUST keep — dropping one silently breaks the
       *  agent, so `updateAgent` rejects a template that loses any of them. */
      requiredPlaceholders: v.array(v.string()),
      writeBriefs: v.array(presetValidator),
      refinePresets: v.array(presetValidator),
      defaultWriteBriefs: v.array(presetValidator),
      defaultRefinePresets: v.array(presetValidator),
      isCustomized: v.boolean(),
    })
  ),
  handler: async (ctx) => {
    // Community reads and writes agent config under the one operation-access
    // seam. The read/write split this comment used to describe was a Team
    // capability distinction; T01 reintroduces it through the access
    // interface, not through a role or permission array read here.
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const rows = await ctx.db.query("agentConfigs").collect()
    const byAgent = new Map(rows.map((r) => [r.agent, r]))

    return Object.values(AGENTS).map((def) => {
      const row = byAgent.get(def.id)
      const defaultWriteBriefs = def.defaultWriteBriefs ?? []
      const defaultRefinePresets = def.defaultRefinePresets ?? []
      return {
        id: def.id,
        label: def.label,
        description: def.description,
        userPlaceholders: def.userPlaceholders,
        defaultModel: def.defaultModel ?? null,
        model: row?.model ?? null,
        modelOverrides: row?.modelOverrides ?? {},
        profiles: [...AGENT_TASK_PROFILES[def.id]],
        userPromptTemplate:
          row?.userPromptTemplate ?? def.defaultUserPromptTemplate,
        defaultUserPromptTemplate: def.defaultUserPromptTemplate,
        requiredPlaceholders: requiredUserPlaceholders(def),
        writeBriefs: row?.writeBriefs ?? defaultWriteBriefs,
        refinePresets: row?.refinePresets ?? defaultRefinePresets,
        defaultWriteBriefs,
        defaultRefinePresets,
        isCustomized: Boolean(
          row &&
          (row.model !== undefined ||
            row.modelOverrides !== undefined ||
            row.userPromptTemplate !== undefined ||
            row.writeBriefs !== undefined ||
            row.refinePresets !== undefined)
        ),
      }
    })
  },
})

/** Public-ish: presets only, gated on the F01 operation seam. The editor's
 *  Write/Refine dialogs call this. Returns the effective presets (override
 *  or defaults) for one agent. */
export const getContentPresets = query({
  args: {},
  returns: v.object({
    writeBriefs: v.array(presetValidator),
    refinePresets: v.array(presetValidator),
    pageBriefs: v.array(presetValidator),
  }),
  handler: async (ctx) => {
    await requireOwnerAndOptionalModule(ctx, "ai")
    const def = AGENTS.content
    const row = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agent", (q) => q.eq("agent", "content"))
      .unique()
    return {
      writeBriefs: row?.writeBriefs ?? def.defaultWriteBriefs ?? [],
      refinePresets: row?.refinePresets ?? def.defaultRefinePresets ?? [],
      // Page-level seeds: registry-only until Phase 4 lands the operator
      // override column. No `row.pageBriefs` read yet.
      pageBriefs: def.defaultPageBriefs ?? [],
    }
  },
})

/** Upsert one agent's override row. An empty string for a prompt/model field
 *  clears the override (reverting to the registry/site default); `undefined`
 *  leaves the field unchanged. */
export const updateAgent = mutation({
  args: {
    agent: agentLiteral,
    // No `systemPrompt`: the system prompt is the output contract, not an
    // operator knob. It is unwritable by design — the registry default is the
    // only system prompt that ever runs.
    userPromptTemplate: v.optional(v.string()),
    /** Complete typed map. `{}` clears all typed overrides; omission leaves it
     * unchanged. This is saved atomically with prompt/preset edits. */
    modelOverrides: v.optional(providerModelSelectionsValidator),
    // For preset arrays: pass an array (possibly empty) to store an override,
    // omit the arg to leave the override unchanged. There's no "" sentinel for
    // arrays.
    writeBriefs: v.optional(v.array(presetValidator)),
    refinePresets: v.optional(v.array(presetValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    if (!(args.agent in AGENTS)) {
      throw new ConvexError(`Unknown agent: ${args.agent}`)
    }
    if (
      (args.writeBriefs !== undefined || args.refinePresets !== undefined) &&
      args.agent !== "content"
    ) {
      throw new ConvexError(
        "Presets are only configurable on the content agent"
      )
    }
    if (args.modelOverrides !== undefined) {
      for (const [provider, tuple] of Object.entries(args.modelOverrides)) {
        if (!tuple) continue
        if (tuple.provider !== provider) {
          throw new ConvexError(
            "INVALID_AI_SELECTION: Provider tuple mismatch."
          )
        }
        try {
          await assertTupleSelectable(
            ctx,
            tuple,
            AGENT_TASK_PROFILES[args.agent],
            Date.now()
          )
        } catch {
          throw new ConvexError(
            "INVALID_AI_SELECTION: The override does not support every workflow used by this agent."
          )
        }
      }
    }
    // The user template is the one prompt surface an operator can still edit, so
    // it is also the one that can still break an agent silently: `renderTemplate`
    // leaves unknown tokens intact, so a template that drops `{specJson}` hands
    // the model the literal token instead of the spec and the agent degrades with
    // no error. Reject that at the write, not at inference time. ("" is fine — it
    // clears the override and reverts to the default template.)
    if (args.userPromptTemplate !== undefined) {
      const tpl = args.userPromptTemplate.trim()
      if (tpl !== "") {
        const missing = requiredUserPlaceholders(
          AGENTS[args.agent as AgentId]
        ).filter((token) => !tpl.includes(token))
        if (missing.length > 0) {
          throw new ConvexError(
            `INVALID_AGENT_TEMPLATE: The user prompt template must keep ${missing.join(", ")}.`
          )
        }
      }
    }
    // "" ⇒ clear the override; otherwise store the provided value.
    const norm = (s: string | undefined) =>
      s === undefined ? undefined : s.trim() === "" ? undefined : s

    const existing = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agent", (q) => q.eq("agent", args.agent as AgentId))
      .unique()

    const fields = {
      ...(args.userPromptTemplate !== undefined && {
        userPromptTemplate: norm(args.userPromptTemplate),
      }),
      ...(args.modelOverrides !== undefined && {
        modelOverrides:
          Object.keys(args.modelOverrides).length > 0
            ? args.modelOverrides
            : undefined,
      }),
      ...(args.writeBriefs !== undefined && {
        writeBriefs: normalizePresets(args.writeBriefs),
      }),
      ...(args.refinePresets !== undefined && {
        refinePresets: normalizePresets(args.refinePresets),
      }),
      updatedAt: Date.now(),
    }

    if (existing) {
      await ctx.db.patch("agentConfigs", existing._id, fields)
    } else {
      await ctx.db.insert("agentConfigs", { agent: args.agent, ...fields })
    }
    return null
  },
})
