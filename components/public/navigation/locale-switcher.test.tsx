import { act, fireEvent, render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "@/convex/_generated/api"

const mocks = vi.hoisted(() => ({
  alternates: undefined as
    Array<{ locale: string; url: string; indexable: boolean }> | undefined,
  onOpenChange: null as ((open: boolean) => void) | null,
  homeAlternates: undefined as
    Array<{ locale: string; url: string; indexable: boolean }> | undefined,
  pageId: undefined as string | null | undefined,
  pathname: "/contact",
  search: "ref=nav",
  useQuery: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}))

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    prefetch,
    hrefLang,
    onClick,
  }: {
    children: ReactNode
    href: string
    prefetch?: boolean
    hrefLang?: string
    onClick?: () => void
  }) => (
    <a
      href={href}
      data-prefetch={String(prefetch)}
      hrefLang={hrefLang}
      onClick={(event) => {
        event.preventDefault()
        onClick?.()
      }}
    >
      {children}
    </a>
  ),
}))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    mocks.onOpenChange = onOpenChange ?? null
    return <div>{children}</div>
  },
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))

import { LocaleSwitcher } from "./locale-switcher"
import { PresentationLocaleProvider } from "@/components/public/presentation-locale"

function renderSwitcher(
  enabledLocales = ["en", "es"],
  currentLocale = "en",
  defaultLocale = "en"
) {
  return render(
    <LocaleSwitcher
      currentLocale={currentLocale}
      defaultLocale={defaultLocale}
      enabledLocales={enabledLocales}
      languageVersion={7}
    />
  )
}

function openSwitcher() {
  act(() => mocks.onOpenChange?.(true))
}

