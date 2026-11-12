import type { Doc, Id } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"

export type EditionPublishApproval = { kind: "community" }

export type EditionScheduledPublishCheck =
  | {
      ok: true
      approval: EditionPublishApproval
    }
  | {
      ok: false
      reason: string
    }

export function assertEditionCanCreatePublished(
  requestedStatus: Doc<"pages">["status"]
): void {
  void requestedStatus
}

export async function recordEditionDraftEdit(
  ctx: MutationCtx,
  args: { pageId: Id<"pages">; actorId: string }
): Promise<void> {
  void ctx
  void args
}

export async function recordEditionDraftDiscard(
  ctx: MutationCtx,
  args: { pageId: Id<"pages">; actorId: string }
): Promise<void> {
  void ctx
  void args
}

export async function assertEditionReviewAllowsLifecycleChange(
  ctx: MutationCtx,
  pageId: Id<"pages">
): Promise<void> {
  void ctx
  void pageId
}

export async function canEditionSweepStaging(
  ctx: MutationCtx,
  pageId: Id<"pages">
): Promise<boolean> {
  void ctx
  void pageId
  return true
}

export async function assertEditionCanPublish(
  ctx: MutationCtx,
  args: { page: Doc<"pages">; staging: Doc<"pageStaging"> }
): Promise<EditionPublishApproval> {
  void ctx
  void args
  return { kind: "community" }
}

export async function checkEditionScheduledPublish(
  ctx: MutationCtx,
  args: { page: Doc<"pages">; staging: Doc<"pageStaging"> }
): Promise<EditionScheduledPublishCheck> {
  void ctx
  void args
  return { ok: true, approval: { kind: "community" } }
}

export async function recordEditionScheduledPublishRejected(
  ctx: MutationCtx,
  args: { pageId: Id<"pages">; reason: string }
): Promise<void> {
  void ctx
  void args
}

export async function recordEditionPublished(
  ctx: MutationCtx,
  args: {
    pageId: Id<"pages">
    approval: EditionPublishApproval
    actorId?: string
    origin: "interactive" | "scheduled"
  }
): Promise<void> {
  void ctx
  void args
}
