import { beforeEach, expect, it, vi } from "vitest"
import { getFunctionName } from "convex/server"
import { sliceProfile } from "@/test-utils/slice-profile"
import type { LiveFrameInput } from "@/components/admin/live-preview-frame-bridge"
import { resolveLiveFrameContext } from "./actions"

const reads = vi.hoisted(() => ({
  auth: vi.fn(),
  anonymous: vi.fn(),
  context: vi.fn(),
}))
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: reads.auth }))
vi.mock("convex/nextjs", () => ({ fetchQuery: reads.anonymous }))
vi.mock("@/lib/slices/render-context", () => ({
  buildSliceRenderContext: reads.context,
}))

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
  slices: [],
  selectedSliceId: null,
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
  reads.auth.mockReset()
  reads.anonymous.mockReset().mockResolvedValue({ page: "/published" })
  reads.context.mockReset().mockResolvedValue({ marker: "context" })
})

it.each(["page", "landing-page"] as const)(
  "resolves a render context for a stored %s row",
  sliceProfile([]),
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
  sliceProfile([]),
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
it.each(["post", "author"])(
  "refuses a stored %s row",
  sliceProfile([]),
  async (pageType) => {
    stored(pageType)
    expect(await resolveLiveFrameContext(input)).toBeNull()
    expect(reads.context).not.toHaveBeenCalled()
  }
)
