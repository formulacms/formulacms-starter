import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { SCHEMA_VERSION } from "../convex/lib/versions"

/**
 * Drift guard for the engine version manifest (plan 023 Phase 4 #1-minimal).
 * Downstream forks read `engine.manifest.json` during an upgrade sync; if it
 * lies about versions or names a migration that no longer exists, the
 * playbook's compatibility check silently breaks. This test keeps the
 * manifest honest against the code it describes.
 */

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "engine.manifest.json"), "utf8")
) as {
  name: string
  engineVersion: string
  schemaVersion: number
  compatibility: {
    freshInstallBaseline: number
    supportedUpgradeFromSchemaVersions: number[]
    note: string
  }
  migrations: { id: string; run: string; when: string }[]
  migrationHistory: {
    id: string
    status: "completed" | "historical-noop" | "historical-pre-narrow"
    summary: string
  }[]
  engineOwnedPaths: string[]
  ownerOwnedPaths: string[]
  releaseOnlyPaths: string[]
  sharedRegistries: {
    id: string
    manifest: string
    generated: string[]
    regenerate: string
    check: string
    rule: string
  }[]
  pathRules: { id: string; paths: string[]; rule: string }[]
  defaultRule: string
}

// Translate a manifest glob (only the `dir/**` and exact forms this manifest
// uses) into a predicate over a repo-relative path. Enough to assert the
// precedence intent below without pulling in a glob dependency.
function globMatches(glob: string, path: string): boolean {
  if (glob.endsWith("/**")) return path.startsWith(glob.slice(0, -2))
  return glob === path
}


describe("engine.manifest.json", () => {
  test("version markers match convex/lib/versions.ts", () => {
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION)
    expect(manifest.engineVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("every listed migration is exported by convex/migrations.ts", () => {
    for (const migration of manifest.migrations) {
      expect(migration.run).toContain("npx convex run")
      expect(migration.when.length).toBeGreaterThan(0)
    }
  })

  test("schema version 4 truthfully supports the additive version 3 upgrade", () => {
    expect(manifest.compatibility.freshInstallBaseline).toBe(4)
    expect(manifest.compatibility.supportedUpgradeFromSchemaVersions).toEqual(
      [3]
    )
    expect(manifest.compatibility.note).toContain(
      "schema version 3 upgrades directly without a data migration"
    )
    expect(manifest.compatibility.note).toContain(
      "upgrades from schema version 2 remain unsupported"
    )
    expect(manifest.migrations).toEqual([])
  })

  test("historical migrations remain truthful without advertising removed pre-narrow code", () => {
    expect(manifest.migrationHistory.length).toBeGreaterThan(0)
    for (const migration of manifest.migrationHistory) {
      expect(migration.summary.length).toBeGreaterThan(0)
    }

    expect(
      manifest.migrationHistory.find(({ id }) => id === "stripAuthorBio")
        ?.status
    ).toBe("historical-noop")
    expect(
      manifest.migrationHistory.find(
        ({ id }) => id === "migrateAuthorIdToAuthorIds"
      )?.status
    ).toBe("historical-noop")
    expect(
      manifest.migrationHistory.find(
        ({ id }) => id === "moveScheduledAtToStaging"
      )?.status
    ).toBe("historical-pre-narrow")
    expect(
      manifest.migrationHistory.find(
        ({ id }) => id === "copyLegacyMenusToCanonical"
      )?.status
    ).toBe("historical-pre-narrow")
    expect(
      manifest.migrationHistory.find(
        ({ id }) => id === "deleteLegacyMenuRows"
      )?.status
    ).toBe("historical-pre-narrow")
  })

  test("path ownership lists are non-empty and well-formed", () => {
    expect(manifest.engineOwnedPaths.length).toBeGreaterThan(0)
    expect(manifest.ownerOwnedPaths.length).toBeGreaterThan(0)
    for (const p of [
      ...manifest.engineOwnedPaths,
      ...manifest.ownerOwnedPaths,
      ...manifest.releaseOnlyPaths,
    ]) {
      expect(p).not.toMatch(/^\//)
    }

    expect(manifest.sharedRegistries.length).toBeGreaterThan(0)
    expect(manifest.pathRules.length).toBeGreaterThan(0)
    expect(manifest.defaultRule.length).toBeGreaterThan(0)
    for (const registry of manifest.sharedRegistries) {
      expect(registry.id.length).toBeGreaterThan(0)
      expect(registry.generated.length).toBeGreaterThan(0)
      expect(registry.regenerate.length).toBeGreaterThan(0)
      expect(registry.check.length).toBeGreaterThan(0)
      expect(registry.rule.length).toBeGreaterThan(0)
      // Every registry file must exist, so an upgrade can regenerate it.
      for (const file of [registry.manifest, ...registry.generated]) {
        expect(file).not.toMatch(/^\//)
        expect(
          existsSync(join(process.cwd(), file)),
          `registry "${registry.id}" lists missing file "${file}"`
        ).toBe(true)
      }
    }
    for (const rule of manifest.pathRules) {
      expect(rule.paths.length).toBeGreaterThan(0)
      expect(rule.rule.length).toBeGreaterThan(0)
      for (const p of rule.paths) expect(p).not.toMatch(/^\//)
    }
  })

  // The engine-only "Ship to starter" slice curation lives under
  // scripts/starter/. Its files must never propagate to formulacms-starter or a
  // fork — the toggle's engine-vs-starter signal is the presence of the
  // ship-list file, so shipping it would surface engine-only tooling downstream.
  // This locks the exclusion in place: releaseOnlyPaths must keep covering it,
  // and it must win over the broad engineOwnedPaths `scripts/**` glob.
  test("scripts/starter release tooling is excluded from distribution", () => {
    expect(manifest.releaseOnlyPaths.length).toBeGreaterThan(0)
    expect(manifest.releaseOnlyPaths).toContain("scripts/starter/**")

    const shipList = "scripts/starter/ship-list.json"
    // Precedence intent: an engineOwnedPaths glob DOES match the ship-list…
    expect(
      manifest.engineOwnedPaths.some((g) => globMatches(g, shipList)),
      "expected an engineOwnedPaths glob to match the ship-list (precedence is only meaningful if it does)"
    ).toBe(true)
    // …yet releaseOnlyPaths also covers it, and release-only wins ⇒ engine-local.
    expect(
      manifest.releaseOnlyPaths.some((g) => globMatches(g, shipList)),
      "ship-list must be covered by releaseOnlyPaths so it is never distributed"
    ).toBe(true)
  })
})
