import { runToCompletion } from "@convex-dev/migrations"
import { components, internal } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { MutationCtx } from "@/convex/_generated/server"

type Runnable = {
  run<T>(fn: (ctx: MutationCtx) => Promise<T>): Promise<T>
}

/**
 * Permanent media delete refuses until the rich-text image backfill has
 * finished (`MEDIA_USAGE_INDEX_PENDING`). Tests that need a delete to go
 * through run it to completion first. The test must have registered the
 * migrations component (`@convex-dev/migrations/test`).
 */
export async function finishMediaUsageBackfill(t: Runnable): Promise<void> {
  const series = [
    internal.lib.media.richTextBackfill.backfillRichTextImagesShared,
    internal.lib.media.richTextBackfill.backfillRichTextImagesDrafts,
    internal.lib.media.richTextBackfill.backfillRichTextImagesCandidates,
    internal.lib.media.richTextBackfill.backfillRichTextImagesSnapshots,
  ]
  for (const fnRef of series) {
    await t.run((ctx) =>
      runToCompletion(
        ctx as unknown as Parameters<typeof runToCompletion>[0],
        components.migrations,
        fnRef
      )
    )
  }
}

/** Put a media row in Trash directly (a used file cannot be trashed through the API). */
export async function trashMediaDirectly(
  t: Runnable,
  id: Id<"media">
): Promise<void> {
  await t.run((ctx) => ctx.db.patch("media", id, { deletedAt: Date.now() }))
}
