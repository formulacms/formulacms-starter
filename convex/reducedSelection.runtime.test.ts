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
  tokenIdentifier: "https://convex.test|reduced-selection-owner",
  email: "reduced-selection-owner@example.test",
}

function releaseContentTypes(): string[] {
  const parsed = JSON.parse(readFileSync(releaseSelectionPath, "utf8")) as {
    contentTypes?: unknown
  }
  if (
    !Array.isArray(parsed.contentTypes) ||
    !parsed.contentTypes.every((type) => typeof type === "string")
  ) {
    throw new Error(
      "Generated starter release selection has no contentTypes array."
    )
  }
  return parsed.contentTypes
}

describe("generated starter — reduced content-type selection", () => {
  generatedTest(
    "blocks inactive storage arms across the public route and renderer surfaces",
    async () => {
      const selected = releaseContentTypes()
      expect(selected).toEqual(["landing-page", "page", "post", "author"])
      expect(CONTENT_TYPES).toEqual(selected)

      const inactive = REGISTERED_CONTENT_TYPES.filter(
        (type) => !isActiveContentType(type)
      )
      expect(inactive).toEqual(["testimonial", "job"])
      expect(
        readFileSync(
          join(starterRoot, "components/content-types/index.ts"),
          "utf8"
        )
      ).not.toContain('job: { kind: "sliceBody", Component: JobRenderer }')

      const t = convexTest(schema, modules)
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
          content: { en: { title: "Legacy inactive job", slices: [] } },
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
        asOwner.query(api.cms.pages.listByPageType, { pageType: "job" })
      ).resolves.toEqual([])
      await expect(
        asOwner.query(api.cms.relations.getReferenceCard, {
          id: inactiveJobId,
          locale: "en",
        })
      ).resolves.toBeNull()
      await expect(
        asOwner.mutation(api.cms.pages.update, {
          id: inactiveJobId,
          slug: "legacy-inactive-job-renamed",
        })
      ).rejects.toThrow(/not active in this starter/)
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
