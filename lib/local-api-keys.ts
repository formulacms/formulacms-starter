// Names of the local-development API key variables, current name first and
// the legacy name second. Dependency-free on purpose: the local engine reads
// the values, while server pages and actions only ask whether a key is there.

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

/** Which providers have a non-blank key. Booleans only: never a value. */
export function localProviderKeyPresence(
  env: Readonly<Record<string, string | undefined>> = process.env
): LocalProviderKeyPresence {
  const present = (provider: LocalApiProvider) =>
    LOCAL_API_KEY_NAMES[provider].some((name) => Boolean(env[name]?.trim()))
  return {
    anthropic: present("anthropic"),
    openai: present("openai"),
    openrouter: present("openrouter"),
  }
}
