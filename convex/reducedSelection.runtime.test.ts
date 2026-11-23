/// <reference types="vite/client" />

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import {
  CONTENT_TYPES,
  isActiveContentType,
  REGISTERED_CONTENT_TYPES,
} from "./lib/contentTypes"
import { STARTER_CONTENT_TYPES } from "./lib/contentTypes/starterSelection"
import schema from "./schema"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")
const starterRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const releaseSelectionPath = join(starterRoot, "starter.selection.json")
const generatedStarter = existsSync(releaseSelectionPath)
const generatedTest = generatedStarter ? test : test.skip

/** The one durable Community owner; both identity fields are explicit. */
const OWNER = {
  subject: "reduced-selection-owner",
  tokenIdentifier: "reduced-selection-owner",
  email: "reduced-selection-owner@example.test",
}

describe("generated starter — reduced content-type selection", () => {
  generatedTest(
    "blocks inactive storage arms across the public route and renderer surfaces",
    async () => {
      const selected: readonly string[] = STARTER_CONTENT_TYPES
      expect(CONTENT_TYPES).toEqual(selected)

      const inactive = REGISTERED_CONTENT_TYPES.filter(
        (type) => !isActiveContentType(type)
      )
      expect(inactive).toEqual(
        REGISTERED_CONTENT_TYPES.filter((type) => !selected.includes(type))
      )
      expect(selected.every(isActiveContentType)).toBe(true)
      expect(
        readFileSync(
          join(starterRoot, "components/content-types/index.ts"),
          "utf8"
        )
      ).not.toContain('job: { kind: "blockBody", Component: JobRenderer }')

      const t = convexTest({
        schema,
        modules,
      })
      await seedCommunityOwner(t, OWNER)
      const asOwner = t.withIdentity(OWNER)
      const inactiveJobId = await t.run(async (ctx) => {
        const now = Date.now()
        return await ctx.db.insert("pages", {
          slug: "legacy-inactive-job",
          pageType: "job",
          status: "published",
          createdAt: now,
          updatedAt: now,
          department: "Private operations",
          remoteType: "remote",
          employmentType: "full-time",
          salaryCurrency: "USD",
          salaryMin: 0,
          salaryMax: 0,
          jobStatus: "open",
          content: { en: { title: "Legacy inactive job", blocks: [] } },
        })
      })

      await expect(
        t.query(api.cms.pages.getPublicPageById, {
          languageVersion: 0,
          id: inactiveJobId,
          locale: "en",
        })
      ).resolves.toBeNull()
      await expect(
        t.query(api.cms.pages.getPublicLocaleAlternates, {
          languageVersion: 0,
          pageId: inactiveJobId,
        })
      ).resolves.toEqual([])
      await expect(
        t.query(api.cms.pages.getLocalizedPathsByIds, {
          languageVersion: 0,
          ids: [inactiveJobId],
          locale: "en",
        })
      ).resolves.toEqual({})
      await expect(
        t.query(api.cms.pages.resolveLocalizedPathQuery, {
          languageVersion: 0,
          path: "/jobs/legacy-inactive-job",
          locale: "en",
        })
      ).resolves.toBeNull()
      await expect(
        t.query(api.cms.pages.getPublicRelationCardsByIds, {
          languageVersion: 0,
          ids: [inactiveJobId],
          locale: "en",
        })
      ).resolves.toEqual({ [inactiveJobId]: null })
      // No sitemap child lists the inactive arm, whatever the authority.
      const sitemapChild = await t.query(api.cms.pages.getSitemapChild, {
        languageVersion: 0,
        manifestVersion: 0,
        locale: "en",
        ordinal: 0,
      })
      expect(sitemapChild.status === "ok" ? sitemapChild.entries : []).toEqual(
        []
      )

      // The owner may still use protected raw reads for an explicit
      // migration, but no ordinary owner entry point may reopen the inactive
      // arm for editing, linking, or new authoring.
      await expect(
        asOwner.query(api.cms.pages.getForEdit, { id: inactiveJobId })
      ).resolves.toBeNull()
      await expect(
        asOwner.query(api.cms.relations.getReferenceCard, {
          id: inactiveJobId,
          locale: "en",
        })
      ).resolves.toBeNull()
      await expect(
        asOwner.mutation(api.cms.pages.create, {
          pageType: "job",
          status: "draft",
          title: "New inactive job",
        })
      ).rejects.toThrow(/not active in this starter/)
    }
  )
})
