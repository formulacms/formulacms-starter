import { isActiveContentType } from "@/convex/lib/contentTypes"
const moduleTestGate = vi.hoisted(() => ({ state: "off" }))
vi.mock("./admin-module-state-provider", () => ({ useModuleGate: () => ({ state: moduleTestGate.state }) }))
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../messages/admin/en.json"
import fr from "../../messages/admin/fr.json"

const replace = vi.fn()
const refresh = vi.fn()
const mutate = vi.fn()
const confirm = vi.fn()
const snapshotResults: Array<Record<string, unknown>> = []
const { toastError, toastMessage, toastSuccess, useQuery } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  useQuery: vi.fn(),
}))

const siteConfig = {
  defaultLocale: "en",
  enabledLocales: ["en", "fr"],
  timezone: "UTC",
}

const ownerSession = {
  ownerId: "owner-1",
  authId: "owner-auth-1",
  email: "owner@example.com",
  role: "admin" as const,
}

type RevalidationHealth = {
  recentAttempts: unknown[]
  consecutiveFailureCount: number
  consecutiveFailureCountCapped: boolean
  unconfigured: boolean
  updateState?: string
}

function list(
  locale: "en" | "fr" = "en",
  messages: typeof en = locale === "fr" ? fr : en
) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <PagesListClient />
    </NextIntlClientProvider>
  )
}

function renderWithHealth(
  health: RevalidationHealth | undefined,
  owner:
    | { ownerId: string; authId: string; email: string; role: "admin" }
    | null
    | undefined = {
    ownerId: "owner-1",
    authId: "owner-auth-1",
    email: "owner@example.com",
    role: "admin",
  },
  locale: "en" | "fr" = "en",
  messages: typeof en = locale === "fr" ? fr : en
) {
  useQuery.mockImplementation((reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/settings:getSiteConfig") return siteConfig
    if (name === "cms/owner:getOwnerSession") {
      return owner
    }
    if (name === "cms/revalidate:getRevalidationHealth") {
      return args === "skip" ? undefined : health
    }
    return undefined
  })
  return render(list(locale, messages))
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/pages",
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
  useMutation: () => mutate,
  // Like Convex, a skipped list reads as still loading its first page.
  usePaginatedQuery: (_query: unknown, args: unknown) =>
    args === "skip"
      ? { loadMore: vi.fn(), results: [], status: "LoadingFirstPage" }
      : { loadMore: vi.fn(), results: snapshotResults, status: "Exhausted" },
  useQuery,
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => confirm,
}))

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    message: toastMessage,
    success: toastSuccess,
  },
}))

vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))

vi.mock("@/lib/admin/content-types", () => ({
  adminContentTypeSingularMessageKey: (type: string) => `${type}.singular`,
  adminContentTypes: () => [
    { routable: true, singular: "Page", type: "page" },
    { routable: false, singular: "Author", type: "author" },
  ].filter(({ type }) => isActiveContentType(type)),
}))

import { PagesListClient } from "./pages-list-client"

