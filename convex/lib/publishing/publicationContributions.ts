import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx } from "../../_generated/server"
import { MODULE_CATALOG } from "../../../lib/modules/catalog"
import type { ModuleDescriptorV1 } from "../../../lib/modules/types"
import type { LocalePublicationCandidatePayload } from "./localeCandidate"

/**
 * F08b synchronous publication contribution slots (F08 contract, "Required
 * transaction and contribution boundaries").
 *
 * Publication runs `publication.history` and then `publication.index` as the
 * last step of every successor visibility transition, inside the same
 * mutation. A participant writes only its own tables and either returns or
 * throws. There is no catch, skip, fallback, or retry, so a throw rolls back
 * the whole transition. The dispatcher reads no module state: an empty slot
 * costs nothing. Gating a registered participant on owner enablement belongs
 * to its owning module, which must first close the open F07
 * load/initialize-failure recovery gate.
 */

export const PUBLICATION_CONTRIBUTION_SLOTS = [
  "publication.history",
  "publication.index",
] as const

export type PublicationContributionSlot =
  (typeof PUBLICATION_CONTRIBUTION_SLOTS)[number]

type Attribution = Doc<"pageLocalePublicationCandidates">["attribution"]

export type PublicationContributionEvent =
  | Readonly<{
      kind: "publish"
      pageId: Id<"pages">
      locale: string
      snapshotId: Id<"pagePublishedSnapshots">
      previousSnapshotId?: Id<"pagePublishedSnapshots">
      publicGeneration: number
      path: string | null
      previousPath?: string
      /** Reconstructed from the persisted immutable candidate. */
      payload: LocalePublicationCandidatePayload
      attribution: Attribution
      occurredAt: number
    }>
  | Readonly<{
      kind: "withdraw"
      pageId: Id<"pages">
      locale: string
      withdrawnSnapshotId: Id<"pagePublishedSnapshots">
      publicGeneration: number
      previousPath?: string
      attribution: Attribution
      occurredAt: number
    }>
  | Readonly<{
      kind: "lifecycle"
      pageId: Id<"pages">
      operation: "archive" | "restore" | "soft_delete" | "restore_soft_deleted"
      lifecycleGeneration: number
      locales: readonly string[]
      attribution: Attribution
      occurredAt: number
    }>

export type PublicationContributionParticipant = Readonly<{
  moduleId: string
  contribution: PublicationContributionSlot
  run: (ctx: MutationCtx, event: PublicationContributionEvent) => Promise<void>
}>

export type PublicationContributionProfile = Readonly<
  Record<PublicationContributionSlot, PublicationContributionParticipant | null>
>

/**
 * Composes static registrations into at most one participant per slot.
 * Publication is fixed-active and never contributes to itself, so only an
 * optional catalog module that declares the slot may own a participant.
 */
export function composePublicationContributions(
  registrations: readonly PublicationContributionParticipant[],
  catalog: readonly ModuleDescriptorV1[] = MODULE_CATALOG
): PublicationContributionProfile {
  const profile: Record<
    PublicationContributionSlot,
    PublicationContributionParticipant | null
  > = { "publication.history": null, "publication.index": null }
  for (const registration of registrations) {
    const descriptor = catalog.find(
      (candidate) => candidate.id === registration.moduleId
    )
    if (
      !PUBLICATION_CONTRIBUTION_SLOTS.includes(registration.contribution) ||
      !descriptor ||
      descriptor.required ||
      !descriptor.contributions.includes(registration.contribution)
    ) {
      throw new Error(
        `Module "${registration.moduleId}" cannot contribute "${registration.contribution}".`
      )
    }
    if (profile[registration.contribution]) {
      throw new Error(
        `Publication slot "${registration.contribution}" already has a participant.`
      )
    }
    profile[registration.contribution] = Object.freeze({ ...registration })
  }
  return Object.freeze(profile)
}

/**
 * The installed Community catalog has no History (M06) or Search (M04)
 * module, so both slots are empty. A first registration also waits on the
 * F07 recovery gate.
 */
export const INSTALLED_PUBLICATION_CONTRIBUTIONS =
  composePublicationContributions([])

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}

export async function runPublicationContributions(
  ctx: MutationCtx,
  profile: PublicationContributionProfile,
  event: PublicationContributionEvent
): Promise<void> {
  if (!profile["publication.history"] && !profile["publication.index"]) return
  const frozen = freezeDeep(event)
  for (const slot of PUBLICATION_CONTRIBUTION_SLOTS) {
    const participant = profile[slot]
    if (participant) await participant.run(ctx, frozen)
  }
}
