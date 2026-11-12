import { render, screen, within } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import MenusPage from "./page"

const mocks = vi.hoisted(() => ({
  createMenu: vi.fn(),
  owner: undefined as
    | undefined
    | null
    | { ownerId: string; authId: string; email: string; role: "admin" },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useMutation: mocks.useMutation,
  useQuery: mocks.useQuery,
}))

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode
    href: string
  }) => <a href={href}>{children}</a>,
}))

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}))

function renderPage(
  messages: typeof en = en,
  locale: "en" | "fr" = "en"
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <MenusPage />
    </NextIntlClientProvider>
  )
}

describe("MenusPage menu list", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createMenu.mockResolvedValue(undefined)
    mocks.useMutation.mockReturnValue(mocks.createMenu)
    mocks.owner = {
      ownerId: "owner-1",
      authId: "owner-auth-1",
      email: "owner@example.com",
      role: "admin",
    }
    mocks.useQuery.mockImplementation((reference, args) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:getOwnerSession") return mocks.owner
      if (name === "cms/menus:getCanonical") {
        return { nav: args.slug === "primary" ? [] : [{ id: "footer-item" }] }
      }
      if (name === "cms/settings:getSiteConfig") {
        return { enabledLocales: ["fr", "en"], defaultLocale: "en" }
      }
      return undefined
    })
  })

  test("permission loading starts no menu-list subscription and flashes no create control", () => {
    mocks.owner = undefined

    renderPage()

    expect(
      mocks.useQuery.mock.calls.some(([reference]) =>
        ["cms/menus:getCanonical", "cms/menus:listSlugs"].includes(
          getFunctionName(reference)
        )
      )
    ).toBe(false)
    expect(screen.queryByRole("button", { name: /create menu/i })).toBeNull()
    expect(screen.queryByRole("link")).toBeNull()
  })

  test("the owner sees exactly the primary and footer cards", () => {
    renderPage()

    expect(screen.getAllByRole("link")).toHaveLength(2)
    expect(screen.getByRole("link", { name: /main navigation/i })).toHaveAttribute(
      "href",
      "/admin/menus/primary"
    )
    expect(screen.getByRole("link", { name: /footer navigation/i })).toHaveAttribute(
      "href",
      "/admin/menus/footer"
    )
    expect(screen.queryByRole("link", { name: /mobile/i })).toBeNull()
    expect(screen.queryByText(/create menu/i)).toBeNull()
  })

  test("the owner sees the Menus list in French", () => {
    renderPage(fr, "fr")

    const primary = screen.getByRole("link", { name: /navigation principale/i })
    const footer = screen.getByRole("link", { name: /navigation du pied de page/i })
    expect(primary).toBeInTheDocument()
    expect(footer).toBeInTheDocument()
    expect(screen.queryByText(/créer un menu/i)).toBeNull()
    expect(
      within(primary).getByText("Non configuré", { exact: true })
    ).toBeInTheDocument()
    expect(
      within(footer).getByText("Configuré", { exact: true })
    ).toBeInTheDocument()
  })

  test("an unauthenticated permission result exposes no menu data or mutation controls", () => {
    mocks.owner = null

    renderPage()

    expect(
      screen.getByText(/do not have access to existing menus/i)
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: /create menu/i })).toBeNull()
    expect(screen.queryByRole("link")).toBeNull()
    expect(
      mocks.useQuery.mock.calls.some(([reference]) =>
        ["cms/menus:getCanonical", "cms/menus:listSlugs"].includes(
          getFunctionName(reference)
        )
      )
    ).toBe(false)
  })

})
