// Pure E2E run selection. Playwright re-imports the config in every worker
// with no CLI arguments, so the run is chosen from the environment only
// (inherited unchanged by workers). This module reads no process state; the
// caller passes the environment in.

export const DISPOSABLE_CASES = {
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
  f09: {
    startState: "single-fr",
    stages: ["f09-1-row3", "f09-2-row4-remedy", "f09-3-fallback"],
  },
} as const satisfies Readonly<
  Record<string, { readonly startState: string; readonly stages: readonly string[] }>
>

export type DisposableCaseName = keyof typeof DISPOSABLE_CASES

export type E2ERun =
  | { family: "non-disposable" }
  | {
      family: "disposable"
      caseName: DisposableCaseName
      stage: string | null
      startState: string
      file: string
    }

export type E2EServerMode = "playwright" | "external"

type Env = Readonly<Record<string, string | undefined>>

const CASE_NAMES = Object.keys(DISPOSABLE_CASES) as DisposableCaseName[]

function isCaseName(value: string): value is DisposableCaseName {
  return (CASE_NAMES as string[]).includes(value)
}

/**
 * The start-state token a stage requires: the case's start state for its
 * first stage, otherwise `after-<previous stage>`.
 */
export function stageStartState(caseName: DisposableCaseName, stage: string): string {
  const stages: readonly string[] = DISPOSABLE_CASES[caseName].stages
  const index = stages.indexOf(stage)
  if (index < 0) {
    throw new Error(`${stage} is not a stage of the ${caseName} case; use one of: ${stages.join(", ") || "(none)"}`)
  }
  return index === 0 ? DISPOSABLE_CASES[caseName].startState : `after-${stages[index - 1]}`
}

export function selectE2ERun(env: Env): E2ERun {
  const caseName = env.FR6_E2E_DISPOSABLE_CASE
  const stage = env.FR6_E2E_STAGE
  const startState = env.FR6_E2E_START_STATE
  if (!caseName) {
    if (stage || startState) {
      throw new Error(
        "FR6_E2E_STAGE and FR6_E2E_START_STATE require FR6_E2E_DISPOSABLE_CASE " +
          `(one of: ${CASE_NAMES.join(", ")}); unset them for non-disposable runs`
      )
    }
    return { family: "non-disposable" }
  }
  if (!isCaseName(caseName)) {
    throw new Error(`FR6_E2E_DISPOSABLE_CASE must be one of: ${CASE_NAMES.join(", ")}`)
  }
  if (env.FORMULACMS_DISPOSABLE_TARGET !== "1") {
    throw new Error("Disposable E2E specs require FORMULACMS_DISPOSABLE_TARGET=1")
  }
  const stages: readonly string[] = DISPOSABLE_CASES[caseName].stages
  let expected: string
  if (stages.length > 0) {
    if (!stage || !stages.includes(stage)) {
      throw new Error(`The ${caseName} case requires FR6_E2E_STAGE to be one of: ${stages.join(", ")}`)
    }
    expected = stageStartState(caseName, stage)
  } else {
    if (stage) {
      throw new Error(`The ${caseName} case has no stages; unset FR6_E2E_STAGE`)
    }
    expected = DISPOSABLE_CASES[caseName].startState
  }
  if (startState !== expected) {
    throw new Error(`FR6_E2E_START_STATE must be ${expected} for this ${caseName} run`)
  }
  return {
    family: "disposable",
    caseName,
    stage: stage ?? null,
    startState: expected,
    file: stage ?? caseName,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Exactly one project per run; stages never depend on their predecessors. */
export function projectsFor(selection: E2ERun): { name: string; testMatch: RegExp }[] {
  if (selection.family === "non-disposable") {
    return [{ name: "non-disposable", testMatch: /non-disposable\/.*\.spec\.ts$/ }]
  }
  return [
    {
      name: "disposable",
      testMatch: new RegExp(`(^|/)disposable/${escapeRegExp(selection.file)}\\.spec\\.ts$`),
    },
  ]
}

export function serverModeFor(env: Env): E2EServerMode {
  const mode = env.FR6_E2E_SERVER
  if (mode === undefined || mode === "playwright") return "playwright"
  if (mode === "external") {
    if (!env.PUBLIC_BASE_URL) {
      throw new Error("FR6_E2E_SERVER=external requires PUBLIC_BASE_URL to name the running local origin")
    }
    return "external"
  }
  throw new Error("FR6_E2E_SERVER must be playwright or external")
}
