import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  RELEASE_GENERATED_FILES,
  findGeneratedFileProblems,
  generatedFileProblem,
  generatedFilesFailureMessage,
  withContentHash,
} from "./generated-files"

const root = join(import.meta.dirname, "../..")
const read = (file: string) => readFileSync(join(root, file), "utf8")
const SAMPLE = '// GENERATED header. Do not edit.\nexport const A = ["a"]\n'

/** Replaces the first `from` and proves it was there. */
function change(text: string, from: string, to: string): string {
  expect(text).toContain(from)
  return text.replace(from, to)
}

describe("generated-file content hash", () => {
  it("is stable across runs and accepted by the check", () => {
    const first = withContentHash(SAMPLE)
    expect(withContentHash(SAMPLE)).toBe(first)
    expect(first.split("\n")[1]).toMatch(
      /^\/\/ Content hash: sha256-[0-9a-f]{64}$/
    )
    expect(generatedFileProblem(first)).toBeUndefined()
  })

  it("accepts every committed release-owned generated file", () => {
    expect(RELEASE_GENERATED_FILES).toEqual(["lib/modules/catalog.generated.ts"])
    expect(findGeneratedFileProblems(read)).toEqual([])
  })

  it("detects a body edit", () => {
    const catalog = read("lib/modules/catalog.generated.ts")
    expect(
      generatedFileProblem(
        change(catalog, 'id: "redirects"', 'id: "owner-blog"')
      )
    ).toBe("changed")
  })

  it.each([
    ["the header line", (text: string) => change(text, "Do not edit", "Edit")],
    [
      "the hash line",
      (text: string) => text.replace(/sha256-[0-9a-f]/, "sha256-x"),
    ],
    [
      "a removed hash line",
      (text: string) => text.replace(/^\/\/ Content hash.*\n/m, ""),
    ],
    [
      "text after the hash",
      (text: string) => text.replace(/\n(\/\/ C.*)\n/, "\n$1 \n"),
    ],
    ["an added final line", (text: string) => `${text}\n`],
    ["a removed final newline", (text: string) => text.slice(0, -1)],
  ])("ignores nothing else: detects %s", (_case, edit) => {
    expect(generatedFileProblem(edit(withContentHash(SAMPLE)))).toBe("changed")
  })

  it("accepts a CRLF checkout of an unedited file", () => {
    const crlf = withContentHash(SAMPLE).replaceAll("\n", "\r\n")
    expect(generatedFileProblem(crlf)).toBeUndefined()
  })

  it("reports a missing file and a file with only a header", () => {
    expect(generatedFileProblem(null)).toBe("missing")
    expect(generatedFileProblem("// GENERATED header\n")).toBe("changed")
    expect(() => withContentHash("no header line")).toThrow(/header line/)
  })

  it("names each file, the restore command and the agent rule", () => {
    const findings = findGeneratedFileProblems(
      (file) => (file === "lib/modules/catalog.generated.ts" ? "edited\n" : null),
      ["lib/modules/catalog.generated.ts", "lib/modules/other.generated.ts"]
    )
    const message = generatedFilesFailureMessage(findings)
    expect(message).toBe(
      [
        "These generated files do not match the formulacms release:",
        "  lib/modules/catalog.generated.ts (changed by hand)",
        "  lib/modules/other.generated.ts (missing)",
        "The release owns these files. The check stops here so that your site does not run with a changed module list.",
        "To fix it:",
        "  1. If you need your changes, copy them to another place first.",
        "  2. Restore each listed file from the release tag that your site is on (for example v0.3.0):",
        "       git checkout <release-tag> -- lib/modules/catalog.generated.ts",
        "       git checkout <release-tag> -- lib/modules/other.generated.ts",
        "  3. Run pnpm build or pnpm check:preflight again.",
        "Build your site's own feature as ordinary application code. Never edit a *.generated.* file, and never add a module id to the catalog. Module authoring is not yet available.",
      ].join("\n")
    )
  })
})
