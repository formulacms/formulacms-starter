// @vitest-environment node
/// <reference types="vite/client" />
import { expect, test } from "vitest"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
const modules = import.meta.glob("./**/*.ts")
test("real catalog: every public U1b ingress fails closed, including Start CMS_MODULE_DISABLED", async () => {
  const t = convexTest(schema, modules)
  const identity = {
    subject: "jobs-real-catalog",
    tokenIdentifier: "jobs-real-catalog",
  }
  await seedCommunityOwner(t, identity)
  const owner = t.withIdentity(identity)
  const pageId = await t.run((ctx) =>
    ctx.db.insert("pages", {
      pageType: "page",
      status: "draft",
      slug: "gate",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  )
  const id: Id<"aiJobs"> = await t.run((ctx) =>
    ctx.db.insert("aiJobs", {
      authId: identity.subject,
      kind: "write",
      title: "Test",
      locale: "en",
      pageId,
      tuple: {
        mode: "legacy",
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
      },
      draftGeneration: 1,
      state: "canceled",
      estimateMicros: 0,
      costMicros: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000,
    })
  )
  const input = {
    kind: "write" as const,
    brief: "Test",
    locale: "en" as const,
    meta: { title: "Test", slug: "test" },
    rows: [{ sliceType: "hero-with-image", purpose: "Intro" }],
  }
  const calls = [
    () => owner.query(api.cms.aiJobs.estimatePageJob, { input }),
    () => owner.mutation(api.cms.aiJobs.startPageJob, { input }),
    () => owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id }),
    () => owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id }),
    () => owner.query(api.cms.aiJobs.pageJobResult, { jobId: id }),
    () =>
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] }),
    () => owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id }),
  ]
  for (const call of calls)
    await expect(call()).rejects.toThrow("CMS_MODULE_DISABLED")
  // The job list answers empty instead of throwing (no error line in the log);
  // a caller who is not the owner is still refused.
  await expect(owner.query(api.cms.aiJobs.pageJobProgress, {})).resolves.toEqual(
    []
  )
  await expect(
    t.query(api.cms.aiJobs.pageJobProgress, {})
  ).rejects.toThrow()
})
