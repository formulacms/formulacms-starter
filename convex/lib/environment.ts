type OwnerClaimEnv = {
  FORMULACMS_OWNER_CLAIM?: string
  NEXTCMS_OWNER_CLAIM?: string
}

export function resolveOwnerClaim(env: OwnerClaimEnv): string | undefined {
  if (env.FORMULACMS_OWNER_CLAIM?.trim()) {
    return env.FORMULACMS_OWNER_CLAIM
  }
  return env.NEXTCMS_OWNER_CLAIM?.trim() ? env.NEXTCMS_OWNER_CLAIM : undefined
}
