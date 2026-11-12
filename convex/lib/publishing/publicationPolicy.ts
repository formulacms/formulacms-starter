import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx } from "../../_generated/server"
import { MODULE_CATALOG } from "../../../lib/modules/catalog"
import type { ModuleDescriptorV1 } from "../../../lib/modules/types"
import type { LocalePublicationCandidatePayload } from "./localeCandidate"

export const PUBLICATION_POLICY_SLOT = "publication.policy" as const

type Attribution = Doc<"pageLocalePublicationCandidates">["attribution"]

export type PublicationPolicyInput = Readonly<{
  pageId: Id<"pages">
  locale: string
  pageType: Doc<"pages">["pageType"]
  candidateId: Id<"pageLocalePublicationCandidates">
  candidateDigest: string
  releaseId: Id<"pageLocalePublicationReleases">
  sourceDraftGeneration: number
  sourceSharedDraftGeneration: number
  sourcePublicGeneration: number
  sourceLifecycleGeneration: number
  /** Reconstructed from the persisted immutable candidate. */
  payload: LocalePublicationCandidatePayload
  attribution: Attribution
  requestedAt: number
}>

export type PublicationPolicyResult = Readonly<{
  decision: "allow"
}>

export type PublicationPolicyParticipant = Readonly<{
  moduleId: string
  contribution: typeof PUBLICATION_POLICY_SLOT
  run: (
    ctx: MutationCtx,
    input: PublicationPolicyInput
  ) => Promise<PublicationPolicyResult>
}>

export type PublicationPolicyProfile = Readonly<
  Record<typeof PUBLICATION_POLICY_SLOT, PublicationPolicyParticipant | null>
>

/** Compose the single optional policy participant from static registrations. */
export function composePublicationPolicy(
  registrations: readonly PublicationPolicyParticipant[],
  catalog: readonly ModuleDescriptorV1[] = MODULE_CATALOG
): PublicationPolicyProfile {
  let participant: PublicationPolicyParticipant | null = null
  for (const registration of registrations) {
    const descriptor = catalog.find(
      (candidate) => candidate.id === registration.moduleId
    )
    if (
      registration.contribution !== PUBLICATION_POLICY_SLOT ||
      !descriptor ||
      descriptor.required ||
      !descriptor.contributions.includes(PUBLICATION_POLICY_SLOT)
    ) {
      throw new Error(
        `Module "${registration.moduleId}" cannot contribute "${registration.contribution}".`
      )
    }
    if (participant) {
      throw new Error("Publication policy slot already has a participant.")
    }
    participant = Object.freeze({ ...registration })
  }
  return Object.freeze({ [PUBLICATION_POLICY_SLOT]: participant })
}

/**
 * Community is a statically composed zero-participant policy profile. Team may
 * later register one separately reviewed participant without making its
 * storage or authority part of required Publication.
 */
export const INSTALLED_PUBLICATION_POLICY = composePublicationPolicy([])

const COMMUNITY_ALLOW_RESULT = Object.freeze({
  decision: "allow" as const,
})

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}

export async function runPublicationPolicy(
  ctx: MutationCtx,
  profile: PublicationPolicyProfile,
  input: PublicationPolicyInput
): Promise<PublicationPolicyResult> {
  const participant = profile[PUBLICATION_POLICY_SLOT]
  if (!participant) return COMMUNITY_ALLOW_RESULT
  const result = await participant.run(ctx, freezeDeep(input))
  if (!result || result.decision !== "allow") {
    throw new Error(
      `Publication policy participant "${participant.moduleId}" returned an invalid result.`
    )
  }
  return Object.freeze({ ...result })
}
