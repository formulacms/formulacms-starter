/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")

async function seed(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [{ moduleId: "ai", configVersion: 1 }],
    })
    await ctx.db.insert("roles", {
      authId: "admin-1",
      role: "admin",
      assignedAt: 1,
    })
    await ctx.db.insert("roles", {
      authId: "editor-1",
      role: "editor",
      assignedAt: 1,
    })
    await ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: "admin-1",
      tokenIdentifier: "https://convex.test|admin-1",
      establishedAt: 1,
      updatedAt: 1,
    })
  })
}

function identity(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject, email: `${subject}@example.test` })
}

const translationOverride = {
  openai: {
    mode: "catalog",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning: { kind: "effort", effort: "high" },
  },
} as const

describe("typed agent model overrides", () => {
  test("writes require settings:update and round-trip a valid atomic override", async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    await expect(
      t.mutation(api.cms.agents.updateAgent, {
        agent: "translation",
        modelOverrides: translationOverride,
      })
    ).rejects.toThrow(/UNAUTHENTICATED/)
    await expect(
      identity(t, "editor-1").mutation(api.cms.agents.updateAgent, {
        agent: "translation",
        modelOverrides: translationOverride,
      })
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)

    await identity(t, "admin-1").mutation(api.cms.agents.updateAgent, {
      agent: "translation",
      modelOverrides: translationOverride,
      userPromptTemplate: "Translate faithfully:\n{text}",
    })
    const agents = await identity(t, "admin-1").query(
      api.cms.agents.listAgents,
      {}
    )
    const translation = agents.find((agent) => agent.id === "translation")!
    expect(translation.modelOverrides).toEqual(translationOverride)
    expect(translation.profiles).toEqual([
      "mechanical-translation",
      "brand-translation",
    ])
    expect(translation.userPromptTemplate).toBe("Translate faithfully:\n{text}")
  })

  test.skip("legacy Team role read-only settings behavior is re-homed to F04", async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    // Regression: reads used to require settings:update, so an editor — who has
    // settings:view and sees the nav entry — hit UNAUTHORIZED on every query and
    // the page never rendered anything usable.
    const agents = await identity(t, "editor-1").query(
      api.cms.agents.listAgents,
      {}
    )
    expect(agents.map((agent) => agent.id)).toContain("translation")

    const asEditor = await identity(t, "editor-1").query(
      api.cms.ai.getModelsSettings,
      {}
    )
    expect(asEditor.canEdit).toBe(false)

    const asAdmin = await identity(t, "admin-1").query(
      api.cms.ai.getModelsSettings,
      {}
    )
    expect(asAdmin.canEdit).toBe(true)
  })

  test("rejects an invalid multi-profile override without partial writes", async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    await expect(
      identity(t, "admin-1").mutation(api.cms.agents.updateAgent, {
        agent: "translation",
        userPromptTemplate: "Must not persist: {text}",
        modelOverrides: {
          openai: {
            mode: "catalog",
            provider: "openai",
            model: "gpt-5.6-luna",
            reasoning: { kind: "effort", effort: "low" },
          },
        },
      })
    ).rejects.toThrow(/INVALID_AI_SELECTION/)
    expect(
      await t.run((ctx) => ctx.db.query("agentConfigs").first())
    ).toBeNull()
  })

  test("rejects a user template that drops a required placeholder", async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    // `renderTemplate` leaves unknown tokens intact, so a translation template
    // without {text} hands the model no input at all — and nothing downstream
    // errors. The write is the only place this can be caught.
    await expect(
      identity(t, "admin-1").mutation(api.cms.agents.updateAgent, {
        agent: "translation",
        userPromptTemplate: "Translate this nicely.",
      })
    ).rejects.toThrow(/INVALID_AGENT_TEMPLATE[\s\S]*\{text\}/)
    expect(
      await t.run((ctx) => ctx.db.query("agentConfigs").first())
    ).toBeNull()

    // "" is not a broken template — it clears the override back to the default.
    await identity(t, "admin-1").mutation(api.cms.agents.updateAgent, {
      agent: "translation",
      userPromptTemplate: "",
    })
    const row = await t.run((ctx) => ctx.db.query("agentConfigs").first())
    expect(row?.userPromptTemplate).toBeUndefined()
  })

  test("clears typed overrides with an empty map while preserving the template", async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const admin = identity(t, "admin-1")
    await admin.mutation(api.cms.agents.updateAgent, {
      agent: "translation",
      modelOverrides: translationOverride,
      userPromptTemplate: "Keep me: {text}",
    })
    await admin.mutation(api.cms.agents.updateAgent, {
      agent: "translation",
      modelOverrides: {},
    })
    const row = await t.run((ctx) => ctx.db.query("agentConfigs").first())
    expect(row?.modelOverrides).toBeUndefined()
    expect(row?.userPromptTemplate).toBe("Keep me: {text}")
  })

  test("a stale stored systemPrompt is inert and never leaves the server", async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    // The column still exists (a Convex validator cannot drop a field that has
    // rows), but nothing reads it: the runtime always uses the registry default,
    // and listAgents no longer ships prompt text to the browser at all.
    await t.run(async (ctx) => {
      await ctx.db.insert("agentConfigs", {
        agent: "translation",
        systemPrompt: "an override that would silently corrupt translations",
        updatedAt: 1,
      })
    })
    const agents = await identity(t, "admin-1").query(
      api.cms.agents.listAgents,
      {}
    )
    const translation = agents.find((agent) => agent.id === "translation")!
    expect(translation).not.toHaveProperty("systemPrompt")
    expect(translation).not.toHaveProperty("defaultSystemPrompt")
    // A value the runtime ignores must not make the agent look customized.
    expect(translation.isCustomized).toBe(false)
  })
})
