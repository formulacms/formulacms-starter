// convex/cms/agents.ts
// Read/write the operator-editable AI agent configs. Defaults live in
// convex/lib/agents/registry.ts; the DB (`agentConfigs`) stores only overrides.
import { v, ConvexError } from "convex/values"
import { internalMutation, mutation, query } from "../_generated/server"
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
import { validateTupleForProfiles } from "../../lib/ai/task-profiles"
import type { TaskProfile } from "../../lib/ai/execution-contract"

// slice-author / slice-renderer retired 2026-07-14 (ADR-0032 amendment):
// build-lane work is no longer a runtime agent. The literal union stays
// tighter than the schema table's own union so `updateAgent` refuses those
// keys even if a legacy client sends them; the schema keeps them so existing
// rows remain schema-valid until `clearRetiredSliceAgents` sweeps them.
const agentLiteral = v.union(
  v.literal("translation"),
  v.literal("content"),
  v.literal("help-assistant")
)
const RETIRED_AGENT_IDS = ["slice-author", "slice-renderer"] as const
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
      // No `systemPlaceholders`: they only ever labelled the system-prompt
      // editor, which no longer exists.
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
        // A stale `row.systemPrompt` deliberately does NOT count: the runtime no
        // longer reads it, so flagging the agent "customized" over a value that
        // has no effect would be a lie.
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
    // arrays — to revert to defaults, use `resetAgentPresets`.
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
          validateTupleForProfiles(tuple, AGENT_TASK_PROFILES[args.agent])
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
      await ctx.db.patch(existing._id, fields)
    } else {
      await ctx.db.insert("agentConfigs", { agent: args.agent, ...fields })
    }
    return null
  },
})

/** One-shot cleanup for the two retired build-lane slice agents
 *  (`slice-author`, `slice-renderer`) — the runtime no longer routes to them,
 *  `listAgents` no longer surfaces them, and `updateAgent` refuses to write
 *  them. Any surviving `agentConfigs` row for those ids is dead data. Run once
 *  per deployment: `npx convex run cms/agents:clearRetiredSliceAgents`. Keep
 *  the schema union entries for both ids until this has run everywhere;
 *  removing a literal from a defineTable union while rows still carry it is a
 *  schema-validation break. */
export const clearRetiredSliceAgents = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("agentConfigs").collect()
    const toDelete = rows.filter((row) =>
      (RETIRED_AGENT_IDS as readonly string[]).includes(row.agent)
    )
    await Promise.all(toDelete.map((row) => ctx.db.delete(row._id)))
    return toDelete.length
  },
})

/** One-shot cleanup for the retired system-prompt override (see `updateAgent`).
 *  The runtime already ignores `agentConfigs.systemPrompt`, so any stored value
 *  is dead data — this drops it so the column can eventually leave the schema.
 *  Run once per deployment: `npx convex run cms/agents:clearStoredSystemPrompts`.
 *  Uses `replace` because `patch` can set a field but not remove it. */
export const clearStoredSystemPrompts = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("agentConfigs").collect()
    const toClear = rows.filter((row) => row.systemPrompt !== undefined)
    await Promise.all(
      toClear.map((row) => {
        const { _id, _creationTime, ...rest } = row
        void _creationTime
        const replacement: typeof rest = { ...rest }
        delete replacement.systemPrompt
        return ctx.db.replace(_id, replacement)
      })
    )
    return toClear.length
  },
})

/** Revert one preset list (or both) on the content agent to registry defaults.
 *  Uses `replace` so we can drop a field — `patch` can only set, not clear. */
export const resetAgentPresets = mutation({
  args: {
    agent: agentLiteral,
    writeBriefs: v.optional(v.boolean()),
    refinePresets: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    if (args.agent !== "content") {
      throw new ConvexError(
        "Presets are only configurable on the content agent"
      )
    }
    const existing = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agent", (q) => q.eq("agent", args.agent as AgentId))
      .unique()
    if (!existing) return null
    const { _id, _creationTime, ...rest } = existing
    void _creationTime
    const replacement: typeof rest = { ...rest, updatedAt: Date.now() }
    if (args.writeBriefs) delete replacement.writeBriefs
    if (args.refinePresets) delete replacement.refinePresets
    await ctx.db.replace(_id, replacement)
    return null
  },
})
