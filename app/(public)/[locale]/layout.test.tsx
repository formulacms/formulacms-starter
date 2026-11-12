import { render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cacheReads: [] as Array<{ key: string[]; tags: string[] }>,
  fetchQuery: vi.fn(),
}))

vi.mock("next/headers", () => ({
  draftMode: async () => ({ isEnabled: false }),
}))
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }))
vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("sonner", () => ({ Toaster: () => null }))
vi.mock("@/lib/fonts", () => ({ fontClassName: "font-test" }))
vi.mock("@/components/hydration-extension-attribute-cleanup", () => ({
  HydrationExtensionAttributeCleanup: () => null,
}))
vi.mock("next/cache", () => ({
  unstable_cache: (
    run: () => Promise<unknown>,
    key: string[],
    options: { tags: string[] }
  ) => {
    mocks.cacheReads.push({ key, tags: options.tags })
    return run
  },
}))
vi.mock("@/components/public/site-header", () => ({
  SiteHeader: ({
    cardsBySource,
  }: {
    cardsBySource: Record<string, unknown>
  }) => (
    <div data-testid="header-sources">
      {Object.keys(cardsBySource).join(",")}
      <span data-testid="header-cards">{JSON.stringify(cardsBySource)}</span>
    </div>
  ),
}))
vi.mock("@/components/public/footer", () => ({
  Footer: ({ cardsBySource }: { cardsBySource: Record<string, unknown> }) => (
    <div data-testid="footer-sources">
      {Object.keys(cardsBySource).join(",")}
    </div>
  ),
}))

import PublicLayout from "./layout"
import NotFound from "./not-found"

const dynamicBlock = {
  id: "recent",
  kind: "dynamicList" as const,
  heading: "Recent",
  source: { pageType: "post" as const, limit: 4 },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cacheReads.length = 0
  mocks.fetchQuery.mockImplementation(async (reference, args) => {
    const name = getFunctionName(reference)
    if (name === "cms/settings:getSiteConfig") {
      return {
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        languageVersion: 7,
      }
    }
    if (name === "cms/menus:getWithResolvedLinks") {
      return args.slug === "primary"
        ? {
            slug: "primary",
            nav: [
              {
                id: "content",
                label: "Content",
                panel: {
                  columns: 1,
                  blocks: [dynamicBlock],
                  footer: { blocks: [dynamicBlock] },
                },
              },
            ],
          }
        : { slug: "footer", nav: [] }
    }
    if (name === "cms/pages:listRecentPublicRelationCards") {
      return [{ pageId: "post-1", pageType: "post", title: "Latest", excerpt: "Published excerpt", href: "/fr/latest" }]
    }
    if (name === "cms/settings:getBrandingUrls") return { logo: null }
    if (name === "cms/settings:getPublicChrome") return { siteName: "Test" }
    throw new Error(`Unexpected query ${name}`)
  })
})

test("public layout propagates config failure before rendering a synthetic locale shell", async () => {
  const failure = new Error("Config unavailable")
  mocks.fetchQuery.mockRejectedValue(failure)
  await expect(
    PublicLayout({
      children: <div>Page</div>,
      params: Promise.resolve({ locale: "fr" }),
    })
  ).rejects.toBe(failure)
  expect(mocks.fetchQuery).toHaveBeenCalledOnce()
})

test("optional shell outages still render the page with graceful chrome defaults", async () => {
  const base = mocks.fetchQuery.getMockImplementation()!
  mocks.fetchQuery.mockImplementation(async (reference, args) => {
    if (getFunctionName(reference) === "cms/settings:getSiteConfig") {
      return base(reference, args)
    }
    throw new Error("Optional shell read unavailable")
  })
  render(
    await PublicLayout({
      children: <div>Page survives</div>,
      params: Promise.resolve({ locale: "fr" }),
    })
  )
  expect(screen.getByText("Page survives")).toBeInTheDocument()
})

test("hydrates each unique dynamic source through a locale-and-limit cache key", async () => {
  render(
    await PublicLayout({
      children: <div>Page</div>,
      params: Promise.resolve({ locale: "fr" }),
    })
  )

  expect(screen.getByTestId("header-sources")).toHaveTextContent("post:4")
  expect(screen.getByTestId("footer-sources")).toHaveTextContent("post:4")
  expect(screen.getByTestId("header-cards")).toHaveTextContent("Published excerpt")
  expect(screen.getByTestId("header-cards")).toHaveTextContent("/fr/latest")

  const recentReads = mocks.cacheReads.filter(
    ({ key }) => key[0] === "cms-recent"
  )
  expect(recentReads).toEqual([
    {
      key: ["cms-recent", "post", "4", "fr", "7"],
      tags: ["cms:pages"],
    },
  ])
  const menuReads = mocks.cacheReads.filter(({ key }) => key[0] === "cms-menu")
  expect(menuReads).toHaveLength(2)
  expect(menuReads.every(({ tags }) => tags.join() === "cms:menus")).toBe(true)
})

// M05 P21: `<html lang>`, the not-found copy and its home link are always the
// one presentation language P: the request's language when it is enabled,
// otherwise the default chosen in Admin → Languages.
describe("M05 P21 404 presentation", () => {
  async function renderNotFound(
    requestedLocale: string,
    site: { defaultLocale: string; enabledLocales: string[] }
  ) {
    const base = mocks.fetchQuery.getMockImplementation()!
    mocks.fetchQuery.mockImplementation(async (reference, args) =>
      getFunctionName(reference) === "cms/settings:getSiteConfig"
        ? { ...site, languageVersion: 7 }
        : base(reference, args)
    )
    const element = (await PublicLayout({
      children: <NotFound />,
      params: Promise.resolve({ locale: requestedLocale }),
    })) as React.ReactElement<{ dir: string; lang: string }>
    render(element)
    const menuLocales = mocks.cacheReads
      .filter(({ key }) => key[0] === "cms-menu")
      .map(({ key }) => key[2])
    return { dir: element.props.dir, lang: element.props.lang, menuLocales }
  }

  function expectPresentation(heading: string, home: string, label: string) {
    expect(
      screen.getByRole("heading", { level: 1, name: heading })
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      home
    )
  }

  test("a disabled /fr path with default en is presented in English", async () => {
    const result = await renderNotFound("fr", {
      defaultLocale: "en",
      enabledLocales: ["en", "nl"],
    })

    expect(result).toEqual({
      dir: "ltr",
      lang: "en",
      menuLocales: ["en", "en"],
    })
    expectPresentation("Page not found", "/", "Return home")
  })

  test("an enabled nl path is presented in Dutch with the /nl home", async () => {
    const result = await renderNotFound("nl", {
      defaultLocale: "en",
      enabledLocales: ["en", "nl"],
    })

    expect(result.lang).toBe("nl")
    expect(result.dir).toBe("ltr")
    expectPresentation(
      "Pagina niet gevonden",
      "/nl",
      "Terug naar de startpagina"
    )
  })

  test("an enabled fr path is presented in French with the /fr home", async () => {
    const result = await renderNotFound("fr", {
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
    })

    expect(result.lang).toBe("fr")
    expect(result.dir).toBe("ltr")
    expectPresentation("Page introuvable", "/fr", "Retour à l'accueil")
  })

  test("a French default is unprefixed, and a disabled en path falls back to it", async () => {
    const result = await renderNotFound("en", {
      defaultLocale: "fr",
      enabledLocales: ["fr", "nl"],
    })

    expect(result.lang).toBe("fr")
    expect(result.dir).toBe("ltr")
    expectPresentation("Page introuvable", "/", "Retour à l'accueil")
  })
})
