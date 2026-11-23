import type { Id } from "@/convex/_generated/dataModel"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function collectImageStorageIds(
  value: unknown,
  ids: Set<Id<"_storage">>
) {
  if (Array.isArray(value)) {
    for (const item of value) collectImageStorageIds(item, ids)
    return
  }
  if (!isRecord(value)) return
  const storageId = value.storageId
  if (typeof storageId === "string" && storageId.length > 0) {
    ids.add(storageId as Id<"_storage">)
  }
  for (const child of Object.values(value)) {
    collectImageStorageIds(child, ids)
  }
}

export function applyFreshImageUrls(
  value: unknown,
  urls: Record<string, string>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => applyFreshImageUrls(item, urls))
  }
  if (!isRecord(value)) return value

  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    next[key] = applyFreshImageUrls(child, urls)
  }
  if (typeof value.storageId === "string") {
    const freshUrl = urls[value.storageId]
    if (freshUrl) next.url = freshUrl
  }
  return next
}

/**
 * Replace each image's stored `url` with a fresh one from its `storageId`.
 * `loadUrls` reads the URLs for every distinct id on the page (the caller
 * splits them into groups the batch read accepts). Blocks come back unchanged
 * when there are no images or no URL could be read.
 */
export async function refreshBlockImageUrls<T>(
  blocks: T,
  loadUrls: (storageIds: Id<"_storage">[]) => Promise<Record<string, string>>
): Promise<T> {
  const ids = new Set<Id<"_storage">>()
  collectImageStorageIds(blocks, ids)
  if (ids.size === 0) return blocks

  const urls = await loadUrls([...ids])
  if (Object.keys(urls).length === 0) return blocks
  return applyFreshImageUrls(blocks, urls) as T
}
