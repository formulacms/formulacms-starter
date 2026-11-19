// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, test } from "vitest"

// Guard for the defect class "an assistant set to a local tool runs from
// another device, or bills an API key silently" (AI-LOCAL-2). Every shipped
// screen that starts, resumes or plans a page job through Convex must also
// hold the route decision: the assistant's local tool on this computer
// (`localTool`) and the local server action that runs it. A new caller fails
// here until it takes the same decision.

const root = process.cwd()
/** The development lane: not in the starter; it routes on its own (`resolveLocalAiRoute`). */
const DEV_LANE = new Set(["app/(core)/admin/(authenticated)/pages/ai-actions.ts"])

const API_CALLS = {
  "api.cms.aiJobs.startPageJob": "startLocalPageJob",
  "api.cms.aiJobs.resumePageJob": "resumeLocalPageJob",
  "api.agents.contentWriter.generatePageOutline": "generatePageOutlineLocal",
} as const

function shippedSources(): string[] {
  return ["app", "components", "lib"].flatMap((dir) =>
    (readdirSync(join(root, dir), { recursive: true }) as string[])
      .map((file) => relative(root, join(root, dir, file)).replaceAll("\\", "/"))
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => !DEV_LANE.has(file))
  )
}

describe("page job callers take the local route decision", () => {
  const callers = shippedSources().flatMap((file) => {
    const text = readFileSync(join(root, file), "utf8")
    return Object.entries(API_CALLS)
      .filter(([call]) => text.includes(call))
      .map(([call, local]) => ({ file, call, local, text }))
  })

  test("the known callers, and only them", () => {
    expect([...new Set(callers.map(({ file }) => file))].sort()).toEqual([
      "components/admin/ai-translation/page-editor-participant.tsx",
      "components/admin/ai-writing/page-jobs.tsx",
      "components/admin/ai-writing/page-wizard.tsx",
    ])
  })

  test("each Convex call sits beside its local twin and the local route", () => {
    expect(callers.length).toBeGreaterThan(0)
    for (const { file, call, local, text } of callers) {
      expect(text, `${file}: ${call} without ${local}`).toContain(local)
      expect(text, `${file}: ${call} without the local route`).toMatch(/\blocalTool\b/)
    }
  })
})