describe("LocaleSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.alternates = undefined
    mocks.homeAlternates = undefined
    mocks.onOpenChange = null
    mocks.pageId = undefined
    mocks.pathname = "/contact"
    mocks.search = "ref=nav"
    mocks.useQuery.mockImplementation((reference, args) => {
      if (args === "skip") return undefined
      const name = getFunctionName(reference)
      if (name === "cms/pages:resolveLocalizedPathQuery") {
        return mocks.pageId
      }
      if (name === "cms/pages:getPublicLocaleAlternates") {
        return mocks.alternates
      }
      if (name === "cms/pages:getPublicHomeLocaleAlternates") {
        return mocks.homeAlternates
      }
      throw new Error(`Unexpected query: ${name}`)
    })
  })

  test("creates no Convex subscription for a single-locale site", () => {
    renderSwitcher(["fr"], "fr", "fr")

    expect(mocks.useQuery).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("button", { name: /change language/i })
    ).toBeNull()
  })

  test("creates no route subscription before a multi-locale switcher opens", () => {
    renderSwitcher()

    expect(mocks.useQuery).toHaveBeenCalledWith(
      api.cms.pages.resolveLocalizedPathQuery,
      "skip"
    )
    expect(mocks.useQuery).toHaveBeenCalledWith(
      api.cms.pages.getPublicLocaleAlternates,
      "skip"
    )
  })

  test("starts route resolution on first open and keeps it latched", () => {
    renderSwitcher()

    openSwitcher()
    act(() => mocks.onOpenChange?.(false))
    openSwitcher()

    const activeRouteArgs = mocks.useQuery.mock.calls
      .filter(
        ([reference, args]) =>
          getFunctionName(reference) ===
            "cms/pages:resolveLocalizedPathQuery" && args !== "skip"
      )
      .map(([, args]) => args)
    expect(activeRouteArgs).toEqual([
      { path: "/contact", locale: "en", languageVersion: 7 },
    ])
  })

  // M05 P20: navigation versus SEO, and the switcher before availability
  // resolves.
  test("renders options non-interactive while the page is being resolved", () => {
    renderSwitcher()
    openSwitcher()

    expect(screen.getByRole("status")).toHaveTextContent("Checking…")
    expect(screen.queryAllByRole("link")).toEqual([])
    expect(screen.getByText(/^ES/).closest("span")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  test("never links a guessed URL while the alternates are loading", () => {
    mocks.pageId = "page-id"
    renderSwitcher()
    openSwitcher()

    expect(screen.getByRole("status")).toHaveTextContent("Checking…")
    expect(screen.queryAllByRole("link")).toEqual([])
  })

  test("checks published Homes on a non-Page route and disables an unpublished locale", () => {
    mocks.pageId = null
    const view = renderSwitcher(["de", "en", "es"], "de", "de")
    openSwitcher()

    expect(mocks.useQuery).toHaveBeenCalledWith(
      api.cms.pages.getPublicHomeLocaleAlternates,
      { languageVersion: 7 }
    )
    expect(screen.getByRole("status")).toHaveTextContent("Checking…")
    expect(screen.queryAllByRole("link")).toEqual([])

    mocks.homeAlternates = [
      { locale: "de", url: "/", indexable: true },
      { locale: "en", url: "/en", indexable: false },
    ]
    // The subscription settles after the Home reader checks publication.
    view.unmount()
    renderSwitcher(["de", "en", "es"], "de", "de")
    openSwitcher()

    expect(screen.getByRole("link", { name: "DE" })).toHaveAttribute(
      "href",
      "/?ref=nav"
    )
    expect(screen.getByRole("link", { name: "EN" })).toHaveAttribute(
      "href",
      "/en?ref=nav"
    )
    expect(screen.queryByRole("link", { name: "ES" })).toBeNull()
  })

  test("links each resolved navigation alternate", () => {
    mocks.pageId = "page-id"
    mocks.alternates = [
      { locale: "en", url: "/contact", indexable: true },
      { locale: "es", url: "/es/contacto", indexable: true },
    ]
    renderSwitcher()
    openSwitcher()

    expect(screen.getByRole("link", { name: "ES" })).toHaveAttribute(
      "href",
      "/es/contacto?ref=nav"
    )
  })

  test("keeps a noIndex language switchable", () => {
    mocks.pageId = "page-id"
    mocks.alternates = [
      { locale: "en", url: "/contact", indexable: true },
      { locale: "fr", url: "/fr/contact", indexable: false },
      { locale: "es", url: "/es/contacto", indexable: true },
    ]
    renderSwitcher(["en", "fr", "es"])
    openSwitcher()

    expect(screen.getByRole("link", { name: "FR" })).toHaveAttribute(
      "href",
      "/fr/contact?ref=nav"
    )
  })

  test("disables a language without a version of this page, with no fallback link", () => {
    mocks.pageId = "page-id"
    mocks.alternates = [{ locale: "en", url: "/contact", indexable: true }]
    renderSwitcher(["en", "fr", "es"])
    openSwitcher()

    expect(screen.queryByRole("link", { name: /ES/ })).toBeNull()
    expect(screen.queryByRole("link", { name: /FR/ })).toBeNull()
    expect(screen.getByText(/^ES/).closest("span")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(screen.getAllByText(", Not available")).toHaveLength(2)
  })

  describe("link semantics (U4)", () => {
    function resolved() {
      mocks.pageId = "page-id"
      mocks.alternates = [
        { locale: "en", url: "/about", indexable: true },
        { locale: "fr", url: "/fr/a-propos", indexable: true },
      ]
    }

    test("the default language links directly to its unprefixed URL, others to their own", () => {
      resolved()
      mocks.pathname = "/fr/a-propos"
      mocks.search = ""
      renderSwitcher(["en", "fr"], "fr", "en")
      openSwitcher()

      expect(screen.getByRole("link", { name: "EN" })).toHaveAttribute(
        "href",
        "/about"
      )
      expect(screen.getByRole("link", { name: "FR" })).toHaveAttribute(
        "href",
        "/fr/a-propos"
      )
    })

    test("the default Home links directly to /", () => {
      mocks.pageId = null
      mocks.homeAlternates = [
        { locale: "en", url: "/", indexable: true },
        { locale: "fr", url: "/fr", indexable: true },
      ]
      mocks.search = ""
      renderSwitcher(["en", "fr"], "fr", "en")
      openSwitcher()

      expect(screen.getByRole("link", { name: "EN" })).toHaveAttribute(
        "href",
        "/"
      )
      expect(screen.getByRole("link", { name: "FR" })).toHaveAttribute(
        "href",
        "/fr"
      )
    })

    test("links are not prefetched and carry hreflang", () => {
      resolved()
      renderSwitcher(["en", "fr"])
      openSwitcher()

      const fr = screen.getByRole("link", { name: "FR" })
      expect(fr).toHaveAttribute("data-prefetch", "false")
      expect(fr).toHaveAttribute("hrefLang", "fr")
      expect(screen.getByRole("link", { name: "EN" })).toHaveAttribute(
        "hrefLang",
        "en"
      )
    })

    test("clicking any language writes no cookie", () => {
      resolved()
      renderSwitcher(["en", "fr"], "en", "en")
      openSwitcher()
      const cookieWrite = vi.spyOn(document, "cookie", "set")

      fireEvent.click(screen.getByRole("link", { name: "FR" }))
      fireEvent.click(screen.getByRole("link", { name: "EN" }))

      expect(cookieWrite).not.toHaveBeenCalled()
      expect(document.cookie).not.toContain("NEXT_LOCALE")
      cookieWrite.mockRestore()
    })

    test("localePath (used by menus) keeps the default language unprefixed", async () => {
      const { localePath } = await import("./locale-path")
      expect(localePath("en", "en", "/about")).toBe("/about")
      expect(localePath("fr", "en", "/a-propos")).toBe("/fr/a-propos")
    })
  })

  test("speaks the current page's language", () => {
    mocks.pageId = "page-id"
    renderSwitcher(["en", "fr"], "fr", "en")
    openSwitcher()

    expect(
      screen.getByRole("button", { name: "Changer de langue, FR" })
    ).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Vérification…")
  })
})

test("frame canonical path drives locale resolution without leaking admin session query", () => {
  mocks.useQuery.mockClear()
  mocks.pathname = "/admin/pages/page/live-frame/fr"
  mocks.search = "session=private-frame"
  mocks.pageId = "page"
  mocks.alternates = [
    { locale: "en", url: "/contact", indexable: true },
    { locale: "fr", url: "/fr/contact", indexable: true },
  ]
  render(
    <PresentationLocaleProvider
      value={{ locale: "fr", defaultLocale: "en", publicPath: "/fr/contact" }}
    >
      <LocaleSwitcher
        currentLocale="fr"
        defaultLocale="en"
        enabledLocales={["en", "fr"]}
        languageVersion={7}
      />
    </PresentationLocaleProvider>
  )
  act(() => mocks.onOpenChange?.(true))
  expect(mocks.useQuery).toHaveBeenCalledWith(
    api.cms.pages.resolveLocalizedPathQuery,
    { path: "/contact", locale: "fr", languageVersion: 7 }
  )
  expect(screen.getByRole("link", { name: "EN" })).toHaveAttribute(
    "href",
    "/contact"
  )
})

test("frame draft-only path never queries its admin route as a public Page", () => {
  mocks.useQuery.mockClear()
  mocks.pathname = "/admin/pages/page/live-frame/fr"
  render(
    <PresentationLocaleProvider
      value={{ locale: "fr", defaultLocale: "en", publicPath: null }}
    >
      <LocaleSwitcher
        currentLocale="fr"
        defaultLocale="en"
        enabledLocales={["en", "fr"]}
        languageVersion={7}
      />
    </PresentationLocaleProvider>
  )
  act(() => mocks.onOpenChange?.(true))
  expect(
    mocks.useQuery.mock.calls
      .filter(
        ([reference]) =>
          getFunctionName(reference) ===
          getFunctionName(api.cms.pages.resolveLocalizedPathQuery)
      )
      .every(([, args]) => args === "skip")
  ).toBe(true)
})
