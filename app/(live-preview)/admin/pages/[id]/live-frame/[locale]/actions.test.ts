import { beforeEach, expect, it, vi } from "vitest"
import { getFunctionName } from "convex/server"
import { blockProfile } from "@/test-utils/block-profile"
import { isActiveContentType } from "@/convex/lib/contentTypes"
import type { LiveFrameInput } from "@/components/admin/live-preview-frame-bridge"
import type { Block } from "@/convex/lib/blocks"
import { resolveLiveFrameContext } from "./actions"

const reads = vi.hoisted(() => ({
  auth: vi.fn(),
  anonymous: vi.fn(),
  context: vi.fn(),
  // Lets one test skip draft validation, which needs a shipped block type.
  trustInput: false,
}))
vi.mock("@/lib/auth/server", () => ({ fetchAuthQuery: reads.auth }))
vi.mock("convex/nextjs", () => ({ fetchQuery: reads.anonymous }))
vi.mock("@/lib/blocks/render-context", () => ({
  buildBlockRenderContext: reads.context,
}))
vi.mock(
  "@/components/admin/live-preview-frame-bridge",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/admin/live-preview-frame-bridge")
      >()
    return {
      ...actual,
      validLiveFrameInput: (value: unknown) =>
        reads.trustInput || actual.validLiveFrameInput(value),
    }
  }
)

const config = {
  defaultLocale: "en",
  enabledLocales: ["en", "fr"],
  languageVersion: 2,
}
const input: LiveFrameInput = {
  buildId: "build",
  sessionId: "session",
  pageId: "page",
  locale: "fr",
  pageType: "landing-page",
  defaultLocale: "en",
  languageVersion: 2,
  title: "Title",
  blocks: [],
  selectedBlockId: null,
  inlineEditingEnabled: true,
  mode: "light",
}
function stored(pageType: string, siteConfig = config) {
  reads.auth.mockImplementation(async (ref) =>
    getFunctionName(ref) === "cms/pages:getForEdit"
      ? { page: { pageType } }
      : siteConfig
  )
}
beforeEach(() => {
  reads.trustInput = false
  reads.auth.mockReset()
  reads.anonymous.mockReset().mockResolvedValue({ page: "/published" })
  reads.context.mockReset().mockResolvedValue({ marker: "context" })
})

it.each(
  (["page", "landing-page", "post", "author"] as const).filter(
    isActiveContentType
  )
)(
  "resolves a render context for a stored %s row",
  blockProfile([]),
  async (pageType) => {
    stored(pageType)
    const result = await resolveLiveFrameContext({ ...input, pageType })
    expect(result).toEqual({
      ctx: { marker: "context" },
      mediaUrls: {},
      publicPath: "/published",
    })
  }
)
it(
  "resolves a Page context on a single-language site",
  blockProfile([]),
  async () => {
    stored("page", {
      defaultLocale: "en",
      enabledLocales: ["en"],
      languageVersion: 1,
    })
    const result = await resolveLiveFrameContext({
      ...input,
      pageType: "page",
      locale: "en",
      languageVersion: 1,
    })
    expect(result).not.toBeNull()
  }
)
it.each(["testimonial", "job"])(
  "refuses a stored %s row",
  blockProfile([]),
  async (pageType) => {
    stored(pageType)
    expect(await resolveLiveFrameContext(input)).toBeNull()
    expect(reads.context).not.toHaveBeenCalled()
  }
)
it(
  "resolves every image of a 120-image draft in reads of at most 50 ids",
  blockProfile([]),
  async () => {
    stored("landing-page")
    const storageReads: string[][] = []
    const defaultRead = reads.auth.getMockImplementation()!
    reads.auth.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) !== "cms/media:getStorageUrls")
        return defaultRead(ref, args)
      const ids = (args as { storageIds: string[] }).storageIds
      if (ids.length > 50) throw new Error("TOO_MANY_IDS")
      storageReads.push(ids)
      return Object.fromEntries(ids.map((id) => [id, `/fresh/${id}`]))
    })
    // Any block value with a storageId counts as an image; draft validation
    // (which needs a shipped block type) is not what this test covers.
    reads.trustInput = true
    const blocks = Array.from(
      { length: 120 },
      (_, i) =>
        ({
          id: `block-${i}`,
          primary: { image: { storageId: `img_${i}`, url: "/old" } },
        }) as unknown as Block
    )
    const result = await resolveLiveFrameContext({ ...input, blocks })
    expect(result).not.toBeNull()
    expect(storageReads.map((ids) => ids.length)).toEqual([50, 50, 20])
    expect(Object.keys(result!.mediaUrls)).toHaveLength(120)
    expect(result!.mediaUrls.img_119).toBe("/fresh/img_119")
  }
)
