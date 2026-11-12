import type { TestConvex } from "convex-test"
import { expect } from "vitest"
import { api } from "./convex/_generated/api"
import type appSchema from "./convex/schema"

type OwnerActor = ReturnType<TestConvex<typeof appSchema>["withIdentity"]>

/**
 * Enables the optional Redirects module the way an owner does: one real F07
 * `cms.modules.commit` from the fresh-install configuration. Suites that call
 * the guarded `cms.redirects` entries use this instead of writing module state.
 */
export async function enableRedirectsForTest(owner: OwnerActor): Promise<void> {
  const result = await owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: 0,
    changes: [{ moduleId: "redirects", enabled: true }],
  })
  expect(result).toMatchObject({ committed: true, configurationVersion: 1 })
}
