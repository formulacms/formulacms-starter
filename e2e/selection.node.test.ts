import { describe, expect, test } from "vitest"
import {
  DISPOSABLE_CASES,
  projectsFor,
  selectE2ERun,
  serverModeFor,
  stageStartState,
  type DisposableCaseName,
} from "./selection"

const SPEC_ROOT = "/repo/e2e"
const NON_DISPOSABLE_FILES = [
  "authorization",
  "concurrency",
  "content",
  "language-and-modules",
  "menus",
  "public-probes",
  "publication",
  "redirects",
]
const DISPOSABLE_FILES = [
  "ownership",
  "v02",
  "replacement",
  "m05-1-adoption",
  "m05-2-languages",
  "m05-3-default-migrations",
  "m05-4-removal-disable",
  "m05-5-p24",
  "m05-6-re-adoption",
  "f09-1-row3",
  "f09-2-row4-remedy",
  "f09-3-fallback",
]
const ALL_SPEC_PATHS = [
  ...NON_DISPOSABLE_FILES.map((file) => `${SPEC_ROOT}/non-disposable/${file}.spec.ts`),
  ...DISPOSABLE_FILES.map((file) => `${SPEC_ROOT}/disposable/${file}.spec.ts`),
]

const EXPECTED_START_STATES: Record<string, string> = {
  "m05-1-adoption": "single-en",
  "m05-2-languages": "after-m05-1-adoption",
  "m05-3-default-migrations": "after-m05-2-languages",
  "m05-4-removal-disable": "after-m05-3-default-migrations",
  "m05-5-p24": "after-m05-4-removal-disable",
  "m05-6-re-adoption": "after-m05-5-p24",
  "f09-1-row3": "single-fr",
  "f09-2-row4-remedy": "after-f09-1-row3",
  "f09-3-fallback": "after-f09-2-row4-remedy",
}

type ValidEnv = {
  caseName: DisposableCaseName
  stage: string | null
  file: string
  env: Record<string, string>
}

/** One valid disposable environment per disposable spec file. */
function validDisposableEnvs(): ValidEnv[] {
  return (Object.keys(DISPOSABLE_CASES) as DisposableCaseName[]).flatMap((caseName): ValidEnv[] => {
    const startState: string = DISPOSABLE_CASES[caseName].startState
    const stages: readonly string[] = DISPOSABLE_CASES[caseName].stages
    const base = { FR6_E2E_DISPOSABLE_CASE: caseName, FORMULACMS_DISPOSABLE_TARGET: "1" }
    if (stages.length === 0) {
      return [{ caseName, stage: null, file: caseName, env: { ...base, FR6_E2E_START_STATE: startState } }]
    }
    return stages.map((stage) => ({
      caseName,
      stage,
      file: stage,
      env: { ...base, FR6_E2E_STAGE: stage, FR6_E2E_START_STATE: EXPECTED_START_STATES[stage]! },
    }))
  })
}

describe("disposable case table", () => {
  test("declares every case with its start state and stages", () => {
    expect(DISPOSABLE_CASES).toEqual({
      ownership: { startState: "fresh-unclaimed", stages: [] },
      v02: { startState: "owned-after-reset", stages: [] },
      replacement: { startState: "owned-rotated-claim", stages: [] },
      m05: {
        startState: "single-en",
        stages: [
          "m05-1-adoption",
          "m05-2-languages",
          "m05-3-default-migrations",
          "m05-4-removal-disable",
          "m05-5-p24",
          "m05-6-re-adoption",
        ],
      },
      f09: { startState: "single-fr", stages: ["f09-1-row3", "f09-2-row4-remedy", "f09-3-fallback"] },
    })
  })

  test.each(Object.entries(EXPECTED_START_STATES))("%s starts from %s", (stage, token) => {
    const caseName = stage.startsWith("m05-") ? "m05" : "f09"
    expect(stageStartState(caseName, stage)).toBe(token)
  })

  test("refuses a stage outside its case", () => {
    expect(() => stageStartState("m05", "f09-1-row3")).toThrow(/not a stage of the m05 case/)
  })
})

