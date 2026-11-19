// The local API keys as .env.local holds them now. Node-only (`node:fs`); no
// `server-only` import, because scripts/ run it under tsx.
//
// Next.js copies `process.env` once at start, and its env reload adds only
// names that were absent then (node_modules/@next/env, `processEnv`). So an
// edited or removed key reaches `process.env` only after a restart. This
// reader reads the file at each call instead. When the file exists, it is the
// only source for the key names: a name absent or blank there is no key,
// whatever `process.env` still holds. Without the file (CI, a hosted site),
// the given environment is used. Supported input: .env.local under 64 KB.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseEnvText } from "./env-text"
import {
  keyPresence,
  localApiKeysFrom,
  type LocalApiKeys,
  type LocalProviderKeyPresence,
} from "./local-api-keys"

export interface LocalApiKeysOptions {
  /** The project root holding .env.local; defaults to `process.cwd()`. */
  readonly root?: string
  /** Used only when .env.local does not exist; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const NO_KEYS: LocalApiKeys = Object.freeze({
  anthropic: undefined,
  openai: undefined,
  openrouter: undefined,
})

/** Each provider's key from .env.local now (see the rule above). Never throws. */
export function readLocalApiKeys(options: LocalApiKeysOptions = {}): LocalApiKeys {
  let text: string
  try {
    text = readFileSync(join(options.root ?? process.cwd(), ".env.local"), "utf8")
  } catch (error) {
    // Not found: no local file, so the environment holds the keys. Any other
    // read error: no key (and no log, so no value can leak).
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? localApiKeysFrom(options.env ?? process.env)
      : NO_KEYS
  }
  try {
    return localApiKeysFrom(Object.fromEntries(parseEnvText(text)))
  } catch {
    return NO_KEYS
  }
}

/** Which providers have a key in .env.local now. Booleans only: never a value. */
export function localProviderKeyPresenceNow(
  options: LocalApiKeysOptions = {}
): LocalProviderKeyPresence {
  return keyPresence(readLocalApiKeys(options))
}
