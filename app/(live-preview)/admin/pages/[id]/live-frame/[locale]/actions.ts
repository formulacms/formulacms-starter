"use server"

import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { Block } from "@/convex/lib/blocks"
import { fetchAuthQuery } from "@/lib/auth/server"
import { buildBlockRenderContext } from "@/lib/blocks/render-context"
import { collectImageStorageIds } from "@/lib/blocks/media-urls"
import { readInIdGroups } from "@/lib/cms/batched-read"
import { supportsLivePreviewFrame } from "@/components/admin/live-preview-page-type"
import {
  validLiveFrameInput,
  type LiveFrameInput,
} from "@/components/admin/live-preview-frame-bridge"

/** Read dependencies only when the reference/media ID sets change. No draft write. */
export async function resolveLiveFrameContext(input: LiveFrameInput) {
  if (!validLiveFrameInput(input)) return null
  const [view, config] = await Promise.all([
    fetchAuthQuery(api.cms.pages.getForEdit, {
      id: input.pageId as Id<"pages">,
    }),
    fetchAuthQuery(api.cms.settings.getSiteConfig, {}),
  ])
  if (
    !view ||
    !supportsLivePreviewFrame(view.page.pageType) ||
    !config.enabledLocales.includes(input.locale) ||
    config.languageVersion !== input.languageVersion ||
    config.defaultLocale !== input.defaultLocale
  )
    return null
  const storageIds = new Set<Id<"_storage">>()
  collectImageStorageIds(input.blocks, storageIds)
  const [ctx, mediaUrls, publicPaths] = await Promise.all([
    buildBlockRenderContext({
      blocks: input.blocks as Block[],
      renderLocale: input.locale,
      presentationLocale: input.locale,
      defaultLocale: config.defaultLocale,
      isPreview: true,
      languageVersion: config.languageVersion,
    }),
    // Every image resolves: the reads go in groups the batch read accepts.
    readInIdGroups([...storageIds], (group) =>
      fetchAuthQuery(api.cms.media.getStorageUrls, { storageIds: group })
    ),
    fetchQuery(api.cms.pages.getLocalizedPathsByIds, {
      ids: [input.pageId as Id<"pages">],
      locale: input.locale,
      languageVersion: config.languageVersion,
    }),
  ])
  return { ctx, mediaUrls, publicPath: publicPaths[input.pageId] ?? null }
}
