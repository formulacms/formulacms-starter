/// <reference types="vite/client" />

import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { convexTest } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "block-state-owner",
  tokenIdentifier: "block-state-owner",
}

function fixture() {
  return convexTest({ schema, modules, ownerIdentity: OWNER })
}

describe("app-local Block authoring state", () => {
  test("refuses unauthenticated and non-owner readers before returning contracts", async () => {
    const t = fixture()
    await expect(
      t.query(api.cms.blocks.getBlockAuthoringState, {})
    ).rejects.toThrow()
    const outsider = t.withIdentity({
      subject: "block-state-outsider",
      tokenIdentifier: "block-state-outsider",
    })
    await expect(
      outsider.query(api.cms.blocks.getBlockAuthoringState, {})
    ).rejects.toThrow()
  })

  test("returns unknown before site initialization", async () => {
    const t = fixture()
    expect(
      await t
        .withIdentity(OWNER)
        .query(api.cms.blocks.getBlockAuthoringState, {})
    ).toBeNull()
  })

  test("reports current contract/profile and retained archive metadata without writing", blockProfile(["hero-with-image"]), async () => {
    const t = fixture()
    const settingsId = await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "State fixture",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        archivedBlockTypes: ["hero-with-image", "retained-unknown-type"],
        updatedAt: 42,
      })
    )
    const before = await t.run((ctx) => ctx.db.get("siteSettings", settingsId))
    const state = await t
      .withIdentity(OWNER)
      .query(api.cms.blocks.getBlockAuthoringState, {})
    expect(state).not.toBeNull()
    if (!state) throw new Error("Expected initialized state")
    expect(state.settingsId).toBe(settingsId)
    expect(state.version).toBe("block-contract-state-v1")
    expect(state.registeredTypes).toContain("hero-with-image")
    expect(state.installedTypes).toContain("hero-with-image")
    expect(state.archivedTypes).toEqual([
      "hero-with-image",
      "retained-unknown-type",
    ])
    const contracts = JSON.parse(state.contracts)
    expect(
      contracts["hero-with-image"].primary.config.fields.title.config.contract
    ).toBe("title")
    expect(contracts["hero-with-image"].items.config.max).toBe(2)
    expect(contracts["hero-with-image"].validator.fields.type.value).toBe(
      "hero-with-image"
    )
    expect(
      await t.run((ctx) => ctx.db.get("siteSettings", settingsId))
    ).toEqual(before)
  })
})
