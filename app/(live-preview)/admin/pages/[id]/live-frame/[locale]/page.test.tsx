import { beforeEach, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import type { ReactNode } from "react"
import LiveFramePage from "./page"

const reads = vi.hoisted(() => ({
  auth: vi.fn(),
  anonymous: vi.fn(),
  shell: vi.fn(),
  catalog: vi.fn(),
}))
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: reads.auth }))
vi.mock("convex/nextjs", () => ({ fetchQuery: reads.anonymous }))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND")
  },
}))
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getMessages: async () => ({}),
}))
vi.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/lib/slices/public-site-shell.server", () => ({
  loadPublicSiteShell: reads.shell,
}))
vi.mock("@/convex/lib/slices/presentations", () => ({
  readSlicePresentationCatalog: reads.catalog,
}))
vi.mock("@/components/admin/live-preview-frame-runtime", () => ({
  LivePreviewFrameRuntime: ({
    publicPath,
    config,
    presentationCatalog,
  }: {
    publicPath: string | null
    config: { languageVersion: number }
    presentationCatalog: { revision: string }
  }) => (
    <main
      data-public-path={publicPath ?? ""}
      data-version={config.languageVersion}
      data-catalog={presentationCatalog.revision}
    />
  ),
}))
const config = {
  defaultLocale: "en",
  enabledLocales: ["en", "fr"],
  languageVersion: 2,
}
const request = (locale = "en", session = "session-1234567890") => ({
  params: Promise.resolve({ id: "page", locale }),
  searchParams: Promise.resolve({ session }),
})
beforeEach(() => {
  reads.auth
    .mockReset()
    .mockImplementation(async (ref) =>
      getFunctionName(ref) === "cms/pages:getForEdit"
        ? { page: { pageType: "landing-page" } }
        : config
    )
  reads.anonymous.mockReset().mockResolvedValue({ page: "/published" })
  reads.shell.mockReset().mockResolvedValue({})
  reads.catalog.mockReset().mockResolvedValue({ revision: "source-catalog" })
})
it("NEW B2 bootstraps the canonical Page path anonymously while preserving private Page and catalog reads", async () => {
  render(await LiveFramePage(request("fr")))
  expect(reads.anonymous).toHaveBeenCalledOnce()
  expect(getFunctionName(reads.anonymous.mock.calls[0][0])).toBe(
    "cms/pages:getLocalizedPathsByIds"
  )
  expect(reads.anonymous.mock.calls[0][1]).toEqual({
    ids: ["page"],
    locale: "fr",
    languageVersion: 2,
  })
  expect(reads.auth.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
    "cms/pages:getForEdit",
    "cms/settings:getSiteConfig",
  ])
  expect(screen.getByRole("main")).toHaveAttribute(
    "data-public-path",
    "/published"
  )
  expect(screen.getByRole("main")).toHaveAttribute(
    "data-catalog",
    "source-catalog"
  )
})
it("NEW B2 suppresses an unpublished current Page path instead of borrowing an authenticated draft path", async () => {
  reads.anonymous.mockResolvedValue({})
  render(await LiveFramePage(request()))
  expect(screen.getByRole("main")).toHaveAttribute("data-public-path", "")
  expect(
    reads.auth.mock.calls.some(
      ([ref]) => getFunctionName(ref) === "cms/pages:getLocalizedPathsByIds"
    )
  ).toBe(false)
})
it("NEW B2 retries the anonymous bootstrap against fresh language authority rather than mixing versions", async () => {
  reads.auth.mockImplementation(async (ref) =>
    getFunctionName(ref) === "cms/pages:getForEdit"
      ? { page: { pageType: "landing-page" } }
      : { ...config, languageVersion: reads.auth.mock.calls.length > 2 ? 3 : 2 }
  )
  reads.anonymous
    .mockRejectedValueOnce(new Error("SITE_LANGUAGE_VERSION_CHANGED"))
    .mockResolvedValueOnce({ page: "/new-published" })
  render(await LiveFramePage(request()))
  expect(
    reads.anonymous.mock.calls.map(([, args]) => args.languageVersion)
  ).toEqual([2, 3])
  expect(screen.getByRole("main")).toHaveAttribute("data-version", "3")
  expect(screen.getByRole("main")).toHaveAttribute(
    "data-public-path",
    "/new-published"
  )
})
it.each(["page", "landing-page"])(
  "bootstraps the live frame for a %s row, including on a single-language site",
  async (pageType) => {
    reads.auth.mockImplementation(async (ref) =>
      getFunctionName(ref) === "cms/pages:getForEdit"
        ? { page: { pageType } }
        : { defaultLocale: "en", enabledLocales: ["en"], languageVersion: 1 }
    )
    render(await LiveFramePage(request("en")))
    expect(screen.getByRole("main")).toHaveAttribute("data-version", "1")
    expect(reads.anonymous).toHaveBeenCalledOnce()
  }
)
it.each(["session", "page-access", "post", "author", "locale"])(
  "NEW B2 performs %s bootstrap refusal before an anonymous Page path read",
  async (kind) => {
    if (kind === "page-access" || kind === "post" || kind === "author")
      reads.auth.mockImplementation(async (ref) =>
        getFunctionName(ref) === "cms/pages:getForEdit"
          ? kind === "page-access"
            ? null
            : { page: { pageType: kind } }
          : config
      )
    await expect(
      LiveFramePage(
        request(
          kind === "locale" ? "de" : "en",
          kind === "session" ? "bad" : undefined
        )
      )
    ).rejects.toThrow("NOT_FOUND")
    expect(reads.anonymous).not.toHaveBeenCalled()
  }
)
