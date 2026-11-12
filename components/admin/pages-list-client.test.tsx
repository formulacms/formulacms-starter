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
  usePaginatedQuery: () => ({
    loadMore: vi.fn(),
    results: snapshotResults,
    status: "Exhausted",
  }),
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

vi.mock("@/components/admin/duplicate-page-dialog", () => ({
  DuplicatePageDialog: () => null,
}))

vi.mock("@/lib/admin/content-types", () => ({
  adminContentTypeSingularMessageKey: (type: string) => `${type}.singular`,
  adminContentTypes: () => [
    { routable: true, singular: "Page", type: "page" },
    { routable: false, singular: "Author", type: "author" },
  ],
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
    expect(
      screen.getByRole("option", { name: "Auteur — sans URL publique" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Filtrer par état" })
    ).toHaveDisplayValue("Tous les états")
    expect(screen.getAllByText("Chargement…")).toHaveLength(2)
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
        "This Author is still used by a published Post. Remove it from the Post and publish that change, then try again.",
      action: "Move to trash",
    },
    {
      locale: "fr" as const,
      messages: fr,
      code: "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE",
      expected:
        "Cet Auteur est encore utilisé par un Article publié. Retirez-le de l’Article, publiez la modification, puis réessayez.",
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
      content: { en: { title: "Fixture", slices: [] } },
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

const rowScenarios = (["en", "fr"] as const).flatMap((locale) =>
  [false, true].flatMap((multilingual) =>
    ["Short title", "Annual community health report ".repeat(4).trim(), "社区健康计划与区域合作伙伴关系年度报告".repeat(4)].flatMap((title, titleKind) =>
      ["about", "annual-report-community-health-programmes-regional-partnerships-2026", "report-communityhealthprogrammesandregionalpartnerships2026"].map((slug) => ({ locale, multilingual, title, titleKind, slug }))
    )
  )
)

describe("approved Pages row structure", () => {
  beforeEach(() => {
    snapshotResults.length = 0
    useQuery.mockReset()
  })

  it.each(rowScenarios)("$locale M05=$multilingual title=$titleKind URL=$slug", async ({ locale, multilingual, title, titleKind, slug }) => {
    const contentLocale = titleKind === 2 ? "zh" : locale
    const copy = (locale === "fr" ? fr : en).pages.list
    const enabledLocales = ["en", "fr", "es", "it", "pt", "pt-br", "nl", "sv", "pl", "ru", "tr", "hi", "zh", "ja", "ko"]
    snapshotResults.push({
      _id: "layout-page", pageType: "page", slug, status: "draft", updatedAt: 1,
      scheduledAt: Date.UTC(2026, 10, 4, 14),
      content: { [contentLocale]: { title, slices: [] } },
    })
    useQuery.mockImplementation((reference: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/publication:getAdminAuthority") return "legacy"
      if (name === "cms/settings:getSiteConfig") return { ...siteConfig, defaultLocale: contentLocale, enabledLocales }
      if (name === "cms/owner:getOwnerSession") return ownerSession
      if (name === "cms/multilingual:getMultilingualState") throw new Error("visibility must use shared gate")
      return undefined
    })
    moduleTestGate.state = multilingual ? "on" : "off"
    const view = render(list(locale))
    const link = screen.getByRole("link", { name: title })
    expect(link).toHaveClass("block", "min-w-0", "wrap-break-word")
    expect(link.className).not.toMatch(/truncate|line-clamp/)
    expect(link).not.toHaveAttribute("title")
    expect(link).toHaveAttribute("lang", contentLocale)
    expect(link).toHaveAttribute("dir", "auto")
    const identity = link.parentElement!
    expect(identity).toHaveClass("min-w-[140px]", "flex-1")
    expect(identity.parentElement).toHaveClass("flex-wrap", "items-start", "gap-x-4", "gap-y-2")
    const url = identity.querySelector("[title]")!
    expect(url).toHaveAttribute("title", slug)
    expect(url).toHaveAttribute("lang", contentLocale)
    expect(url).toHaveAttribute("dir", "auto")
    expect(url.firstElementChild).toHaveClass("min-w-0", "truncate")
    const bounded = slug.length > 32 && slug.endsWith("-2026")
    expect(url.children).toHaveLength(bounded ? 2 : 1)
    if (bounded) {
      expect(url.lastElementChild).toHaveClass("shrink-0", "max-w-1/2", "truncate")
      expect(url.lastElementChild).toHaveTextContent("-2026")
    }
    const schedule = identity.querySelector('[data-slot="badge"]')!
    expect(schedule).toHaveClass("h-auto", "min-h-5", "overflow-visible", "whitespace-normal", "wrap-break-word")
    expect(schedule).not.toHaveClass("h-5", "overflow-hidden", "hidden", "lg:inline-flex")
    expect(schedule.children).toHaveLength(2) // icon + one complete translated text run
    expect(schedule.lastElementChild!.childNodes).toHaveLength(1)
    expect(schedule.textContent).toMatch(locale === "en" ? /^Publishes / : /^Publication /)
    const label = copy.languagesDetails.replace("{translated}", "1").replace("{total}", "15")
    if (!multilingual) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument()
      expect(view.container.querySelector(".w-28")).toBeNull()
      return
    }
    const languages = screen.getByRole("button", { name: label })
    expect(languages).toHaveTextContent("1/15")
    expect(languages).toHaveClass("hidden", "sm:inline-flex", "w-28", "tabular-nums", "border-amber-400")
    expect(languages.querySelector(".lucide-x")).not.toBeNull()
    expect(languages.parentElement).toHaveClass("sm:-mt-1.5")
    fireEvent.click(languages)
    const popover = await screen.findByRole("dialog", { name: copy.languages })
    expect(popover).toHaveClass("max-w-[calc(100vw-2rem)]")
    expect(popover.querySelectorAll("li")).toHaveLength(15)
    const names = popover.querySelectorAll('li > span[lang]')
    expect(names).toHaveLength(15)
    for (const name of names) {
      expect(name).toHaveClass("min-w-0", "flex-1", "wrap-break-word")
      expect(name).toHaveAttribute("dir", "auto")
      expect(name.parentElement!.querySelector("a")).toHaveAttribute("href", `/admin/pages/layout-page?locale=${name.getAttribute("lang")}`)
    }
    expect(popover.querySelector("li .sr-only")).toHaveTextContent(copy.missingTranslation)
    fireEvent.keyDown(popover, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(languages).toHaveFocus()
  })

  it.each(["en", "fr"] as const)("%s shows complete status and wrapping default URL name", (locale) => {
    const copy = (locale === "fr" ? fr : en).pages.list
    snapshotResults.push({ _id: "complete", pageType: "page", slug: "about", status: "published", updatedAt: 1,
      expiresAt: Date.UTC(2026, 11, 31, 22),
      content: { en: { title: "English title", slices: [] }, fr: { title: "Titre français", slices: [] } },
    })
    useQuery.mockImplementation((reference: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/publication:getAdminAuthority") return "legacy"
      if (name === "cms/settings:getSiteConfig") return siteConfig
      if (name === "cms/owner:getOwnerSession") return ownerSession
      if (name === "cms/multilingual:getMultilingualState") throw new Error("visibility must use shared gate")
      return undefined
    })
    moduleTestGate.state = "on"
    render(list(locale))
    const languages = screen.getByRole("button", { name: copy.languagesDetails.replace("{translated}", "2").replace("{total}", "2") })
    expect(languages).toHaveTextContent("2/2")
    expect(languages).toHaveClass("text-muted-foreground")
    expect(languages.querySelector(".lucide-check")).not.toBeNull()
    fireEvent.change(screen.getByRole("combobox", { name: copy.filters.locale }), { target: { value: "fr" } })
    const badge = screen.getByText(copy.defaultSlug)
    expect(badge).toHaveClass("h-auto", "whitespace-normal", "overflow-visible")
    expect(badge.childNodes).toHaveLength(1)
    expect(badge.children).toHaveLength(0)
    expect(screen.queryByText(copy.missingLocaleContent.replace("{locale}", "FR"))).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Titre français" })).toHaveAttribute("lang", "fr")
  })
})

const frenchBodyWithoutTitle = { title: "", slices: [{ id: "body-fr", type: "rich-text-body", enabled: true, primary: { body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Bonjour" }] }] }) } }] }
const provenanceCases = [
  { name: "localized title, default slug", filter: "fr", content: { fr: { title: "Bonjour" } }, title: "Bonjour", titleLocale: "fr", slugLocale: "en" },
  { name: "localized title and slug", filter: "fr", content: { fr: { title: "Bonjour" } }, localizedSlugs: { fr: "bonjour" }, title: "Bonjour", titleLocale: "fr", slug: "bonjour", slugLocale: "fr" },
  { name: "admin placeholder", filter: "fr", content: { en: { title: "Hello" }, fr: frenchBodyWithoutTitle }, titleLocale: undefined, slugLocale: "en" },
  { name: "all French-first content", filter: "all", content: { fr: { title: "Bonjour" }, en: { title: "Hello" } }, title: "Bonjour", titleLocale: "fr", slugLocale: "en" },
  { name: "all empty first content uses effective key", filter: "all", content: { en: { title: "" }, fr: { title: "Unused second content" } }, effectiveTitles: { fr: "Titre effectif" }, title: "Titre effectif", titleLocale: "fr", slugLocale: "en" },
  { name: "all localized title has priority", filter: "all", content: {}, localizedTitles: { fr: "Titre localisé" }, effectiveTitles: { en: "Old effective title" }, title: "Titre localisé", titleLocale: "fr", slugLocale: "en" },
  { name: "all untitled inherits admin", filter: "all", content: {}, titleLocale: undefined, slugLocale: "en" },
  { name: "single staged title", filter: "fr", content: {}, effectiveTitles: { fr: "Titre effectif" }, title: "Titre effectif", titleLocale: "fr", slugLocale: "en" },
  { name: "unknown default omits slug language", filter: "all", content: { fr: { title: "Bonjour" } }, unknownDefault: true, title: "Bonjour", titleLocale: "fr", slugLocale: undefined },
  { name: "missing slug literal inherits admin", filter: "fr", content: { fr: frenchBodyWithoutTitle }, slug: "", titleLocale: undefined, slugLocale: undefined },
]

describe.each(["en", "fr"] as const)("Pages row language provenance, admin %s", (adminLocale) => {
  it.each(provenanceCases)("$name", (scenario) => {
    snapshotResults.length = 0
    const copy = (adminLocale === "en" ? en : fr).pages.list
    const slug = scenario.slug ?? "about"
    const shownSlug = scenario.filter === "fr" && !slug ? "missing-slug" : slug
    snapshotResults.push({ _id: "provenance", pageType: "page", status: "draft", updatedAt: 1, ...scenario, slug })
    useQuery.mockImplementation((reference: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/publication:getAdminAuthority") return "legacy"
      if (name === "cms/settings:getSiteConfig") return { enabledLocales: ["en", "fr"], defaultLocale: scenario.unknownDefault ? undefined : "en" }
      if (name === "cms/multilingual:getMultilingualState") throw new Error("visibility must use shared gate")
      return undefined
    })
    render(list(adminLocale))
    fireEvent.change(screen.getByRole("combobox", { name: copy.filters.locale }), { target: { value: scenario.filter } })
    const title = scenario.title ?? (scenario.filter === "all" ? copy.untitled : copy.missingLocaleTitle.replace("{locale}", "FR"))
    const link = screen.getByRole("link", { name: title })
    if (scenario.titleLocale) expect(link).toHaveAttribute("lang", scenario.titleLocale)
    else expect(link).not.toHaveAttribute("lang")
    const url = link.parentElement!.querySelector("[title]")!
    expect(url).toHaveAttribute("title", shownSlug)
    if (scenario.slugLocale) expect(url).toHaveAttribute("lang", scenario.slugLocale)
    else expect(url).not.toHaveAttribute("lang")
    expect(link).toHaveAttribute("href", `/admin/pages/provenance${scenario.filter === "all" ? "" : "?locale=fr"}`)
  })
})

it.each(["loading", "off", "on", "error"])("Pages gate %s controls contributions and closes open details", (gate) => {
  snapshotResults.length = 0
  snapshotResults.push({ _id: "gate-page", pageType: "page", slug: "gate-page", status: "draft", updatedAt: 1, content: { en: { title: "Gate page", slices: [] } } })
  useQuery.mockImplementation((reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/publication:getAdminAuthority") return "legacy"
    if (name === "cms/settings:getSiteConfig") return siteConfig
    if (name === "cms/owner:getOwnerSession") return ownerSession
    if (name === "cms/multilingual:getMultilingualState") return { moduleEnabled: true }
    return undefined
  })
  moduleTestGate.state = "on"
  const view = render(list("en"))
  const label = en.pages.list.languagesDetails.replace("{translated}", "1").replace("{total}", "2")
  const button = screen.getByRole("button", { name: label })
  fireEvent.click(button)
  moduleTestGate.state = gate
  view.rerender(list("en"))
  expect(screen.queryByRole("button", { name: label }) !== null).toBe(gate === "on")
  expect(screen.queryByRole("link", { name: /Edit.*Français/ }) !== null).toBe(gate === "on")
  expect(screen.getByRole("link", { name: "Gate page" })).toBeInTheDocument()
})
