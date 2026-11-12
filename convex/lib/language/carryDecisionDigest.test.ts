import { describe, expect, test } from "vitest"
import type { Id } from "../../_generated/dataModel"
import {
  CARRY_DECISION_EMPTY_DIGEST,
  computeCarryDecisionEmptyDigest,
  digestCarryDecisionCorpus,
  type CarryDecisionDigestInput,
} from "./carryDecisionDigest"

function decision(
  values: Partial<CarryDecisionDigestInput> = {}
): CarryDecisionDigestInput {
  return {
    routeId: "route-a" as Id<"siteDefaultLanguageRoutes">,
    fromPath: "/legacy",
    outcome: "carry",
    capturedSourcePublicSetVersion: 1,
    capturedCarryInputVersion: 2,
    capturedCarryDecisionGeneration: 3,
    ...values,
  }
}

describe("M05 P24 canonical carry-decision digest", () => {
  test("the framed empty corpus has the frozen non-absent digest", async () => {
    expect(await computeCarryDecisionEmptyDigest()).toBe(
      CARRY_DECISION_EMPTY_DIGEST
    )
    expect(await digestCarryDecisionCorpus([])).toBe(
      CARRY_DECISION_EMPTY_DIGEST
    )
  })

  test("an unchanged corpus is stable and every authoritative field changes it", async () => {
    const base = [decision()]
    const digest = await digestCarryDecisionCorpus(base)
    expect(digest).toBe(
      "sha256:fb1d2e0dc2410ad6d347b78c30831bdd554ca362de1a0b8f3b8c3a1645fdb749"
    )
    expect(await digestCarryDecisionCorpus(base)).toBe(digest)
    const variants = [
      decision({
        routeId: "route-b" as Id<"siteDefaultLanguageRoutes">,
      }),
      decision({ fromPath: "/changed" }),
      decision({ outcome: "drop_locale" }),
      decision({ capturedSourcePublicSetVersion: 2 }),
      decision({ capturedCarryInputVersion: 3 }),
      decision({ capturedCarryDecisionGeneration: 4 }),
    ]
    for (const variant of variants) {
      expect(await digestCarryDecisionCorpus([variant])).not.toBe(digest)
    }
    expect(
      await digestCarryDecisionCorpus([
        decision({
          routeId: "route-東京" as Id<"siteDefaultLanguageRoutes">,
          fromPath: "/café/東京",
          outcome: "drop_duplicate",
          capturedSourcePublicSetVersion: 4,
          capturedCarryInputVersion: 5,
          capturedCarryDecisionGeneration: 6,
        }),
      ])
    ).toBe(
      "sha256:2b2461440cd268165ba3d68c8ca565e6e5aae0de53513d005397508ae3046605"
    )
  })

  test("framing, additions, removals and order are distinct", async () => {
    const a = decision({
      routeId: "ab" as Id<"siteDefaultLanguageRoutes">,
      fromPath: "/c",
    })
    const b = decision({
      routeId: "a" as Id<"siteDefaultLanguageRoutes">,
      fromPath: "b/c",
    })
    expect(await digestCarryDecisionCorpus([a])).not.toBe(
      await digestCarryDecisionCorpus([b])
    )
    const pair = [a, b]
    expect(await digestCarryDecisionCorpus(pair)).not.toBe(
      await digestCarryDecisionCorpus([a])
    )
    expect(await digestCarryDecisionCorpus(pair)).not.toBe(
      await digestCarryDecisionCorpus([b, a])
    )
  })
})
