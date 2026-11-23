import { describe, expect, it, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import { readInIdGroups } from "@/lib/cms/batched-read"
import { refreshBlockImageUrls } from "./media-urls"

/** A batch read that refuses more than 50 ids, as the Convex reads now do. */
function cappedStorageRead() {
  return vi.fn(async (storageIds: Id<"_storage">[]) => {
    if (storageIds.length > 50) throw new Error("TOO_MANY_IDS")
    return Object.fromEntries(storageIds.map((id) => [id, `/fresh/${id}`]))
  })
}

describe("readInIdGroups (VISITOR-LIMITS)", () => {
  it("reads 101 ids in groups of 50, 50 and 1 and merges every answer", async () => {
    const read = cappedStorageRead()
    const ids = Array.from(
      { length: 101 },
      (_, i) => `img_${i}` as Id<"_storage">
    )
    const urls = await readInIdGroups(ids, read)
    expect(read.mock.calls.map(([group]) => group.length)).toEqual([50, 50, 1])
    expect(Object.keys(urls)).toHaveLength(101)
    expect(urls.img_100).toBe("/fresh/img_100")
  })

  it("makes no read for an empty id list", async () => {
    const read = cappedStorageRead()
    expect(await readInIdGroups([], read)).toEqual({})
    expect(read).not.toHaveBeenCalled()
  })

  it("rejects the whole read when one group fails", async () => {
    const failure = new Error("backend unavailable")
    const ids = Array.from({ length: 60 }, (_, i) => `id_${i}`)
    await expect(
      readInIdGroups(ids, async (group) => {
        if (group.includes("id_55")) throw failure
        return Object.fromEntries(group.map((id) => [id, id]))
      })
    ).rejects.toBe(failure)
  })
})

describe("refreshBlockImageUrls", () => {
  it("gives image 101 of a 101-image page its fresh URL", async () => {
    const read = cappedStorageRead()
    const blocks = Array.from({ length: 101 }, (_, i) => ({
      id: `block-${i}`,
      primary: {
        image: {
          storageId: `img_${i}`,
          url: i === 100 ? "/stale-101" : `/old/${i}`,
        },
      },
    }))
    const refreshed = await refreshBlockImageUrls(blocks, (storageIds) =>
      readInIdGroups(storageIds, read)
    )
    expect(read).toHaveBeenCalledTimes(3)
    expect(refreshed[100].primary.image.url).toBe("/fresh/img_100")
    expect(
      refreshed.every(({ primary }) => primary.image.url.startsWith("/fresh/"))
    ).toBe(true)
  })

  it("returns blocks unchanged without images or without any URL", async () => {
    const blocks = [{ id: "text", primary: { title: "No image" } }]
    const loadUrls = vi.fn(async () => ({}))
    expect(await refreshBlockImageUrls(blocks, loadUrls)).toBe(blocks)
    expect(loadUrls).not.toHaveBeenCalled()
    const imaged = [{ image: { storageId: "img_1", url: "/kept" } }]
    expect(await refreshBlockImageUrls(imaged, loadUrls)).toBe(imaged)
  })
})
