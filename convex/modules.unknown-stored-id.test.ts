/// <reference types="vite/client" />

import { convexTestWithAuth as convexTest } from "../test-utils/convexAuthFixtures"
import { describe, expect, test } from "vitest"
import { MODULE_CATALOG } from "../lib/modules/catalog"
import { api } from "./_generated/api"
import { readModuleState, resolveEffectiveModuleState } from "./lib/modules/state"
import schema from "./schema"

/*
 * Reproduction for the integrity ledger item I9 (2026-11-18). An owner adds
 * an id to the generated catalog by hand and enables it; the upgrade
 * restores the generated file. One unknown stored id then makes
 * validatePersistedModuleState (convex/lib/modules/state.ts:86-97) fail
 * closed for the WHOLE module state: known modules, required modules and the
 * public redirect lookup all refuse. The upgrade preflight
 * (scripts/lib/stored-module-state.ts) names the id before this happens.
 */

const modules = import.meta.glob("./**/*.ts")

async function storedState(enabledModules: string[]) {
  const t = convexTest(schema, modules)
  await t.run((ctx) =>
    ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 3,
      enabledModules: enabledModules.map((moduleId) => ({
        moduleId,
        configVersion: 1,
      })),
    })
  )
  return t
}

describe("an unknown stored module id after an upgrade", () => {
  test("the same state without the unknown id is read normally", async () => {
    const t = await storedState(["redirects"])
    const state = await t.run(async (ctx) => {
      const { enabledModuleIds } = await readModuleState(ctx)
      return [...enabledModuleIds]
    })
    expect(state).toEqual(["redirects"])
  })

  test("fails closed for the whole module state, known modules included", async () => {
    expect(MODULE_CATALOG.map(({ id }) => id)).not.toContain("owner-blog")
    const t = await storedState(["redirects", "owner-blog"])

    await expect(t.run((ctx) => readModuleState(ctx))).rejects.toThrow(
      "CMS_MODULE_STATE_INVALID"
    )
    // No partial answer: not even required modules resolve.
    await expect(
      t.run((ctx) => resolveEffectiveModuleState(ctx))
    ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
    // The public site's redirect lookup refuses too.
    await expect(
      t.query(api.cms.redirects.resolve, { languageVersion: 0, path: "/old" })
    ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
  })

  test("one unknown id alone also stops the whole state", async () => {
    const t = await storedState(["owner-blog"])
    await expect(
      t.run((ctx) => resolveEffectiveModuleState(ctx))
    ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
  })
})
