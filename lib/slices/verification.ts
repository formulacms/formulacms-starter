export const SLICE_VERIFICATION_SCENARIOS = [
  "proposal",
  "decomposition",
  "renderer-failure",
  "archive-read-failure",
] as const

export type SliceVerificationScenario =
  (typeof SLICE_VERIFICATION_SCENARIOS)[number]

type SliceVerificationEnv = {
  NODE_ENV?: string
  FORMULACMS_SLICE_VERIFICATION?: string
  FORMULACMS_SLICE_VERIFICATION_DELETE_GATE?: string
  NEXTCMS_SLICE_VERIFICATION?: string
  NEXTCMS_SLICE_VERIFICATION_DELETE_GATE?: string
}

export function isSliceVerificationEnabled(
  env: SliceVerificationEnv = process.env
): boolean {
  const configured =
    env.FORMULACMS_SLICE_VERIFICATION ?? env.NEXTCMS_SLICE_VERIFICATION
  return env.NODE_ENV !== "production" && configured === "1"
}

export function resolveSliceVerificationScenario(
  value: string | string[] | undefined,
  env: SliceVerificationEnv = process.env
): SliceVerificationScenario | null {
  if (!isSliceVerificationEnabled(env) || typeof value !== "string") {
    return null
  }
  return (SLICE_VERIFICATION_SCENARIOS as readonly string[]).includes(value)
    ? (value as SliceVerificationScenario)
    : null
}

export function shouldForceSliceDeletionGateFailure(
  env: SliceVerificationEnv = process.env
): boolean {
  return (
    isSliceVerificationEnabled(env) &&
    (env.FORMULACMS_SLICE_VERIFICATION_DELETE_GATE ??
      env.NEXTCMS_SLICE_VERIFICATION_DELETE_GATE) === "fail"
  )
}

export function assertSliceVerificationEnabled(
  env: SliceVerificationEnv = process.env
): void {
  if (!isSliceVerificationEnabled(env)) {
    throw new Error(
      "Slice lifecycle verification is disabled. Start local development with FORMULACMS_SLICE_VERIFICATION=1."
    )
  }
}
