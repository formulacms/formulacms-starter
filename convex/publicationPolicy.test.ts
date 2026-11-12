/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import type { ModuleDescriptorV1 } from "../lib/modules/types"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import type {
  PublicationPolicyInput,
  PublicationPolicyParticipant,
  PublicationPolicyResult,
} from "./lib/publishing/publicationPolicy"
import publicationSource from "./cms/publication.ts?raw"
import policySource from "./lib/publishing/publicationPolicy.ts?raw"

type PolicyRun = PublicationPolicyParticipant["run"]

const policy = vi.hoisted(() => ({
  run: null as PolicyRun | null,
}))

vi.mock("./lib/publishing/publicationPolicy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/publishing/publicationPolicy")>()
  return {
    ...actual,
    INSTALLED_PUBLICATION_POLICY: {
      get "publication.policy"() {
        return policy.run
          ? {
              moduleId: "team",
              contribution: "publication.policy",
              run: policy.run,
            }
          : null
      },
    },
  }
})

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f08-policy-owner",
  tokenIdentifier: "https://convex.test|f08-policy-owner",
}

function app() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
}

type TestApp = ReturnType<typeof app>
type Owner = ReturnType<TestApp["withIdentity"]>

async function activeFixture() {
  const t = app()
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "policy-page",
    title: "Policy page",
    content: { en: { title: "Policy page", slices: [] } },
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Policy test",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId,
      updatedAt: Date.now(),
    })
  )
  return { t, owner, pageId }
}

function publish(owner: Owner, pageId: Id<"pages">) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 1,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
}

const PUBLICATION_TABLES = [
  "pagePublicationPageStates",
  "pageSharedDrafts",
  "pageLocaleDrafts",
  "pageLocalePublicationStates",
  "pageLocalePublicationCandidates",
  "pageLocalePublicationReleases",
  "pagePublishedSnapshots",
  "pagePublicationDocumentReferences",
  "pagePublicationMediaReferences",
  "pagePublicationSliceReferences",
  "pageHistoricalLocaleRoutes",
  "pagePublicationRevalidationIntents",
] as const

function dumpPublicationState(t: TestApp) {
  return t.run(async (ctx) => {
    const dump: Record<string, unknown[]> = {}
    for (const table of PUBLICATION_TABLES) {
      dump[table] = await ctx.db.query(table).collect()
    }
    return dump
  })
}

function descriptor(
  id: string,
  required: boolean,
  contributions: ModuleDescriptorV1["contributions"]
): ModuleDescriptorV1 {
  return {
    id,
    name: id,
    summary: id,
    descriptorVersion: 1,
    configVersion: 1,
    required,
    dependencies: [],
    environments: ["server"],
    contributions,
  }
}

beforeEach(() => {
  policy.run = null
})

describe("F08 publication policy composition", () => {
  test("Community statically composes one frozen empty policy slot", async () => {
    const actual = await vi.importActual<
      typeof import("./lib/publishing/publicationPolicy")
    >("./lib/publishing/publicationPolicy")
    expect(actual.INSTALLED_PUBLICATION_POLICY).toEqual({
      "publication.policy": null,
    })
    expect(Object.isFrozen(actual.INSTALLED_PUBLICATION_POLICY)).toBe(true)

    const run: PolicyRun = async () => ({ decision: "allow" })
    const catalog = [
      descriptor("publication", true, []),
      descriptor("team", false, ["publication.policy"]),
      descriptor("redirects", false, ["public.routing"]),
    ]
    const participant = {
      moduleId: "team",
      contribution: "publication.policy",
      run,
    } as const
    const profile = actual.composePublicationPolicy([participant], catalog)
    expect(profile["publication.policy"]).toMatchObject({ moduleId: "team" })
    expect(Object.isFrozen(profile)).toBe(true)

    for (const invalid of [
      { ...participant, moduleId: "unknown" },
      { ...participant, moduleId: "publication" },
      { ...participant, moduleId: "redirects" },
      { ...participant, contribution: "publication.history" },
    ]) {
      expect(() =>
        actual.composePublicationPolicy(
          [invalid as unknown as PublicationPolicyParticipant],
          catalog
        )
      ).toThrow("cannot contribute")
    }
    expect(() =>
      actual.composePublicationPolicy([participant, participant], catalog)
    ).toThrow("already has a participant")
  })

  test("the real Community command allows publication without reading Team policy storage", async () => {
    const { t, owner, pageId } = await activeFixture()
    await expect(publish(owner, pageId)).resolves.toMatchObject({
      pageId,
      locale: "en",
      publicGeneration: 1,
    })
    expect(policySource).toContain(
      "INSTALLED_PUBLICATION_POLICY = composePublicationPolicy([])"
    )
    expect(policySource).not.toMatch(
      /ctx\.db\.|teamPublishing|teamReview|membership|entitlement|capacity/i
    )
    const publishBody = publicationSource.slice(
      publicationSource.indexOf("export const publishLocale = mutation"),
      publicationSource.indexOf("export const withdrawLocale = mutation")
    )
    expect(publishBody).not.toMatch(
      /teamPublishing|teamReview|cmsMembership|entitlement|capacity/
    )
    expect(
      await t.run((ctx) => ctx.db.query("teamPublishingPolicies").collect())
    ).toEqual([])
    expect(
      await t.run((ctx) => ctx.db.query("teamReviewRounds").collect())
    ).toEqual([])
  })

  test("a participant receives the frozen persisted candidate projection through the real command", async () => {
    const { t, owner, pageId } = await activeFixture()
    const seen: Array<{
      input: PublicationPolicyInput
      candidateExists: boolean
      releaseExists: boolean
      tamperRejected: boolean
    }> = []
    policy.run = async (ctx, input): Promise<PublicationPolicyResult> => {
      let tamperRejected = false
      try {
        ;(input.payload.localized as { slug: string }).slug = "tampered"
      } catch {
        tamperRejected = true
      }
      seen.push({
        input,
        candidateExists: (await ctx.db.get(input.candidateId)) !== null,
        releaseExists: (await ctx.db.get(input.releaseId)) !== null,
        tamperRejected,
      })
      return { decision: "allow" }
    }

    const result = await publish(owner, pageId)
    const candidate = await t.run((ctx) => ctx.db.get(result.candidateId))
    const release = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationReleases")
        .withIndex("by_candidateId", (q) =>
          q.eq("candidateId", result.candidateId)
        )
        .unique()
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      candidateExists: true,
      releaseExists: true,
      tamperRejected: true,
      input: {
        pageId,
        locale: "en",
        pageType: "landing-page",
        candidateId: result.candidateId,
        candidateDigest: candidate?.digest,
        releaseId: release?._id,
        sourceDraftGeneration: 1,
        sourceSharedDraftGeneration: 1,
        sourcePublicGeneration: 0,
        sourceLifecycleGeneration: 1,
        requestedAt: result.publishedAt,
      },
    })
    expect(seen[0]!.input.payload).toEqual(JSON.parse(candidate!.payloadJson))
  })

  test("a policy failure rolls back candidate, release, references, and public selection", async () => {
    const { t, owner, pageId } = await activeFixture()
    const before = await dumpPublicationState(t)
    policy.run = async () => {
      throw new Error("PUBLICATION_POLICY_REJECTED")
    }
    await expect(publish(owner, pageId)).rejects.toThrow(
      "PUBLICATION_POLICY_REJECTED"
    )
    expect(await dumpPublicationState(t)).toEqual(before)
  })
})
