/// <reference types="vite/client" />

import { blockProfile } from "@/test-utils/block-profile"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { resolveBlockPresentation } from "./lib/blocks/presentationResolution"

// A third owned data entry must reach the real query's return validator. This
// test executes no new renderer and claims no source-acceptance qualification.
vi.mock("./lib/blocks/heroPresentationDefinitions", async (original) => {
  const actual =
    await original<typeof import("./lib/blocks/heroPresentationDefinitions")>()
  return {
    ...actual,
    HERO_PRESENTATION_DEFINITIONS: [
      ...actual.HERO_PRESENTATION_DEFINITIONS,
      {
        ...actual.HERO_PRESENTATION_DEFINITIONS[1],
        id: "wide-test",
        label: "Wide test",
        rendererSource:
          "components/blocks/presentations/hero-with-image-wide-test.tsx",
        exportName: "HeroWithImageWideTest",
      },
    ],
  }
})

const modules = import.meta.glob("./**/*.ts")
const owner = {
  subject: "presentation-expansion-owner",
  tokenIdentifier: "presentation-expansion-owner",
  email: "owner@example.test",
}

describe("owned presentation catalog query expansion", () => {
  test("returns a third owned ID through normal authorization and its finite validator", blockProfile(["hero-with-image"]), async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert("cmsOwner", {
        key: "owner",
        authId: owner.subject,
        tokenIdentifier: owner.tokenIdentifier,
        establishedAt: 1,
        updatedAt: 1,
      })
    )
    await expect(
      t.query(api.cms.blocks.getPresentationCatalog, {})
    ).rejects.toThrow("UNAUTHENTICATED")
    const catalog = await t
      .withIdentity(owner)
      .query(api.cms.blocks.getPresentationCatalog, {})
    expect(
      catalog.entries
        .filter(({ type }) => type === "hero-with-image")
        .map(({ id }) => id)
    ).toEqual(["default", "centered", "wide-test"])
    expect(
      resolveBlockPresentation(catalog, {
        type: "hero-with-image",
        intent: "new-assignment",
        presentationId: "wide-test",
        expectedCatalogRevision: catalog.revision,
      })
    ).toMatchObject({
      status: "resolved",
      resolvedId: "wide-test",
      renderable: true,
      newAssignable: true,
    })
    expect(
      resolveBlockPresentation(catalog, {
        type: "hero-with-image",
        intent: "new-assignment",
        presentationId: "unknown-test",
        expectedCatalogRevision: catalog.revision,
      })
    ).toMatchObject({ status: "refused", reason: "presentation-missing" })
  })
})
