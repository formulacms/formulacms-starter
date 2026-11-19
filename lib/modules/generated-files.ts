import { createHash } from "node:crypto"

/**
 * Content hashes for the generated files the formulacms release owns
 * (ADR-0059). The module factory writes the hash line; the shipped check
 * (scripts/check-generated-files.ts, the starter `build` and
 * `check:preflight`) and `modules:sync --check` verify it. Imports nothing
 * from the factory tooling, which never ships.
 */

/** Release-owned generated files, relative to the application root. */
export const RELEASE_GENERATED_FILES: readonly string[] = [
  "lib/modules/catalog.generated.ts",
]

const HASH_PREFIX = "// Content hash: sha256-"
const HASH_LINE = /^\/\/ Content hash: sha256-([0-9a-f]{64})$/

// Git may check text files out with CRLF line endings (core.autocrlf on
// Windows); that is not an edit.
function sha256(text: string): string {
  return createHash("sha256")
    .update(text.replaceAll("\r\n", "\n"))
    .digest("hex")
}

/**
 * Inserts the hash line after the first (header) line. The hash covers every
 * other byte of the file, header included.
 */
export function withContentHash(text: string): string {
  const end = text.indexOf("\n")
  if (end < 0) throw new Error("A generated file needs a header line.")
  return `${text.slice(0, end + 1)}${HASH_PREFIX}${sha256(text)}\n${text.slice(end + 1)}`
}

export type GeneratedFileProblem = "missing" | "changed"

/**
 * `changed` when the second line is not a valid hash line or the rest of the
 * file does not match it; `missing` when there is no file.
 */
export function generatedFileProblem(
  text: string | null
): GeneratedFileProblem | undefined {
  if (text === null) return "missing"
  const normalized = text.replaceAll("\r\n", "\n")
  const first = normalized.indexOf("\n")
  const second = first < 0 ? -1 : normalized.indexOf("\n", first + 1)
  if (second < 0) return "changed"
  const match = HASH_LINE.exec(normalized.slice(first + 1, second))
  if (!match) return "changed"
  const unhashed = normalized.slice(0, first + 1) + normalized.slice(second + 1)
  return sha256(unhashed) === match[1] ? undefined : "changed"
}

export type GeneratedFileFinding = Readonly<{
  file: string
  problem: GeneratedFileProblem
}>

/** Checks every release-owned generated file; `read` returns null when a file is absent. */
export function findGeneratedFileProblems(
  read: (file: string) => string | null,
  files: readonly string[] = RELEASE_GENERATED_FILES
): GeneratedFileFinding[] {
  return files.flatMap((file) => {
    const problem = generatedFileProblem(read(file))
    return problem ? [{ file, problem }] : []
  })
}

/** What happened and what to do, in plain words. Shared by every caller. */
export function generatedFilesFailureMessage(
  findings: readonly GeneratedFileFinding[]
): string {
  return [
    "These generated files do not match the formulacms release:",
    ...findings.map(
      ({ file, problem }) =>
        `  ${file} (${problem === "missing" ? "missing" : "changed by hand"})`
    ),
    "The release owns these files. The check stops here so that your site does not run with a changed module list.",
    "To fix it:",
    "  1. If you need your changes, copy them to another place first.",
    "  2. Restore each listed file from the release tag that your site is on (for example v0.3.0):",
    ...findings.map(({ file }) => `       git checkout <release-tag> -- ${file}`),
    "  3. Run pnpm build or pnpm check:preflight again.",
    "Build your site's own feature as ordinary application code. Never edit a *.generated.* file, and never add a module id to the catalog. Module authoring is not yet available.",
  ].join("\n")
}
