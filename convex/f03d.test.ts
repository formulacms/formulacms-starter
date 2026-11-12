/// <reference types="vite/client" />

import { readdir, readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")

const owner = {
  subject: "f03d-owner",
  tokenIdentifier: "https://issuer.test|f03d-owner",
  email: "owner@example.test",
}
const editor = {
  subject: "f03d-editor",
  tokenIdentifier: "https://issuer.test|f03d-editor",
  email: "editor@example.test",
}

const sorted = (names: Iterable<string>) => [...names].sort()

/** Module keys declared in the generated `fullApi` map. */
function declaredFullApiModules(generated: string): Set<string> {
  const start = generated.indexOf("declare const fullApi")
  const block = generated.slice(start, generated.indexOf("}>;", start))
  return new Set(
    [...block.matchAll(/^\s*"?([\w/.-]+)"?:\s*typeof/gm)].map(
      (match) => match[1]!
    )
  )
}

/**
 * Enumerate the modules Convex would register, offline. This mirrors the CLI's
 * entry-point filter rather than guessing: `_generated` and `_deps` are
 * skipped, so are dot/hash-prefixed names, `schema.ts`, and any basename
 * carrying more than one dot (`auth.config.ts`, `convex.config.ts`,
 * `*.test.ts`, `*.testFixtures.ts`).
 */
async function registeredModulesOnDisk(
  root: string,
  prefix = ""
): Promise<Set<string>> {
  const modules = new Set<string>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const { name } = entry
    if (name.startsWith(".") || name.startsWith("#")) continue
    if (entry.isDirectory()) {
      if (name === "_generated" || name === "_deps") continue
      for (const nested of await registeredModulesOnDisk(
        `${root}/${name}`,
        `${prefix}${name}/`
      )) {
        modules.add(nested)
      }
      continue
    }
    if (!name.endsWith(".ts")) continue
    if (name === "schema.ts") continue
    if ((name.match(/\./g) ?? []).length > 1) continue
    modules.add(`${prefix}${name.slice(0, -".ts".length)}`)
  }
  return modules
}

describe("F03d fixture and generated-reference reconciliation", () => {
  test("explicit owner fixtures bind both authId and tokenIdentifier exactly once", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, owner)

    const rows = await t.run((ctx) => ctx.db.query("cmsOwner").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: "owner",
      authId: owner.subject,
      tokenIdentifier: owner.tokenIdentifier,
    })

    await expect(
      t.withIdentity(owner).query(api.cms.owner.getOwnerSession, {})
    ).resolves.toMatchObject({ authId: owner.subject, role: "admin" })
    await expect(
      t.withIdentity(editor).query(api.cms.owner.getOwnerSession, {})
    ).resolves.toBeNull()
    // Both half-match directions are rejected, not just the first one: the
    // owner authId with a foreign token, and the owner token with a foreign
    // authId. `getOwnerSession` sanitizes both to CMS_OWNER_UNAVAILABLE.
    await expect(
      t
        .withIdentity({
          ...owner,
          tokenIdentifier: "https://issuer.test|wrong-token",
        })
        .query(api.cms.owner.getOwnerSession, {})
    ).rejects.toThrow("CMS_OWNER_UNAVAILABLE")
    await expect(
      t
        .withIdentity({ ...owner, subject: "f03d-wrong-auth-id" })
        .query(api.cms.owner.getOwnerSession, {})
    ).rejects.toThrow("CMS_OWNER_UNAVAILABLE")

    // The ordinary operation seam surfaces the unsanitized binding error for
    // the same two directions.
    for (const halfMatch of [
      { ...owner, tokenIdentifier: "https://issuer.test|wrong-token" },
      { ...owner, subject: "f03d-wrong-auth-id" },
    ]) {
      await expect(
        t.withIdentity(halfMatch).query(api.cms.pages.listPaginated, {
          paginationOpts: { numItems: 1, cursor: null },
        })
      ).rejects.toThrow("CMS_OWNER_BINDING_INVALID")
    }
  })

  test("a first non-owner wrapper identity cannot claim Community ownership", async () => {
    const t = convexTest(schema, modules)
    const asEditor = t.withIdentity(editor)

    await expect(
      asEditor.query(api.cms.owner.getOwnerSession, {})
    ).resolves.toBeNull()
    await expect(
      asEditor.query(api.cms.pages.listPaginated, {
        paginationOpts: { numItems: 1, cursor: null },
      })
    ).rejects.toThrow("CMS_OWNER_NOT_ESTABLISHED")

    await expect(
      t.run((ctx) => ctx.db.query("cmsOwner").collect())
    ).resolves.toHaveLength(0)
  })

  test("the generated API contract enumerates every registered module", async () => {
    const generated = await readFile("convex/_generated/api.d.ts", "utf8")
    const declared = declaredFullApiModules(generated)
    const onDisk = await registeredModulesOnDisk("convex")

    // Both drift directions, so a future added/removed module fails here
    // instead of silently diverging from the committed contract.
    expect(sorted(onDisk).filter((name) => !declared.has(name))).toEqual([])
    expect(sorted(declared).filter((name) => !onDisk.has(name))).toEqual([])
    expect(declared.size).toBe(onDisk.size)

    // F01's owner modules are part of that set, named explicitly so the
    // reconciliation reads as intent rather than an incidental count.
    expect(declared.has("cms/owner")).toBe(true)
    expect(declared.has("lib/access/owner")).toBe(true)
    expect(declared.has("lib/access/policy")).toBe(true)
  })
})
