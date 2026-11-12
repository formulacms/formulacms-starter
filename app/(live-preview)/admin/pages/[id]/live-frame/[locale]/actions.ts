"use server"

import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import { fetchAuthQuery } from "@/lib/auth-server"
import { buildSliceRenderContext } from "@/lib/slices/render-context"
import { collectImageStorageIds } from "@/lib/slices/media-urls"
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
  collectImageStorageIds(input.slices, storageIds)
  // The existing resolver caps a batch at 100; refuse a partial media context.
  if (storageIds.size > 100) return null
  const [ctx, mediaUrls, publicPaths] = await Promise.all([
    buildSliceRenderContext({
      slices: input.slices as Slice[],
      renderLocale: input.locale,
      presentationLocale: input.locale,
      defaultLocale: config.defaultLocale,
      isPreview: true,
      languageVersion: config.languageVersion,
    }),
    storageIds.size
      ? fetchAuthQuery(api.cms.media.getStorageUrls, {
          storageIds: [...storageIds],
        })
      : Promise.resolve({} as Record<string, string>),
    fetchQuery(api.cms.pages.getLocalizedPathsByIds, {
      ids: [input.pageId as Id<"pages">],
      locale: input.locale,
      languageVersion: config.languageVersion,
    }),
  ])
  return { ctx, mediaUrls, publicPath: publicPaths[input.pageId] ?? null }
}
