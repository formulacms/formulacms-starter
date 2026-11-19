// The one .env text parser (and its line writer) for formulacms. Node-only
// (`node:util`) but otherwise dependency-free, so Next server code reads
// .env.local without loading the local setup step (scripts/lib/local-setup.ts
// re-exports both for its callers).
import { parseEnv } from "node:util"

/**
 * A .env text as Node.js reads it (`util.parseEnv`, the dotenv rules that
 * Next.js and the Convex CLI also use): the last line for a key wins.
 * `env list --include-values` prints the same form
 * (convex/dist/cjs/cli/lib/formatEnvValueForDotfile.js), so it reads that too.
 */
export function parseEnvText(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (value !== undefined) values.set(key, value)
  }
  return values
}

/**
 * A value as one .env.local line that dotenv (Next.js and the Convex CLI) and
 * parseEnvText read back unchanged, or null when there is no safe form.
 */
export function envLineValue(value: string): string | null {
  if (/^[A-Za-z0-9_./:+=@-]+$/.test(value)) return value
  if (/[\r\n]/.test(value)) return null
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`
  return null
}
