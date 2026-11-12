import { extractAuthorResult } from "./authoring/author-result"
import type { SliceVerificationScenario } from "./verification"

const MODEL_ID = "deterministic-verification-fixture"

export const SLICE_VERIFICATION_DISPOSABLE_TYPE =
  "verification-disposable" as const

export const SLICE_VERIFICATION_DISPOSABLE_SPEC_JSON = JSON.stringify({
  type: SLICE_VERIFICATION_DISPOSABLE_TYPE,
  label: "Verification disposable",
  description:
    "Disposable Slice Type used only by the local lifecycle verification harness.",
  icon: "TestTube2",
  group: "misc",
  primary: {
    kind: "group",
    fields: {
      title: {
        kind: "text",
        config: { placeholder: "Disposable verification fixture" },
      },
    },
  },
  aiHint: {
    purpose: "Render one disposable verification heading.",
    fields: ["Return [title]Disposable verification fixture[/title]."],
  },
})

const DECOMPOSITION = [
  {
    slug: "existing-body",
    purpose: "Reuse the existing rich-text article body contract.",
    order: 0,
    triage: { decision: "reuse", type: "rich-text-body" },
  },
  {
    slug: "structural-hero-sibling",
    purpose: "Author a structurally distinct hero sibling.",
    order: 1,
    triage: { decision: "new-sibling", family: "hero" },
  },
  {
    slug: "standalone-proof-points",
    purpose: "Author one independently placeable proof-points section.",
    order: 2,
    triage: { decision: "new-slice" },
  },
  {
    slug: "site-header",
    purpose: "Keep shared site navigation in the application shell.",
    order: 3,
    triage: { decision: "app-shell" },
  },
]

export type SliceVerificationProposal = {
  proposal: string
  specJson: string | null
  decomposition: ReturnType<typeof parseDecomposition> | null
  modelId: string
}

function parseDecomposition() {
  const parsed = extractAuthorResult(
    "```json\n" + JSON.stringify({ sections: DECOMPOSITION }) + "\n```"
  )
  if (parsed?.kind !== "decomposition")
    throw new Error("Invalid verification decomposition fixture.")
  return parsed.sections
}

export function getSliceVerificationProposal(
  scenario: SliceVerificationScenario
): SliceVerificationProposal {
  if (scenario === "decomposition") {
    return {
      proposal: "Deterministic page decomposition fixture.",
      specJson: null,
      decomposition: parseDecomposition(),
      modelId: MODEL_ID,
    }
  }
  if (scenario === "proposal" || scenario === "renderer-failure") {
    return {
      proposal: "Deterministic disposable SliceSpec fixture.",
      specJson: SLICE_VERIFICATION_DISPOSABLE_SPEC_JSON,
      decomposition: null,
      modelId: MODEL_ID,
    }
  }
  throw new Error(`Scenario "${scenario}" has no authoring proposal fixture.`)
}

export function getSliceVerificationRenderer(
  scenario: SliceVerificationScenario
): { proposal: string; rendererBody: string | null; modelId: string } {
  if (scenario !== "renderer-failure") {
    throw new Error(`Scenario "${scenario}" has no renderer fixture.`)
  }
  return {
    proposal: "Deterministic renderer failure fixture.",
    rendererBody: null,
    modelId: MODEL_ID,
  }
}
