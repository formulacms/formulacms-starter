import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RELEASE_GENERATED_FILES } from "../modules/generated-files"
import { CREATION_RECORD_PATH } from "../content-types/authoring/recovery"
import { factoryChecksReport, runFactoryChecks } from "./gate"

// The gate runs on a temporary copy of the files it reads, so no test edits
// the real tree.
const repo = join(import.meta.dirname, "../..")
const { sharedRegistries } = JSON.parse(
  readFileSync(join(repo, "engine.manifest.json"), "utf8")
) as { sharedRegistries: { manifest: string; generated: string[] }[] }
const FILES = [
  "engine.manifest.json",
  ...RELEASE_GENERATED_FILES,
  ...sharedRegistries.flatMap(({ manifest, generated }) => [
    manifest,
    ...generated,
  ]),
]

// The definitions row imports both registries from the copy, so it also
// needs their import closure and a resolvable convex package.
const REGISTRY_CLOSURE = [
  "convex/lib/blocks",
  "convex/lib/contentTypes",
  "convex/lib/definitions",
  "convex/lib/richtext",
  "convex/lib/pages/storageFields.ts",
]

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

function copyOfTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-gate-")))
  roots.push(root)
  for (const path of REGISTRY_CLOSURE) {
    cpSync(join(repo, path), join(root, path), { recursive: true })
  }
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir")
  for (const file of FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(join(repo, file), join(root, file))
  }
  return root
}

function edit(root: string, file: string, from: string, to: string) {
  const path = join(root, file)
  const text = readFileSync(path, "utf8")
  expect(text).toContain(from)
  writeFileSync(path, text.replace(from, to))
}

function snapshot(root: string) {
  return FILES.map((file) => readFileSync(join(root, file), "utf8"))
}

describe("factory gate", () => {
  it("passes on the clean tree", async () => {
    const report = factoryChecksReport(await runFactoryChecks(copyOfTree()))
    expect(report).toEqual({
      passed: true,
      text: "Factory checks passed: Release-owned generated files, Interrupted content-type creation, Content-type and block definitions, Block registration, Content-type registration.",
    })
  })

  it("runs every check, reports every failure with its repair, and writes nothing", async () => {
    const root = copyOfTree()
    // Remove the first registered block, whatever its name: shipped blocks
    // are examples an owner may delete or replace.
    const registry = readFileSync(
      join(root, "convex/lib/blocks/index.ts"),
      "utf8"
    )
    const entry = registry.match(/^  "[a-z0-9-]+": [A-Za-z0-9]+Def,\n/m)
    expect(entry).not.toBeNull()
    edit(root, "convex/lib/blocks/index.ts", entry![0], "")
    edit(root, "convex/lib/pages/types.ts", '  "page",\n', "")
    edit(
      root,
      "lib/modules/catalog.generated.ts",
      "\n",
      "\n// edited by hand\n"
    )
    const before = snapshot(root)

    const checks = await runFactoryChecks(root)
    const { passed, text } = factoryChecksReport(checks)

    expect(snapshot(root)).toEqual(before)
    expect(passed).toBe(false)
    expect(checks.map(({ name, failure }) => [name, !!failure])).toEqual([
      ["Release-owned generated files", true],
      ["Interrupted content-type creation", false],
      ["Content-type and block definitions", false],
      ["Block registration", true],
      ["Content-type registration", true],
    ])
    const [release, , , blocks, contentTypes] = checks.map(
      ({ failure }) => failure!
    )
    // Release class: restore from the release tag.
    expect(release).toContain(
      "lib/modules/catalog.generated.ts (changed by hand)"
    )
    expect(release).toContain(
      "git checkout <release-tag> -- lib/modules/catalog.generated.ts"
    )
    // Site class: regenerate with the registry's command; never restore.
    expect(blocks).toContain("  convex/lib/blocks/index.ts")
    expect(blocks).toContain("Run pnpm blocks:sync.")
    expect(blocks).toContain("Never restore these files from a release tag.")
    expect(blocks).not.toContain("git checkout")
    expect(contentTypes).toContain("  convex/lib/pages/types.ts")
    expect(contentTypes).toContain("Run pnpm content-types:sync.")
    expect(contentTypes).toContain("own content types.")
    expect(text).toContain(
      "3 of 5 factory checks failed: Release-owned generated files, Block registration, Content-type registration."
    )
  })

  it("reports a check that cannot run as a failure", async () => {
    const root = copyOfTree()
    writeFileSync(join(root, "lib/blocks/blocks.manifest.json"), "{}")
    const checks = await runFactoryChecks(root)
    expect(checks.map(({ failure }) => !!failure)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ])
    expect(checks[3]!.failure).toContain(
      "lib/blocks/blocks.manifest.json is not a valid block manifest."
    )
  })

  it("names the manifest and its repair when a manifest holds conflict markers", async () => {
    const root = copyOfTree()
    const manifest = join(root, "lib/blocks/blocks.manifest.json")
    writeFileSync(manifest, `<<<<<<< HEAD\n${readFileSync(manifest, "utf8")}`)
    const [, , , blocks] = await runFactoryChecks(root)
    expect(blocks!.failure).toContain(
      "Could not read lib/blocks/blocks.manifest.json:"
    )
    expect(blocks!.failure).toContain(
      "keeping both sides' entries, then run pnpm blocks:sync."
    )
  })

  it("names --recover while a content-type creation is interrupted", async () => {
    const root = copyOfTree()
    mkdirSync(join(root, ".formulacms/local"), { recursive: true })
    writeFileSync(
      join(root, CREATION_RECORD_PATH),
      JSON.stringify({ type: "event", startedAt: "", files: [] })
    )
    const checks = await runFactoryChecks(root)
    expect(checks[1]!.name).toBe("Interrupted content-type creation")
    expect(checks[1]!.failure).toContain(
      "Run pnpm content-type:new -- --recover."
    )
    expect(checks[1]!.failure).toContain(CREATION_RECORD_PATH)
    expect(factoryChecksReport(checks).passed).toBe(false)
  })

  it("fails the definitions row on a broken descriptor and still runs the other rows", async () => {
    const root = copyOfTree()
    edit(
      root,
      "convex/lib/contentTypes/post.ts",
      "    tags: sharedFields.tags.validator,\n",
      "    tags: sharedFields.tags.validator,\n    status: v.optional(v.string()),\n"
    )
    const checks = await runFactoryChecks(root)
    expect(checks.map(({ name, failure }) => [name, !!failure])).toEqual([
      ["Release-owned generated files", false],
      ["Interrupted content-type creation", false],
      ["Content-type and block definitions", true],
      ["Block registration", false],
      ["Content-type registration", false],
    ])
    expect(checks[2]!.failure).toContain(
      'Content type "post", field "status": reserved-field'
    )
  })

  it("catches a duplicate manifest row that the registry cannot see", async () => {
    const root = copyOfTree()
    const path = join(root, "lib/blocks/blocks.manifest.json")
    const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown[]
    writeFileSync(path, JSON.stringify([...manifest, manifest[0]], null, 2))
    const [, , definitions] = await runFactoryChecks(root)
    expect(definitions!.failure).toContain("duplicate-type")
    expect(definitions!.failure).toContain("the manifest lists")
  })
})