describe("selectE2ERun", () => {
  test("selects non-disposable without any disposable variables", () => {
    expect(selectE2ERun({})).toEqual({ family: "non-disposable" })
    expect(selectE2ERun({ FORMULACMS_DISPOSABLE_TARGET: "1" })).toEqual({ family: "non-disposable" })
  })

  test("covers all 12 disposable files", () => {
    expect(validDisposableEnvs().map(({ file }) => file).sort()).toEqual([...DISPOSABLE_FILES].sort())
  })

  test.each(validDisposableEnvs().map((entry) => [entry.file, entry] as const))(
    "selects %s",
    (_file, { caseName, stage, file, env }) => {
      expect(selectE2ERun(env)).toEqual({
        family: "disposable",
        caseName,
        stage,
        startState: env.FR6_E2E_START_STATE,
        file,
      })
    }
  )

  const m05 = {
    FR6_E2E_DISPOSABLE_CASE: "m05",
    FORMULACMS_DISPOSABLE_TARGET: "1",
    FR6_E2E_STAGE: "m05-3-default-migrations",
    FR6_E2E_START_STATE: "after-m05-2-languages",
  }

  test.each([
    ["an unknown case", { ...m05, FR6_E2E_DISPOSABLE_CASE: "m06" }, /FR6_E2E_DISPOSABLE_CASE must be one of: ownership, v02, replacement, m05, f09/],
    ["a missing target flag", { ...m05, FORMULACMS_DISPOSABLE_TARGET: undefined }, /FORMULACMS_DISPOSABLE_TARGET=1/],
    ["a target flag other than 1", { ...m05, FORMULACMS_DISPOSABLE_TARGET: "true" }, /FORMULACMS_DISPOSABLE_TARGET=1/],
    ["a missing stage for a staged case", { ...m05, FR6_E2E_STAGE: undefined }, /FR6_E2E_STAGE to be one of: m05-1-adoption/],
    ["an unknown stage for a staged case", { ...m05, FR6_E2E_STAGE: "f09-1-row3" }, /FR6_E2E_STAGE to be one of: m05-1-adoption/],
    [
      "a stage for an unstaged case",
      {
        FR6_E2E_DISPOSABLE_CASE: "ownership",
        FORMULACMS_DISPOSABLE_TARGET: "1",
        FR6_E2E_STAGE: "m05-1-adoption",
        FR6_E2E_START_STATE: "fresh-unclaimed",
      },
      /ownership case has no stages; unset FR6_E2E_STAGE/,
    ],
    ["a wrong stage start state", { ...m05, FR6_E2E_START_STATE: "single-en" }, /FR6_E2E_START_STATE must be after-m05-2-languages/],
    ["a missing start state", { ...m05, FR6_E2E_START_STATE: undefined }, /FR6_E2E_START_STATE must be after-m05-2-languages/],
    [
      "a wrong unstaged start state",
      { FR6_E2E_DISPOSABLE_CASE: "v02", FORMULACMS_DISPOSABLE_TARGET: "1", FR6_E2E_START_STATE: "fresh-unclaimed" },
      /FR6_E2E_START_STATE must be owned-after-reset/,
    ],
    ["a stage without a case", { FR6_E2E_STAGE: "m05-1-adoption" }, /require FR6_E2E_DISPOSABLE_CASE/],
    ["a start state without a case", { FR6_E2E_START_STATE: "single-en" }, /require FR6_E2E_DISPOSABLE_CASE/],
  ])("throws for %s", (_name, env, message) => {
    expect(() => selectE2ERun(env)).toThrow(message)
  })
})

describe("projectsFor", () => {
  test("non-disposable matches only non-disposable specs", () => {
    const projects = projectsFor({ family: "non-disposable" })
    expect(projects).toHaveLength(1)
    expect(projects[0]).not.toHaveProperty("dependencies")
    expect(projects[0]!.name).toBe("non-disposable")
    expect(ALL_SPEC_PATHS.filter((path) => projects[0]!.testMatch.test(path))).toEqual(
      NON_DISPOSABLE_FILES.map((file) => `${SPEC_ROOT}/non-disposable/${file}.spec.ts`)
    )
  })

  test.each(validDisposableEnvs().map((entry) => [entry.file, entry] as const))(
    "%s gets exactly one dependency-free project matching only its own file",
    (file, { env }) => {
      const projects = projectsFor(selectE2ERun(env))
      expect(projects).toHaveLength(1)
      expect(projects[0]).toEqual({ name: "disposable", testMatch: expect.any(RegExp) })
      expect(projects[0]).not.toHaveProperty("dependencies")
      const matched = ALL_SPEC_PATHS.filter((path) => projects[0]!.testMatch.test(path))
      expect(matched).toEqual([`${SPEC_ROOT}/disposable/${file}.spec.ts`])
      expect(projects[0]!.testMatch.test(`${SPEC_ROOT}/non-disposable/${file}.spec.ts`)).toBe(false)
      expect(projects[0]!.testMatch.test(`disposable/${file}.spec.ts`)).toBe(true)
    }
  )
})

describe("serverModeFor", () => {
  test("defaults to playwright", () => {
    expect(serverModeFor({})).toBe("playwright")
    expect(serverModeFor({ FR6_E2E_SERVER: "playwright" })).toBe("playwright")
  })

  test("external requires an explicit PUBLIC_BASE_URL", () => {
    expect(serverModeFor({ FR6_E2E_SERVER: "external", PUBLIC_BASE_URL: "http://localhost:3000" })).toBe("external")
    expect(() => serverModeFor({ FR6_E2E_SERVER: "external" })).toThrow(/requires PUBLIC_BASE_URL/)
  })

  test("refuses any other value", () => {
    expect(() => serverModeFor({ FR6_E2E_SERVER: "launcher" })).toThrow(/must be playwright or external/)
  })
})
