import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SOURCE_REPOSITORY_MARKER,
  findSourceRepositoryAtOrAbove,
} from "./source-repository"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

function folder(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "source-repository-")))
  roots.push(root)
  return root
}

function write(path: string, text = "") {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

describe("source repository marker walk", () => {
  it("refuses the source repository and any folder inside it", () => {
    const source = folder()
    write(join(source, SOURCE_REPOSITORY_MARKER), "{}")
    const nested = join(source, "apps", "site")
    mkdirSync(nested, { recursive: true })

    expect(findSourceRepositoryAtOrAbove(source)).toBe(source)
    expect(findSourceRepositoryAtOrAbove(nested)).toBe(source)
  })

  it("accepts a clone-shaped site: a plain clone of the starter plus setup", () => {
    const site = folder()
    for (const file of [
      ".git/HEAD",
      "package.json",
      "AGENTS.md",
      ".env.local",
      "lib/modules/catalog.generated.ts",
      "scripts/check-starter-preflight.ts",
      "scripts/lib/source-repository.ts",
    ]) {
      write(join(site, file))
    }
    expect(findSourceRepositoryAtOrAbove(site)).toBeNull()
    expect(findSourceRepositoryAtOrAbove(join(site, "scripts"))).toBeNull()
  })

  it("propagates errors other than not found", () => {
    const site = folder()
    // A file where a folder is expected gives ENOTDIR, not ENOENT.
    write(join(site, "scripts"), "not a folder")
    expect(() => findSourceRepositoryAtOrAbove(site)).toThrow(/ENOTDIR/)
  })
})
