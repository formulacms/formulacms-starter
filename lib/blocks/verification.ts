export const BLOCK_VERIFICATION_SCENARIOS = [
  "proposal",
  "decomposition",
  "renderer-failure",
  "archive-read-failure",
] as const

export type BlockVerificationScenario =
  (typeof BLOCK_VERIFICATION_SCENARIOS)[number]

type BlockVerificationEnv = {
  NODE_ENV?: string
  FORMULACMS_BLOCK_VERIFICATION?: string
  FORMULACMS_BLOCK_VERIFICATION_DELETE_GATE?: string
  NEXTCMS_BLOCK_VERIFICATION?: string
  NEXTCMS_BLOCK_VERIFICATION_DELETE_GATE?: string
}

export function isBlockVerificationEnabled(
  env: BlockVerificationEnv = process.env
): boolean {
  const configured =
    env.FORMULACMS_BLOCK_VERIFICATION ?? env.NEXTCMS_BLOCK_VERIFICATION
  return env.NODE_ENV !== "production" && configured === "1"
}

export function resolveBlockVerificationScenario(
  value: string | string[] | undefined,
  env: BlockVerificationEnv = process.env
): BlockVerificationScenario | null {
  if (!isBlockVerificationEnabled(env) || typeof value !== "string") {
    return null
  }
  return (BLOCK_VERIFICATION_SCENARIOS as readonly string[]).includes(value)
    ? (value as BlockVerificationScenario)
    : null
}

export function shouldForceBlockDeletionGateFailure(
  env: BlockVerificationEnv = process.env
): boolean {
  return (
    isBlockVerificationEnabled(env) &&
    (env.FORMULACMS_BLOCK_VERIFICATION_DELETE_GATE ??
      env.NEXTCMS_BLOCK_VERIFICATION_DELETE_GATE) === "fail"
  )
}

export function assertBlockVerificationEnabled(
  env: BlockVerificationEnv = process.env
): void {
  if (!isBlockVerificationEnabled(env)) {
    throw new Error(
      "Block lifecycle verification is disabled. Start local development with FORMULACMS_BLOCK_VERIFICATION=1."
    )
  }
}
