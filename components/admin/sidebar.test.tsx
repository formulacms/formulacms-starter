const moduleTestGate = vi.hoisted(() => ({ state: "on" }))
vi.mock("./admin-module-state-provider", () => ({
  useModuleGate: () => ({ state: moduleTestGate.state }),
}))
import {
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { AdminSidebar } from "./sidebar"

const mocks = vi.hoisted(() => ({
  archived: undefined as string[] | undefined,
  owner: null as {
    ownerId: string
    authId: string
    email: null
    displayName: string
    username: string | null
  } | null,
  push: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock("@/lib/auth/client", () => ({
  useSignOut: () => mocks.signOut,
}))

describe("AdminSidebar submission authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    moduleTestGate.state = "on"
    mocks.archived = undefined
    mocks.owner = {
      ownerId: "owner-1",
      authId: "owner-1",
      email: null,
      displayName: "Ada Owner",
      username: "ada",
    }
    mocks.useQuery.mockImplementation((reference, args) => {
      const name = getFunctionName(reference)
      if (args === "skip") return undefined
      if (name === "cms/owner:getOwnerSession") {
        return mocks.owner
      }
      if (name === "cms/formSubmissions:getCounts") {
        return { total: 3, unread: 2, failed: 0 }
      }
      if (name.endsWith("getArchivedContentTypes")) {
        return mocks.archived
      }
      return undefined
    })
  })

  test("without a Forms participant there is no inbox link or unread count (OD-4)", () => {
    renderSidebar()

    expect(screen.queryByText("Submissions")).not.toBeInTheDocument()
    expect(
      mocks.useQuery.mock.calls.some(
        ([reference]) =>
          getFunctionName(reference) === "cms/formSubmissions:getCounts"
      )
    ).toBe(false)
    expect(screen.queryByLabelText("2 unread")).not.toBeInTheDocument()
  })

  test("the owner sees the core navigation", () => {
    renderSidebar()

    expect(screen.getByText("Content")).toBeInTheDocument()
    expect(screen.getByText("Archive")).toBeInTheDocument()
  })

  test("shows one Content entry instead of individual content types", () => {
    renderSidebar()

    expect(screen.getByText("Content")).toBeInTheDocument()
    expect(screen.queryByText("Posts")).not.toBeInTheDocument()
    expect(screen.queryByText("Reference")).not.toBeInTheDocument()
  })

  test("shows the fixed Admin identity with the owner's username", () => {
    renderSidebar()

    expect(screen.getByText("Admin")).toBeInTheDocument()
    expect(screen.getByText("ada")).toBeInTheDocument()
    expect(screen.queryByText("Ada Owner")).not.toBeInTheDocument()
    expect(screen.queryByText("owner-1")).not.toBeInTheDocument()
  })

  test("does not render an identity for an unrelated signed-in account", () => {
    mocks.owner = null

    renderSidebar()

    expect(screen.queryByText("Admin")).not.toBeInTheDocument()
  })

  test("renders the fixed identity and navigation in French", () => {
    renderSidebar("fr")

    expect(screen.getByText("Tableau de bord")).toBeInTheDocument()
    expect(screen.getByText("Administrateur")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Se déconnecter" })
    ).toBeInTheDocument()
  })
})

function renderSidebar(locale: "en" | "fr" = "en") {
  return renderWithTestingLibrary(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <AdminSidebar />
    </NextIntlClientProvider>
  )
}

test.each(["loading", "off", "on", "needs_setup", "error"])(
  "Redirects sidebar gate %s",
  (gate) => {
    moduleTestGate.state = gate
    renderSidebar()
    expect(screen.queryByRole("link", { name: "Redirects" }) !== null).toBe(
      gate === "on" || gate === "needs_setup"
    )
    expect(screen.getByRole("link", { name: "Content" })).toBeInTheDocument()
  }
)

test.each(["off", "error"])("reactive sidebar teardown on %s", (gate) => {
  moduleTestGate.state = "on"
  const view = renderSidebar()
  expect(screen.getByRole("link", { name: "Redirects" })).toBeInTheDocument()
  moduleTestGate.state = gate
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar />
    </NextIntlClientProvider>
  )
  expect(
    screen.queryByRole("link", { name: "Redirects" })
  ).not.toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Content" })).toBeInTheDocument()
})

test("the fixed sidebar hides below md; the Sheet variant is content-fit and reports a link choice", () => {
  moduleTestGate.state = "on"
  const onNavigate = vi.fn()
  const view = renderSidebar()
  expect(screen.getAllByRole("complementary")[0]).toHaveClass(
    "fixed",
    "hidden",
    "md:flex",
    "w-60"
  )
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar
        variant="sheet"
        onNavigate={onNavigate}
        headerAction={<button type="button">Hide sidebar</button>}
      />
    </NextIntlClientProvider>
  )
  const aside = screen.getAllByRole("complementary")[0]
  expect(aside).toHaveClass("w-fit", "h-full")
  for (const name of ["fixed", "hidden", "w-60"]) {
    expect(aside).not.toHaveClass(name)
  }
  expect(
    screen.getByRole("button", { name: "Hide sidebar" })
  ).toBeInTheDocument()
  const content = screen.getByRole("link", { name: "Content" })
  content.addEventListener("click", (event) => event.preventDefault())
  fireEvent.click(content)
  expect(onNavigate).toHaveBeenCalledTimes(1)
})
