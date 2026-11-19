// Names of the local-development API key variables, current name first and
// the legacy name second. Dependency-free on purpose: a client screen imports
// the names. The values are read at use time from .env.local by
// `lib/local-api-keys-file.ts` (node-only); this file only maps names.

export const LOCAL_API_KEY_NAMES = {
  openrouter: [
    "FORMULACMS_DEV_OPENROUTER_API_KEY",
    "NEXTCMS_DEV_OPENROUTER_API_KEY",
  ],
  anthropic: [
    "FORMULACMS_DEV_ANTHROPIC_API_KEY",
    "NEXTCMS_DEV_ANTHROPIC_API_KEY",
  ],
  openai: ["FORMULACMS_DEV_OPENAI_API_KEY", "NEXTCMS_DEV_OPENAI_API_KEY"],
} as const satisfies Record<
  "openrouter" | "anthropic" | "openai",
  readonly [string, string]
>

export type LocalApiProvider = keyof typeof LOCAL_API_KEY_NAMES
export type LocalProviderKeyPresence = Record<LocalApiProvider, boolean>
/** Each provider's key value, or undefined when there is none. */
export type LocalApiKeys = Record<LocalApiProvider, string | undefined>

type EnvValues = Readonly<Record<string, string | undefined>>

/** Each provider's trimmed key: the current name wins over the legacy one; blank is none. */
export function localApiKeysFrom(env: EnvValues): LocalApiKeys {
  const key = (provider: LocalApiProvider) => {
    const [currentName, legacyName] = LOCAL_API_KEY_NAMES[provider]
    return env[currentName]?.trim() || env[legacyName]?.trim() || undefined
  }
  return {
    anthropic: key("anthropic"),
    openai: key("openai"),
    openrouter: key("openrouter"),
  }
}

/** Which providers have a key. Booleans only: never a value. */
export function keyPresence(keys: LocalApiKeys): LocalProviderKeyPresence {
  return {
    anthropic: Boolean(keys.anthropic),
    openai: Boolean(keys.openai),
    openrouter: Boolean(keys.openrouter),
  }
}

/**
 * Which providers have a non-blank key in the given values. Booleans only.
 * No default: Next.js keeps `process.env` from start, so live callers use
 * `localProviderKeyPresenceNow` (lib/local-api-keys-file.ts).
 */
export function localProviderKeyPresence(
  env: EnvValues
): LocalProviderKeyPresence {
  return keyPresence(localApiKeysFrom(env))
}