describe("PagesListClient filters", () => {
  beforeEach(() => {
    replace.mockClear()
    refresh.mockClear()
    mutate.mockClear()
    confirm.mockReset()
    toastError.mockReset()
    snapshotResults.length = 0
    useQuery.mockReset()
  })

  it("gives every filter an accessible name", () => {
    renderWithHealth({
      recentAttempts: [],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
    })

    expect(
      screen.getByRole("combobox", { name: "Filter by content type" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Filter by status" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Filter by locale" })
    ).toBeInTheDocument()
    const language = screen.getByRole("combobox", { name: "Filter by locale" })
    fireEvent.change(language, { target: { value: "fr" } })
    expect(language).toHaveValue("fr")
    expect(language).not.toHaveClass("bg-emerald-600")
    expect(screen.getByRole("option", { name: "FR", selected: true })).not.toHaveClass("bg-emerald-600")
  })

  it("keeps the warning quiet while revalidation health is loading", () => {
    renderWithHealth(undefined)

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the warning quiet for an unrelated identity", () => {
    renderWithHealth(
      {
        recentAttempts: [],
        consecutiveFailureCount: 2,
        consecutiveFailureCountCapped: false,
        unconfigured: false,
      },
      null
    )

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the warning quiet with no attempts or a healthy latest attempt", () => {
    const { rerender } = renderWithHealth({
      recentAttempts: [],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
    })

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()

    useQuery.mockImplementation((reference: unknown, args: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") return siteConfig
      if (name === "cms/owner:getOwnerSession") return ownerSession
      if (name === "cms/revalidate:getRevalidationHealth") {
        return args === "skip"
          ? undefined
          : {
              recentAttempts: [{ status: "ok" }],
              consecutiveFailureCount: 0,
              consecutiveFailureCountCapped: false,
              unconfigured: false,
            }
      }
      return undefined
    })
    rerender(list())

    const healthCall = useQuery.mock.calls.find(
      ([reference]) =>
        getFunctionName(reference as never) ===
        "cms/revalidate:getRevalidationHealth"
    )
    expect(healthCall?.[1]).toEqual({})
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("no address: a neutral hint with a link to the Site address field, no count, no Retry", () => {
    renderWithHealth({
      recentAttempts: [],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: true,
      updateState: "no_address",
    })

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Add the site address so the public site updates."
    )
    expect(screen.getByRole("link", { name: "site address" })).toHaveAttribute(
      "href",
      "/admin/settings#siteUrl"
    )
    expect(screen.queryByRole("button", { name: "Retry now" })).not.toBeInTheDocument()
    expect(screen.queryByText(/recent update attempt/)).not.toBeInTheDocument()
  })

  it("names the archive confirmation after the action", async () => {
    snapshotResults.push({
      _id: "page-1",
      pageType: "page",
      slug: "fixture",
      status: "draft",
      updatedAt: 1,
      lifecycleState: "draft",
      lifecycleGeneration: 2,
      content: { en: { title: "Fixture", blocks: [] } },
    })
    confirm.mockResolvedValue(false)
    useQuery.mockImplementation((reference: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/publication:getAdminAuthority") return "snapshot_active"
      if (name === "cms/settings:getSiteConfig") return siteConfig
      if (name === "cms/owner:getOwnerSession") return ownerSession
      return undefined
    })
    render(list())

    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Actions for/ }),
      { button: 0, ctrlKey: false }
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }))

    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      title: en.pages.list.archiveDialog.title,
      description: en.pages.list.archiveDialog.description,
      confirmText: "Archive",
    })
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    ["incomplete", "Finish connecting public updates: add the private code."],
    ["updating", "Updating…"],
    ["local_unreachable", "Local site — nothing to send"],
  ])("%s: a neutral line, no alert and no Retry", (updateState, text) => {
    renderWithHealth({
      recentAttempts: [],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
      updateState,
    })

    expect(screen.getByRole("status")).toHaveTextContent(text)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry now" })).not.toBeInTheDocument()
  })

  it("ok: no banner at all", () => {
    renderWithHealth({
      recentAttempts: [{ status: "ok" }],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
      updateState: "ok",
    })

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument()
  })

  it("failed: a warning with the failure count, a settings link and Retry", async () => {
    mutate.mockResolvedValue({ requeued: 2, moreRemain: false })
    renderWithHealth({
      recentAttempts: [
        { status: "network_error" },
        { status: "http_error", httpStatus: 503 },
      ],
      consecutiveFailureCount: 2,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
      updateState: "failed",
    })

    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("2 recent update attempts failed")
    expect(
      screen.getByRole("link", { name: "Open General Settings" })
    ).toHaveAttribute("href", "/admin/settings")
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Public-site updates were queued again."
      )
    )
  })

  it("failed with an unconfigured address at Retry is a plain message, not an error", async () => {
    mutate.mockResolvedValue({ ok: false, code: "REVALIDATION_UNCONFIGURED" })
    renderWithHealth({
      recentAttempts: [],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
      updateState: "failed",
    })

    expect(screen.getByRole("alert")).not.toHaveTextContent("recent update attempt")
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))
    await waitFor(() => expect(toastMessage).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
  })

  it("states capped failure counts without false precision", () => {
    renderWithHealth({
      recentAttempts: [],
      consecutiveFailureCount: 50,
      consecutiveFailureCountCapped: true,
      unconfigured: false,
      updateState: "failed",
    })

    expect(screen.getByRole("alert")).toHaveTextContent(
      "At least 50 recent update attempts failed"
    )
  })

  it("skips health for an unrelated identity while keeping filters accessible", () => {
    renderWithHealth(
      {
        recentAttempts: [],
        consecutiveFailureCount: 2,
        consecutiveFailureCountCapped: false,
        unconfigured: false,
      },
      null
    )

    const healthCall = useQuery.mock.calls.find(
      ([reference]) =>
        getFunctionName(reference as never) ===
        "cms/revalidate:getRevalidationHealth"
    )
    expect(healthCall?.[1]).toBe("skip")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Filter by content type" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Filter by status" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Filter by locale" })
    ).toBeInTheDocument()
  })

  it("renders the content-list controls in French", () => {
    renderWithHealth(
      {
        recentAttempts: [],
        consecutiveFailureCount: 0,
        consecutiveFailureCountCapped: false,
        unconfigured: false,
      },
      ownerSession,
      "fr"
    )

    expect(
      screen.getByRole("combobox", { name: "Filtrer par type de contenu" })
    ).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Page" })).toBeInTheDocument()
    if (isActiveContentType("author")) {
      expect(
        screen.getByRole("option", { name: "Auteur — sans URL publique" })
      ).toBeInTheDocument()
    } else {
      expect(screen.queryByRole("option", { name: /Auteur/ })).toBeNull()
    }
    expect(
      screen.getByRole("combobox", { name: "Filtrer par état" })
    ).toHaveDisplayValue("Tous les états")
    expect(screen.getAllByText("Chargement…")).toHaveLength(2)
  })

  // Pins today's behaviour for an unfinished publishing setup: the list
  // keeps loading and shows no notice. A notice waits for the owner.
  it("keeps loading, with no notice, when publishing is not set up", () => {
    useQuery.mockImplementation((reference: unknown, args: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/publication:getAdminAuthority") return "invalid"
      if (name === "cms/settings:getSiteConfig") return siteConfig
      if (name === "cms/owner:getOwnerSession") return ownerSession
      if (name === "cms/revalidate:getRevalidationHealth") {
        return args === "skip"
          ? undefined
          : {
              recentAttempts: [],
              consecutiveFailureCount: 0,
              consecutiveFailureCountCapped: false,
              unconfigured: false,
            }
      }
      return undefined
    })
    render(list())

    expect(screen.getAllByText("Loading…")).toHaveLength(2)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    const status = screen.getByRole("combobox", { name: "Filter by status" })
    expect(
      [...status.querySelectorAll("option")].map((option) => option.textContent)
    ).toEqual(["All statuses", "published", "draft", "archived"])
    expect(
      screen.getByRole("combobox", { name: "Filter by locale" })
    ).toHaveDisplayValue("EN")
  })

  it.each([
    {
      locale: "en" as const,
      messages: en,
      code: "PAGE_SOFT_DELETE_MENU_REFERENCE",
      expected:
        "This page is still used in a live menu. Remove the menu link, then try again.",
      action: "Move to trash",
    },
    {
      locale: "fr" as const,
      messages: fr,
      code: "PAGE_SOFT_DELETE_MENU_REFERENCE",
      expected:
        "Cette page est encore utilisée dans un menu actif. Retirez le lien du menu, puis réessayez.",
      action: "Déplacer vers la corbeille",
    },
    {
      locale: "en" as const,
      messages: en,
      code: "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE",
      expected:
        "A published page still uses this one. Remove it from that page and publish the change, then try again.",
      action: "Move to trash",
    },
    {
      locale: "fr" as const,
      messages: fr,
      code: "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE",
      expected:
        "Une page publiée utilise encore celle-ci. Retirez-la de cette page, publiez la modification, puis réessayez.",
      action: "Déplacer vers la corbeille",
    },
  ])("maps $code to localized plain copy", async (fixture) => {
    snapshotResults.push({
      _id: "page-1",
      pageType:
        fixture.code === "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE"
          ? "author"
          : "page",
      slug: "fixture",
      status: "archived",
      updatedAt: 1,
      lifecycleState: "archived",
      lifecycleGeneration: 2,
      content: { en: { title: "Fixture", blocks: [] } },
    })
    confirm.mockResolvedValue(true)
    mutate.mockRejectedValue(
      new ConvexError({ code: fixture.code, truncated: false })
    )
    useQuery.mockImplementation((reference: unknown, args: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/publication:getAdminAuthority") {
        return "snapshot_active"
      }
      if (name === "cms/settings:getSiteConfig") return siteConfig
      if (name === "cms/owner:getOwnerSession") return ownerSession
      if (name === "cms/revalidate:getRevalidationHealth") {
        return args === "skip"
          ? undefined
          : {
              recentAttempts: [],
              consecutiveFailureCount: 0,
              consecutiveFailureCountCapped: false,
              unconfigured: false,
            }
      }
      return undefined
    })
    render(list(fixture.locale, fixture.messages))

    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Actions for|Actions pour/ }),
      { button: 0, ctrlKey: false }
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: fixture.action }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(fixture.expected))
    expect(refresh).not.toHaveBeenCalled()
  })
})
