const moduleTestGate = vi.hoisted(() => ({ state: "on" }))
vi.mock("./admin-module-state-provider", () => ({
  useModuleGate: () => ({ state: moduleTestGate.state }),
}))
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { AdminCommandPaletteProvider } from "./command-palette"

const mocks = vi.hoisted(() => ({
  archive: undefined as string[] | undefined,
  archiveThrows: false,
  owner: {
    ownerId: "owner-1",
    authId: "owner-1",
    email: "owner@example.com",
    role: "admin" as const,
  } as {
    ownerId: string
    authId: string
    email: string
    role: "admin"
  } | null,
  push: vi.fn(),
  pages: [] as Array<{
    _id: string
    localizedTitles: Record<string, string>
    slug: string
    status: "draft" | "published" | "archived"
    pageType: "page"
    updatedAt: number
  }>,
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: mocks.push }),
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

function renderPalette(locale: "en" | "fr" = "en") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <AdminCommandPaletteProvider>
        <div>Child</div>
      </AdminCommandPaletteProvider>
    </NextIntlClientProvider>
  )
}

describe("AdminCommandPaletteProvider Content Type creation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    moduleTestGate.state = "on"
    mocks.archive = []
    mocks.archiveThrows = false
    mocks.pages = []
    mocks.owner = {
      ownerId: "owner-1",
      authId: "owner-1",
      email: "owner@example.com",
      role: "admin",
    }
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:getOwnerSession") {
        return mocks.owner
      }
      if (name.endsWith("getArchivedContentTypes")) {
        if (mocks.archiveThrows) throw new Error("archive unavailable")
        return mocks.archive
      }
      if (name === "cms/pages:listSummaries") return mocks.pages
      return undefined
    })
  })

  test("filters archived New commands after archive state is ready", async () => {
    mocks.archive = ["author"]
    renderPalette()

    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" })
    )
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /New post/i })
      ).toBeInTheDocument()
    })

    expect(
      screen.queryByRole("button", { name: /New author/i })
    ).not.toBeInTheDocument()
  })

  test("does not offer New commands while archive state is loading", async () => {
    mocks.archive = undefined
    renderPalette()

    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" })
    )
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Dashboard/ })
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByRole("button", { name: /New post/i })
    ).not.toBeInTheDocument()
  })

  test("keeps an actionable disabled entry when the archive query fails", async () => {
    mocks.archiveThrows = true
    renderPalette()

    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" })
    )
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /New content unavailable/i })
      ).toBeDisabled()
    })
  })

  test("does not run the active command during IME composition", async () => {
    renderPalette()

    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" })
    )
    const input = await screen.findByRole("textbox", {
      name: "Search commands",
    })
    fireEvent.change(input, { target: { value: "post" } })
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /New post/i })).toBeVisible()
    })

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: true,
    })
    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(mocks.push).not.toHaveBeenCalled()
  })

  test("runs the active command on ordinary Enter", async () => {
    renderPalette()

    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" })
    )
    const input = await screen.findByRole("textbox", {
      name: "Search commands",
    })
    fireEvent.change(input, { target: { value: "post" } })
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /New post/i })).toBeVisible()
    })

    fireEvent.keyDown(input, { key: "Enter", isComposing: false })

    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalledWith("/admin/pages/new?type=post")
    })
  })

  test("renders navigation, search, creation, and page status in French", async () => {
    mocks.pages = [
      {
        _id: "page-1",
        localizedTitles: { fr: "Bonjour" },
        slug: "bonjour",
        status: "published",
        pageType: "page",
        updatedAt: 1,
      },
    ]
    renderPalette("fr")

    fireEvent.click(
      screen.getByRole("button", { name: "Ouvrir la palette de commandes" })
    )

    const search = await screen.findByRole("textbox", {
      name: "Rechercher des commandes",
    })
    expect(search).toHaveAttribute(
      "placeholder",
      "Rechercher des pages, des actions ou des paramètres…"
    )
    expect(
      screen.getByRole("button", { name: /Tableau de bord/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Nouveau contenu : article/i })
    ).toBeInTheDocument()
    expect(screen.getByText("/bonjour · publié")).toBeInTheDocument()

    fireEvent.change(search, { target: { value: "aucune correspondance" } })
    expect(
      await screen.findByText("Aucune commande trouvée")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Essayez le titre d’une page, une section de l’administration ou le nom d’une action."
      )
    ).toBeInTheDocument()
  })
})

test.each(["loading", "off", "on", "needs_setup", "error"])(
  "Redirects palette gate %s",
  (gate) => {
    moduleTestGate.state = gate
    renderPalette()
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    expect(screen.queryByText("Redirects") !== null).toBe(
      gate === "on" || gate === "needs_setup"
    )
  }
)

test.each(["off", "error"])("reactive palette teardown on %s", (gate) => {
  moduleTestGate.state = "on"
  const view = renderPalette()
  fireEvent.keyDown(window, { key: "k", ctrlKey: true })
  expect(screen.getByText("Redirects")).toBeInTheDocument()
  moduleTestGate.state = gate
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminCommandPaletteProvider>
        <div>Child</div>
      </AdminCommandPaletteProvider>
    </NextIntlClientProvider>
  )
  expect(screen.queryByText("Redirects")).not.toBeInTheDocument()
  expect(screen.getByText("Child")).toBeInTheDocument()
})
