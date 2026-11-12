import { act, renderHook } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import { ConvexError } from "convex/values"
import type { PropsWithChildren } from "react"
import type { Id } from "@/convex/_generated/dataModel"
import en from "@/messages/admin/en.json"
import { usePageRowActions, type PublishTarget } from "./pages-list-row-actions"
const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("convex/react", () => ({
  useQuery: () => ({ defaultLocale: "en" }),
  useMutation: () => mocks.publish,
  useConvex: () => ({ query: async () => null }),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }),
}))
vi.mock("sonner", () => ({
  toast: { error: mocks.error, success: mocks.success },
}))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(),
}))
vi.mock("@/components/admin/page-editor/lib/pre-publish-readiness", () => ({
  confirmCurrentPrePublishReadiness: async () => true,
  usePrePublishReadinessCopy: () => ({
    copy: {},
    languageChange: vi.fn(),
    itemMessage: vi.fn(),
  }),
}))
vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: async () => undefined,
}))
const target: PublishTarget = {
  pageId: "edited" as Id<"pages">,
  pageType: "page",
  locale: "en",
  expectedDraftGeneration: 1,
  expectedSharedDraftGeneration: 1,
  expectedPublicGeneration: 0,
  expectedLifecycleGeneration: 1,
  expectedReleaseGeneration: 0,
}
function wrapper({ children }: PropsWithChildren) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  )
}
beforeEach(() => vi.clearAllMocks())
test("list Publish shows the specific approved route refusal and no success", async () => {
  mocks.publish.mockRejectedValue(
    new ConvexError({
      code: "PUBLISHED_LOCALE_ROUTE_TAKEN",
      source: "publish",
      kind: "taken",
      path: "/news",
      locale: "en",
      holder: { pageId: "holder", pageType: "post", title: "News" },
    })
  )
  const { result } = renderHook(() => usePageRowActions(), { wrapper })
  await act(() => result.current.publish(target))
  expect(mocks.error).toHaveBeenCalledWith(
    "This page can’t be published: /news is already used by “News” (Post). Change the URL identifier, then try again."
  )
  expect(mocks.success).not.toHaveBeenCalled()
})
test("list never exposes the editor-only parent refusal text", async () => {
  mocks.publish.mockRejectedValue(
    new ConvexError({
      code: "PUBLISHED_CHILD_ROUTE_TAKEN",
      source: "publish",
      locale: "en",
      path: "/shop",
      check: {
        kind: "taken",
        path: "/shop/cards",
        locale: "en",
        holder: { pageId: "holder", pageType: "page", title: "Cards" },
      },
    })
  )
  const { result } = renderHook(() => usePageRowActions(), { wrapper })
  await act(() => result.current.publish(target))
  expect(mocks.error).toHaveBeenCalledWith(en.pages.list.toast.publishFailed)
})
