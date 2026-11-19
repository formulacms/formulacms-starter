import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GENERATED_MODULE_CATALOG } from "../lib/modules/catalog.generated"
import { SOURCE_REPOSITORY_MARKER } from "./lib/source-repository"
import {
  checkStoredModuleIds,
  unknownStoredModuleIds,
  type ConvexDataResult,
} from "./lib/stored-module-state"

// The upgrade preflight's stored-module check, with the Convex CLI call
// injected. No test reaches a deployment.

const knownIds = GENERATED_MODULE_CATALOG.map(({ id }) => id)
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

/** A clone-shaped site folder with no source-repository marker above it. */
function site(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stored-modules-")))
  roots.push(root)
  mkdirSync(join(root, ".git"))
  writeFileSync(join(root, "package.json"), "{}")
  return root
}

/** `convex data cmsModuleState --format jsonLines` output for these rows. */
function rows(...enabled: string[][]): ConvexDataResult {
  return {
    ok: true,
    stdout: enabled
      .map((ids) =>
        JSON.stringify({
          _creationTime: 1,
          _id: "k1",
          configurationVersion: 3,
          enabledModules: ids.map((moduleId) => ({ moduleId, configVersion: 1 })),
          key: "owner",
        })
      )
      .join("\n"),
  }
}

function check(read: () => ConvexDataResult, root = site()) {
  return checkStoredModuleIds({ root, knownIds, read })
}

