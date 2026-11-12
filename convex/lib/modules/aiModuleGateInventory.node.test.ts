/// <reference types="vite/client" />
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"

// Exact reviewed inventory; behavioral module-off coverage lives in the
// authorization matrix. This seam catches additions, not arbitrary auth bugs.
// Generated apps may omit source-only modules.
const groups = {
  G: {
    "agents/contentWriter": [
      "refineField",
      "refineRichText",
      "generateField",
      "generateSlice",
      "generateRichText",
      "generatePageMeta",
      "generatePageOutline",
      "generatePageSlice",
    ],
    "agents/localizer": ["translateField", "translateRichText", "localizePage"],
    "agents/helpAssistant": ["answer"],
    "cms/agents": ["getContentPresets"],
    "cms/aiJobs": [
      "estimatePageJob",
      "startPageJob",
      "cancelPageJob",
      "resumePageJob",
      "dismissPageJob",
      "pageJobProgress",
      "pageJobResult",
      "acceptPageJob",
    ],
  },
  S: {
    "cms/ai": ["isConfigured", "getModelsSettings"],
    "cms/aiSettings": [
      "setProductionAiConfiguration",
      "setMonthlyAiCap",
      "status",
      "setAssistant",
      "sliceCreator",
      "setSliceCreator",
    ],
    "cms/aiConnections": ["validateProductionConnection"],
    "cms/agents": ["listAgents", "updateAgent", "resetAgentPresets"],
  },
  L: {
    "cms/ai": ["admitLocalAttempt"],
    "agents/localGeneration": ["preflight"],
  },
  X: {
    "cms/aiAuditLog": ["deleteAuditLogForUser"],
    "cms/ai": ["settleLocalAttempt"],
    "agents/localGeneration": ["recordAudit"],
    "agents/sliceAuthor": ["canAuthorSlices"],
  },
} as const

// Same registration metadata seam as publicAuthorizationMatrix.test.ts;
// wrappers, namespace imports and re-exports are discovered by their value.
const functionModules = import.meta.glob([
  "../../cms/ai.ts",
  "../../cms/aiSettings.ts",
  "../../cms/aiJobs.ts",
  "../../cms/aiConnections.ts",
  "../../cms/aiAuditLog.ts",
  "../../cms/agents.ts",
  "../../agents/*.ts",
  "!../../agents/*.test.ts",
])
function publicFunctions(
  path: string,
  exports: Record<string, unknown>
): string[] {
  const found: string[] = []
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== "function") continue
    const registered = value as {
      isPublic?: boolean
      isQuery?: boolean
      isMutation?: boolean
      isAction?: boolean
    }
    if (registered.isPublic !== true) continue
    if (!registered.isQuery && !registered.isMutation && !registered.isAction)
      throw new Error(`Unclassified registration: ${path}:${name}`)
    found.push(`${path}:${name}`)
  }
  return found
}
const root = process.cwd()
async function inventory(): Promise<string[]> {
  const found: string[] = []
  for (const [path, load] of Object.entries(functionModules)) {
    found.push(
      ...publicFunctions(
        path.slice("../../".length, -3),
        (await load()) as Record<string, unknown>
      )
    )
  }
  return found.sort()
}

function presentClassifications(
  classified: readonly string[],
  modulePaths: readonly string[]
): string[] {
  const presentModules = new Set(
    modulePaths.map((path) => path.slice("../../".length, -3))
  )
  return classified.filter((name) =>
    presentModules.has(name.slice(0, name.lastIndexOf(":")))
  )
}

test("every public AI function has exactly one C6 classification (35 plus S2a setup)", async () => {
  const classified = Object.values(groups)
    .flatMap((group) =>
      Object.entries(group).flatMap(([path, names]) =>
        names.map((name: string) => `${path}:${name}`)
      )
    )
    .sort()
  expect(classified).toHaveLength(39)
  expect(new Set(classified).size).toBe(39)
  expect(await inventory()).toEqual(
    presentClassifications(classified, Object.keys(functionModules))
  )
})

test("an unclassified public registration changes the inventory", () => {
  const surprise = Object.assign(() => null, { isPublic: true, isAction: true })
  expect(publicFunctions("cms/ai", { surprise })).toEqual(["cms/ai:surprise"])
})

test("absent modules are accepted but unclassified callables in present modules are rejected", () => {
  const classified = ["agents/sourceOnly:allowed", "cms/ai:known"]
  const expected = presentClassifications(classified, ["../../cms/ai.ts"])
  const known = Object.assign(() => null, { isPublic: true, isQuery: true })
  expect(publicFunctions("cms/ai", { known })).toEqual(expected)

  const surprise = Object.assign(() => null, { isPublic: true, isAction: true })
  expect(() =>
    expect(publicFunctions("cms/ai", { known, surprise })).toEqual(expected)
  ).toThrow()
})

test("S2b guarded action preparations use the signed AI gate", () => {
  for (const path of [
    "agents/contentWriter",
    "agents/localizer",
    "agents/helpAssistant",
    "agents/localGeneration",
    "cms/aiConnections",
  ]) {
    const source = readFileSync(join(root, `convex/${path}.ts`), "utf8")
    expect(source, path).toMatch(/requireOwnerAndOptionalModule\(ctx, "ai"/)
  }
})