describe("stored-module preflight check", () => {
  it("(a) passes when every stored id is in the release", () => {
    expect(check(() => rows(["redirects", "multilingual"]))).toEqual({
      status: "passed",
      message: "Every module that your backend stores as enabled is in this release.",
    })
    expect(check(() => ({ ok: true, stdout: "" }))).toEqual({
      status: "passed",
      message: "No module choices are stored yet.",
    })
  })

  it("(b) stops and names one unknown id and the fix", () => {
    const result = check(() => rows(["redirects", "owner-blog"]))
    expect(result.status).toBe("failed")
    expect(result.message).toBe(
      [
        "Your backend stores modules that this release does not have: owner-blog.",
        "If you run this release, the site cannot read any module setting, and the admin stops working.",
        "To fix it:",
        '  1. Go back to the code that your site ran before (for example "git merge --abort", or check out your previous commit).',
        '  2. Run "pnpm dev". On Settings › Modules, disable owner-blog, then select Apply.',
        '  3. Merge the release again, then run "pnpm check:preflight" again.',
        "Build your site's own feature as ordinary application code. Never add a module id to the catalog.",
      ].join("\n")
    )
  })

  const unreadable: Array<[string, ConvexDataResult, string]> = [
    [
      "the CLI does not run",
      {
        ok: false,
        reason:
          "the Convex CLI did not run (it is not installed, or it timed out)",
      },
      "the Convex CLI did not run",
    ],
    [
      "the CLI fails",
      { ok: false, reason: "the Convex CLI could not read your backend" },
      "could not read your backend",
    ],
    [
      "the CLI prints text that is not JSON",
      { ok: true, stdout: "Welcome!" },
      "does not understand",
    ],
    [
      "a row has no enabledModules",
      { ok: true, stdout: '{"key":"owner"}' },
      "does not understand",
    ],
  ]

  it.each(unreadable)(
    "(c) says it could not check when %s, never passed",
    (_case, result, reason) => {
      const outcome = check(() => result)
      expect(outcome.status).toBe("warning")
      expect(outcome.inconclusive).toBe(true)
      expect(outcome.message).toMatch(
        /^Could not check the modules that your backend stores: /
      )
      expect(outcome.message).toContain(reason)
      expect(outcome.message).toContain('Start your backend with "pnpm dev"')
    }
  )

  // Guard (review round 1): valid JSON that is not exactly the stored
  // cmsModuleState shape never passes; the check could not check it.
  const complete = {
    _id: "k1",
    _creationTime: 1,
    key: "owner",
    configurationVersion: 2,
    enabledModules: [{ moduleId: "redirects", configVersion: 1 }],
  }
  const without = (field: string) =>
    Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field))
  const malformed: Array<[string, unknown[]]> = [
    ["a missing key", [without("key")]],
    ["a key other than owner", [{ ...complete, key: "other" }]],
    ["a missing configurationVersion", [without("configurationVersion")]],
    ["a text configurationVersion", [{ ...complete, configurationVersion: "2" }]],
    ["a missing enabledModules", [without("enabledModules")]],
    ["enabledModules that is not a list", [{ ...complete, enabledModules: {} }]],
    [
      "an entry without configVersion",
      [{ ...complete, enabledModules: [{ moduleId: "redirects" }] }],
    ],
    [
      "an entry with a text configVersion",
      [{ ...complete, enabledModules: [{ moduleId: "redirects", configVersion: "1" }] }],
    ],
    [
      "an entry without moduleId",
      [{ ...complete, enabledModules: [{ configVersion: 1 }] }],
    ],
    [
      "an entry with an undeclared field",
      [
        {
          ...complete,
          enabledModules: [{ moduleId: "redirects", configVersion: 1, on: true }],
        },
      ],
    ],
    ["a non-object entry", [{ ...complete, enabledModules: ["redirects"] }]],
    ["an undeclared row field", [{ ...complete, enabled: true }]],
    ["a text _creationTime", [{ ...complete, _creationTime: "1" }]],
    ["a non-object row (list)", [[complete]]],
    ["a non-object row (number)", [5]],
    ["a non-object row (null)", [null]],
    ["a non-object row (text)", ["owner"]],
    ["two rows", [complete, complete]],
  ]

  it.each(malformed)(
    "(c) could not check, never passed, for a row with %s",
    (_case, stored) => {
      const outcome = check(() => ({
        ok: true,
        stdout: stored.map((row) => JSON.stringify(row)).join("\n"),
      }))
      expect(outcome.status).toBe("warning")
      expect(outcome.inconclusive).toBe(true)
      expect(outcome.message).toMatch(/^Could not check the modules/)
      expect(unknownStoredModuleIds(stored, new Set(knownIds))).toBeUndefined()
    }
  )

  it("accepts a complete row with or without the system fields", () => {
    for (const row of [complete, without("_id"), without("_creationTime")]) {
      expect(
        check(() => ({ ok: true, stdout: JSON.stringify(row) })).status
      ).toBe("passed")
    }
  })

  it("(c) says it could not check when the module list cannot be loaded", () => {
    const read = vi.fn(() => rows(["redirects"]))
    const outcome = checkStoredModuleIds({ root: site(), knownIds: undefined, read })
    expect(outcome.status).toBe("warning")
    expect(outcome.inconclusive).toBe(true)
    expect(outcome.message).toContain("lib/modules/catalog.generated.ts")
    expect(read).not.toHaveBeenCalled()
  })

  it("refuses to run in the source repository and in a folder inside it", () => {
    const source = site()
    mkdirSync(join(source, "scripts/starter"), { recursive: true })
    writeFileSync(join(source, SOURCE_REPOSITORY_MARKER), "{}")
    const nested = join(source, "apps/site")
    mkdirSync(nested, { recursive: true })

    for (const root of [source, nested]) {
      const read = vi.fn(() => rows([]))
      expect(check(read, root)).toEqual({
        status: "failed",
        message:
          "This folder is inside the formulacms source repository. The stored-module check reads a site's own backend, so it runs only in your site's folder. Run it there.",
      })
      expect(read).not.toHaveBeenCalled()
    }
  })

  it("lists each unknown id once, in stored order", () => {
    const entry = (moduleId: string) => ({ moduleId, configVersion: 1 })
    expect(
      unknownStoredModuleIds(
        [
          {
            key: "owner",
            configurationVersion: 4,
            enabledModules: ["owner-b", "redirects", "owner-a", "owner-b"].map(
              entry
            ),
          },
        ],
        new Set(knownIds)
      )
    ).toEqual(["owner-b", "owner-a"])
  })
})
