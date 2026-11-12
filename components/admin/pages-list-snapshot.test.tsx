import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { ConvexError } from "convex/values"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../messages/admin/en.json"
import fr from "../../messages/admin/fr.json"

const push = vi.fn()
const refresh = vi.fn()
const confirm = vi.fn()
const convexQuery = vi.fn()
const mutations: Record<string, ReturnType<typeof vi.fn>> = {}
const rows: Array<Record<string, unknown>> = []
const { toastError, toastSuccess, useQuery } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/pages",
  useRouter: () => ({ replace: vi.fn(), refresh, push }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: convexQuery }),
  useMutation: (reference: unknown) =>
    (mutations[getFunctionName(reference as never)] ??= vi.fn()),
  usePaginatedQuery: () => ({
    loadMore: vi.fn(),
    results: rows,
    status: "Exhausted",
  }),
  useQuery,
}))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => confirm,
}))
vi.mock("sonner", () => ({
  toast: { error: toastError, message: vi.fn(), success: toastSuccess },
}))
vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))
vi.mock("@/components/admin/duplicate-page-dialog", () => ({
  DuplicatePageDialog: () => <div data-testid="duplicate-dialog" />,
}))
vi.mock("@/lib/admin/content-types", () => ({
  adminContentTypeSingularMessageKey: (type: string) => `${type}.singular`,
  adminContentTypes: () => [{ routable: true, singular: "Page", type: "page" }],
}))

import { PagesListClient } from "./pages-list-client"

const HOME = "home-page"
const siteConfig = (extra: Record<string, unknown> = {}) => ({
  defaultLocale: "en",
  enabledLocales: ["en", "fr"],
  homePageId: HOME,
  timezone: "UTC",
  ...extra,
})

type Locale = {
  locale: string
  state: "published" | "draft" | "not_translated"
  title?: string
  path?: string | null
}
function entry(l: Locale, extra: Record<string, unknown> = {}) {
  return {
    draftGeneration: 3,
    publicGeneration: 5,
    releaseGeneration: 7,
    ...(l.state === "published"
      ? { currentSnapshotId: `snap-${l.locale}` }
      : {}),
    ...l,
    ...extra,
  }
}
function page(
  id: string,
  locales: Locale[],
  extra: Record<string, unknown> = {}
) {
  return {
    _id: id,
    pageType: "page",
    slug: id,
    localizedSlugs: {},
    localizedTitles: {},
    status: "draft",
    lifecycleState: "active",
    lifecycleGeneration: 11,
    sharedDraftGeneration: 13,
    updatedAt: 1,
    locales: locales.map((l) => entry(l)),
    ...extra,
  }
}

function mount(
  opts: {
    admin?: "en" | "fr" | "de"
    config?: Record<string, unknown>
    authority?: string | undefined
  } = {}
) {
  const admin = opts.admin ?? "en"
  const messages = admin === "fr" ? fr : en
  useQuery.mockImplementation((reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/publication:getAdminAuthority") {
      return "authority" in opts ? opts.authority : "snapshot_active"
    }
    if (name === "cms/settings:getSiteConfig") return siteConfig(opts.config)
    if (name === "cms/owner:getOwnerSession") return null
    return undefined
  })
  const tree = (locale: string) => (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : (messages as typeof en)}
    >
      <PagesListClient />
    </NextIntlClientProvider>
  )
  const view = render(tree(admin))
  return { ...view, tree }
}

function openMenu(name: RegExp | string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  })
}

const copy = en.pages.list

/** A status badge, not the filter option with the same words. */
const badges = (text: string) =>
  screen.queryAllByText(text, { selector: "[data-slot=badge]" })

beforeEach(() => {
  push.mockReset()
  refresh.mockReset()
  confirm.mockReset()
  convexQuery.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  useQuery.mockReset()
  rows.length = 0
  for (const key of Object.keys(mutations)) delete mutations[key]
  // Defaults: notice absent, checklist clean.
  convexQuery.mockImplementation(async (reference: unknown) =>
    getFunctionName(reference as never) === "cms/pages:getPrePublishChecklist"
      ? { canPublish: true, blockers: [], warnings: [] }
      : null
  )
})

const about = () =>
  page("about", [
    { locale: "en", state: "published", title: "About us", path: "/about" },
    { locale: "fr", state: "draft", title: "À propos", path: "/a-propos" },
  ])
const contact = () =>
  page("contact", [
    { locale: "en", state: "draft", title: "Contact", path: "/contact" },
  ])
const home = () =>
  page(
    HOME,
    [
      { locale: "en", state: "published", title: "Welcome", path: "/" },
      { locale: "fr", state: "published", title: "Bienvenue", path: "/" },
    ],
    { slug: "home" }
  )

describe("Pages list language selector", () => {
  it("opens on the admin language when it is a site language, else on the site default", () => {
    rows.push(about())
    const fr_ = mount({ admin: "fr" })
    expect(
      screen.getByRole("combobox", { name: "Filtrer par langue" })
    ).toHaveValue("fr")
    fr_.unmount()
    mount({ admin: "de" })
    expect(
      screen.getByRole("combobox", { name: copy.filters.locale })
    ).toHaveValue("en")
  })

  it("follows the admin language live and offers All languages first", () => {
    rows.push(about())
    const view = mount({ admin: "en" })
    const select = screen.getByRole("combobox", { name: copy.filters.locale })
    expect(select).toHaveValue("en")
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["All languages", "EN", "FR"])
    view.rerender(view.tree("fr"))
    expect(
      screen.getByRole("combobox", { name: "Filtrer par langue" })
    ).toHaveValue("fr")
  })

  it("changing it changes the rows only, never the interface language", () => {
    rows.push(about())
    mount()
    expect(screen.getByRole("link", { name: "About us" })).toBeInTheDocument()
    fireEvent.change(
      screen.getByRole("combobox", { name: copy.filters.locale }),
      {
        target: { value: "fr" },
      }
    )
    expect(screen.getByRole("link", { name: "À propos" })).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: copy.filters.status })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("combobox", { name: "Filtrer par état" })
    ).toBeNull()
  })
})

describe("Pages list Reset filters", () => {
  it("is absent on first load and returns to the opening language when used", () => {
    rows.push(about())
    mount({ admin: "fr" })
    expect(screen.queryByRole("button", { name: "Réinitialiser les filtres" })).toBeNull()
    const locale = screen.getByRole("combobox", { name: "Filtrer par langue" })
    fireEvent.change(locale, { target: { value: "en" } })
    fireEvent.click(screen.getByRole("button", { name: "Réinitialiser les filtres" }))
    expect(locale).toHaveValue("fr")
    expect(screen.queryByRole("button", { name: "Réinitialiser les filtres" })).toBeNull()
  })

  it("shows for a changed status or All languages, not for the opening language", () => {
    rows.push(about())
    mount()
    expect(screen.queryByRole("button", { name: copy.resetFilters })).toBeNull()
    fireEvent.change(screen.getByRole("combobox", { name: copy.filters.status }), {
      target: { value: "draft" },
    })
    expect(screen.getByRole("button", { name: copy.resetFilters })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: copy.resetFilters }))
    fireEvent.change(screen.getByRole("combobox", { name: copy.filters.locale }), {
      target: { value: "all" },
    })
    expect(screen.getByRole("button", { name: copy.resetFilters })).toBeInTheDocument()
  })
})

describe("Pages list rows from per-language data", () => {
  it("one row per page in a single language: title, address, status, row link", () => {
    rows.push(about(), contact())
    mount({ config: { defaultLocale: "en" } })
    fireEvent.change(
      screen.getByRole("combobox", { name: copy.filters.locale }),
      {
        target: { value: "fr" },
      }
    )
    // FR: About is a draft with its own address (prefixed), Contact is not translated.
    const link = screen.getByRole("link", { name: "À propos" })
    expect(link).toHaveAttribute("href", "/admin/pages/about?locale=fr")
    expect(screen.getByText("/fr/a-propos")).toBeInTheDocument()
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0)
    // Not translated: the first site language's title, muted, with a suffix and no address.
    const missing = screen.getByRole("link", { name: "Contact" })
    expect(missing).toHaveClass("text-muted-foreground")
    expect(missing.parentElement).toHaveClass("[&_a]:italic")
    expect(missing).toHaveAttribute("href", "/admin/pages/contact?locale=fr")
    expect(screen.getByText("(not translated)")).toBeInTheDocument()
    expect(screen.getAllByText("No address yet")).toHaveLength(1)
  })

  it("a language with no entry is Not translated, a null path shows nothing extra", () => {
    rows.push(
      page("only-en", [
        { locale: "en", state: "draft", title: "Only", path: null },
      ])
    )
    mount()
    expect(screen.getByRole("link", { name: "Only" })).toBeInTheDocument()
    expect(screen.queryByText("No address yet")).toBeNull()
    fireEvent.change(
      screen.getByRole("combobox", { name: copy.filters.locale }),
      {
        target: { value: "fr" },
      }
    )
    expect(badges("Not translated")).toHaveLength(1)
    expect(screen.getByText("No address yet")).toBeInTheDocument()
  })

  it("the home row shows a Home page badge and its root address, French in French", () => {
    rows.push(home())
    mount({ admin: "fr" })
    expect(screen.getByText("Page d’accueil")).toBeInTheDocument()
    expect(screen.getByText("/fr")).toBeInTheDocument()
    expect(badges("Publiée")).toHaveLength(1)
  })

  it("All languages: one separate group per page, a row per site language, default first", () => {
    rows.push(about(), contact())
    mount()
    fireEvent.change(
      screen.getByRole("combobox", { name: copy.filters.locale }),
      {
        target: { value: "all" },
      }
    )
    const groups = screen.getAllByRole("group")
    expect(groups).toHaveLength(2)
    const langRows = groups[0]!.querySelectorAll("[data-language]")
    expect([...langRows].map((r) => r.getAttribute("data-language"))).toEqual([
      "en",
      "fr",
    ])
    expect(within(groups[0]!).getByText("EN")).toHaveClass(
      "text-muted-foreground"
    )
    expect(
      within(groups[0]!).getAllByRole("button", { name: /Actions for/ })
    ).toHaveLength(2)
    // Contact has no French entry.
    expect(
      within(groups[1]!).getByText("Not translated", {
        selector: "[data-slot=badge]",
      })
    ).toBeInTheDocument()
    expect(within(groups[1]!).getByText("(not translated)")).toBeInTheDocument()
    expect(groups[0]).toHaveClass("py-5")
  })

  it("the status filter runs after expansion and includes Not translated rows", () => {
    rows.push(about(), contact())
    mount()
    const status = screen.getByRole("combobox", { name: copy.filters.status })
    expect(
      within(status)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual([
      "All statuses",
      "Published",
      "Draft",
      "Not translated",
      "Archived",
    ])
    fireEvent.change(
      screen.getByRole("combobox", { name: copy.filters.locale }),
      {
        target: { value: "fr" },
      }
    )
    fireEvent.change(status, { target: { value: "notTranslated" } })
    expect(screen.queryByRole("link", { name: "À propos" })).toBeNull()
    expect(screen.getByRole("link", { name: "Contact" })).toBeInTheDocument()
    fireEvent.change(status, { target: { value: "published" } })
    expect(screen.getByText(copy.noPagesMatch)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: copy.clearFilters }))
    // Clearing goes back to All languages with no status filter.
    expect(
      screen.getByRole("combobox", { name: copy.filters.locale })
    ).toHaveValue("all")
    expect(screen.getAllByRole("group")).toHaveLength(2)
  })

  it("status words are the same in the filter and on the rows, in French too", () => {
    rows.push(about())
    mount({ admin: "fr" })
    const status = screen.getByRole("combobox", { name: "Filtrer par état" })
    expect(
      within(status)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual([
      "Tous les états",
      "Publiée",
      "Brouillon",
      "Non traduite",
      "Archivée",
    ])
  })

  it("an archived page is one row with an Archived badge and whole-page actions only", async () => {
    rows.push(
      page(
        "old",
        [{ locale: "en", state: "published", title: "Old", path: "/old" }],
        {
          status: "archived",
          lifecycleState: "archived",
        }
      )
    )
    mount()
    expect(
      screen.getByText("Archived", { selector: "[data-slot=badge]" })
    ).toBeInTheDocument()
    openMenu(/Actions for/)
    expect(
      await screen.findByRole("menuitem", { name: "Unarchive" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: "Move to trash" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Publish" })).toBeNull()
    expect(screen.queryByText("Whole page")).toBeNull()
  })

  it("while the authority is loading nothing is mutated; legacy keeps the page-wide list", () => {
    rows.push(about())
    const loading = mount({ authority: undefined })
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull()
    loading.unmount()
    mount({ authority: "legacy" })
    // Legacy: one status vocabulary without Not translated.
    const status = screen.getByRole("combobox", { name: copy.filters.status })
    expect(
      within(status).queryByRole("option", { name: "Not translated" })
    ).toBeNull()
  })
})

describe("Pages list row menu", () => {
  it("offers this-language actions by state, then Whole page with Archive and no Duplicate", async () => {
    rows.push(about())
    mount()
    // EN is Published.
    openMenu(/Actions for About us/)
    expect(
      await screen.findByRole("menuitem", { name: "Unpublish" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Publish" })).toBeNull()
    expect(screen.getByText("Whole page")).toBeInTheDocument()
    // The server refuses to duplicate pages under snapshot authority.
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull()
    expect(
      screen.getByRole("menuitem", { name: "Archive" })
    ).toBeInTheDocument()
  })

  it("Draft offers Publish, Not translated offers Translate and opens the editor in that language", async () => {
    rows.push(contact())
    mount()
    fireEvent.change(
      screen.getByRole("combobox", { name: copy.filters.locale }),
      {
        target: { value: "fr" },
      }
    )
    openMenu(/Actions for Contact/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Translate" }))
    expect(push).toHaveBeenCalledWith("/admin/pages/contact?locale=fr")
  })

  it("the home page can't be archived: disabled with a tooltip", async () => {
    rows.push(home())
    mount()
    openMenu(/Actions for Welcome/)
    const archive = await screen.findByRole("menuitem", { name: "Archive" })
    expect(archive).toHaveAttribute("aria-disabled", "true")
    fireEvent.pointerMove(archive.parentElement!, { pointerType: "mouse" })
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "The home page can’t be archived."
    )
  })

  it("maps the home lifecycle refusal to the same sentence, in French too", async () => {
    rows.push(
      page(
        HOME,
        [{ locale: "fr", state: "draft", title: "Accueil", path: "/" }],
        {
          status: "archived",
          lifecycleState: "archived",
        }
      )
    )
    mutations["cms/publication:softDeletePage"] = vi
      .fn()
      .mockRejectedValue(new ConvexError("PAGE_HOME_LIFECYCLE_REFUSED"))
    confirm.mockResolvedValue(true)
    mount({ admin: "fr" })
    openMenu(/Actions pour/)
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Déplacer vers la corbeille",
      })
    )
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "La page d’accueil ne peut pas être archivée."
      )
    )
  })
})

describe("Pages list row Publish", () => {
  async function chooseFrenchPublish() {
    rows.push(about())
    mount()
    fireEvent.change(
      screen.getByRole("combobox", { name: copy.filters.locale }),
      {
        target: { value: "fr" },
      }
    )
    openMenu(/Actions for À propos/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Publish" }))
  }

  it("re-queries the checklist, then publishes with the row's whole captured token tuple", async () => {
    const publish = (mutations["cms/publication:publishLocale"] = vi
      .fn()
      .mockResolvedValue({
        snapshotId: "s",
        publicGeneration: 6,
        publishedAt: 1,
      }))
    await chooseFrenchPublish()
    await waitFor(() => expect(publish).toHaveBeenCalledOnce())
    expect(convexQuery).toHaveBeenCalledWith(expect.anything(), {
      pageId: "about",
      locale: "fr",
    })
    expect(publish).toHaveBeenCalledWith({
      pageId: "about",
      locale: "fr",
      expectedDraftGeneration: 3,
      expectedSharedDraftGeneration: 13,
      expectedPublicGeneration: 5,
      expectedLifecycleGeneration: 11,
      expectedReleaseGeneration: 7,
    })
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Published (FR)")
    )
    expect(refresh).toHaveBeenCalled()
  })

  it("blockers stop the publish with a toast whose action opens the editor in the row's language", async () => {
    const publish = (mutations["cms/publication:publishLocale"] = vi.fn())
    convexQuery.mockImplementation(async (reference: unknown) =>
      getFunctionName(reference as never) === "cms/pages:getPrePublishChecklist"
        ? {
            canPublish: false,
            blockers: [{ code: "missing_default_locale_title" }],
            warnings: [],
          }
        : null
    )
    await chooseFrenchPublish()
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0]![0]).toBe(
      "Resolve 1 blocker before publishing"
    )
    expect(publish).not.toHaveBeenCalled()
    const action = toastError.mock.calls[0]![1].action
    expect(action.label).toBe("Open editor")
    action.onClick()
    expect(push).toHaveBeenCalledWith("/admin/pages/about?locale=fr")
  })

  it("fails closed when the checklist cannot be read", async () => {
    const publish = (mutations["cms/publication:publishLocale"] = vi.fn())
    convexQuery.mockImplementation(async (reference: unknown) => {
      if (
        getFunctionName(reference as never) ===
        "cms/pages:getPrePublishChecklist"
      ) {
        throw new Error("offline")
      }
      return null
    })
    await chooseFrenchPublish()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        en.editor.page.prePublish.loadFailed
      )
    )
    expect(publish).not.toHaveBeenCalled()
  })

  it("asks about warnings once and publishes only when confirmed", async () => {
    const publish = (mutations["cms/publication:publishLocale"] = vi
      .fn()
      .mockResolvedValue({
        snapshotId: "s",
        publicGeneration: 6,
        publishedAt: 1,
      }))
    convexQuery.mockImplementation(async (reference: unknown) =>
      getFunctionName(reference as never) === "cms/pages:getPrePublishChecklist"
        ? {
            canPublish: true,
            blockers: [],
            warnings: [{ code: "missing_seo_title", message: "No SEO title" }],
          }
        : null
    )
    confirm.mockResolvedValue(false)
    await chooseFrenchPublish()
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(confirm.mock.calls[0]![0]).toMatchObject({
      confirmText: "Publish anyway",
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it("a stale refusal gets the existing wording and is not retried", async () => {
    const publish = (mutations["cms/publication:publishLocale"] = vi
      .fn()
      .mockRejectedValue(new ConvexError("PAGE_LOCALE_DRAFT_STALE")))
    await chooseFrenchPublish()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        en.editor.pageSave.changedElsewhere
      )
    )
    expect(publish).toHaveBeenCalledOnce()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it.each([
    ["PAGE_LOCALE_RELEASE_REPLACEMENT_REQUIRED", copy.toast.releaseReplacement],
    ["PUBLICATION_HOME_MUST_BE_ROOT", copy.toast.homeMustBeRoot],
  ])("maps %s to plain copy", async (code, message) => {
    mutations["cms/publication:publishLocale"] = vi
      .fn()
      .mockRejectedValue(new ConvexError(code))
    await chooseFrenchPublish()
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message))
  })

  it("words a linked page that is not published in this language as the editor does", async () => {
    mutations["cms/publication:publishLocale"] = vi
      .fn()
      .mockRejectedValue(
        new ConvexError("PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE")
      )
    await chooseFrenchPublish()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        en.editor.pageSave.publication.targetLocaleUnavailable
      )
    )
  })

  it("an unknown failure is the plain generic message", async () => {
    mutations["cms/publication:publishLocale"] = vi
      .fn()
      .mockRejectedValue(new Error("boom"))
    await chooseFrenchPublish()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(copy.toast.publishFailed)
    )
  })

  it("is disabled while pending: a second choice does not publish twice", async () => {
    let release: (value: unknown) => void = () => {}
    const publish = (mutations["cms/publication:publishLocale"] = vi.fn(
      () => new Promise((resolve) => (release = resolve))
    ))
    await chooseFrenchPublish()
    await waitFor(() => expect(publish).toHaveBeenCalledOnce())
    openMenu(/Actions for À propos/)
    expect(
      await screen.findByRole("menuitem", { name: "Publish" })
    ).toHaveAttribute("aria-disabled", "true")
    await act(async () =>
      release({ snapshotId: "s", publicGeneration: 6, publishedAt: 1 })
    )
  })
})

describe("Pages list row Unpublish", () => {
  async function confirmUnpublish() {
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Unpublish",
      })
    )
  }

  it("asks first; Cancel sends nothing", async () => {
    const withdraw = (mutations["cms/publication:withdrawLocale"] = vi
      .fn()
      .mockResolvedValue(null))
    rows.push(about())
    mount()
    openMenu(/Actions for About us/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpublish" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Unpublish this page?")
    expect(dialog).toHaveTextContent(
      "Visitors to /about will see “Page not found” until you publish it again."
    )
    // The plain question, not the red warning.
    expect(
      within(dialog).getByRole("button", { name: "Unpublish" })
    ).toHaveAttribute("data-variant", "default")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(withdraw).not.toHaveBeenCalled()
  })

  it("asks in French", async () => {
    rows.push(about())
    mount({ admin: "fr" })
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filtrer par langue" }),
      { target: { value: "en" } }
    )
    openMenu(/Actions pour About us/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Dépublier" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Dépublier cette page ?")
    expect(dialog).toHaveTextContent(
      "Les visiteurs de /about verront « Page introuvable » tant que vous ne la republierez pas."
    )
  })

  it("withdraws one language with the row's snapshot and generations", async () => {
    const withdraw = (mutations["cms/publication:withdrawLocale"] = vi
      .fn()
      .mockResolvedValue(null))
    rows.push(about())
    mount()
    openMenu(/Actions for About us/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpublish" }))
    await confirmUnpublish()
    await waitFor(() => expect(withdraw).toHaveBeenCalledOnce())
    expect(withdraw).toHaveBeenCalledWith({
      pageId: "about",
      locale: "en",
      expectedSnapshotId: "snap-en",
      expectedPublicGeneration: 5,
      expectedLifecycleGeneration: 11,
    })
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Unpublished (EN)")
    )
  })

  it("maps PAGE_ANCESTRY_IN_USE to plain copy and writes nothing else", async () => {
    mutations["cms/publication:withdrawLocale"] = vi
      .fn()
      .mockRejectedValue(new ConvexError("PAGE_ANCESTRY_IN_USE"))
    rows.push(about())
    mount()
    openMenu(/Actions for About us/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpublish" }))
    await confirmUnpublish()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(copy.toast.ancestryInUse)
    )
  })

  it("the home page asks first; with another published home it says where visitors go", async () => {
    const withdraw = (mutations["cms/publication:withdrawLocale"] = vi
      .fn()
      .mockResolvedValue(null))
    rows.push(home())
    mount()
    openMenu(/Actions for Welcome/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpublish" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Unpublish the home page?")
    expect(dialog).toHaveTextContent(
      "Visitors to / will be sent to the French home page (/fr) until you publish this one again."
    )
    expect(withdraw).not.toHaveBeenCalled()
    // Not the red warning: the confirm button is the plain default variant.
    expect(
      within(dialog).getByRole("button", { name: "Unpublish" })
    ).toHaveAttribute("data-variant", "default")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(withdraw).not.toHaveBeenCalled()
  })

  it("with no other published home it is the red Page not found warning, and confirming withdraws", async () => {
    const withdraw = (mutations["cms/publication:withdrawLocale"] = vi
      .fn()
      .mockResolvedValue(null))
    rows.push(
      page(HOME, [
        { locale: "en", state: "published", title: "Welcome", path: "/" },
        { locale: "fr", state: "draft", title: "Bienvenue", path: "/" },
      ])
    )
    mount()
    openMenu(/Actions for Welcome/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpublish" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent(
      "No other home page is published. Visitors to / will see “Page not found” until you publish it again."
    )
    const confirmButton = within(dialog).getByRole("button", {
      name: "Unpublish",
    })
    expect(confirmButton).toHaveAttribute("data-variant", "destructive")
    fireEvent.click(confirmButton)
    await waitFor(() => expect(withdraw).toHaveBeenCalledOnce())
    expect(withdraw.mock.calls[0]![0]).toMatchObject({
      pageId: HOME,
      locale: "en",
      expectedSnapshotId: "snap-en",
    })
  })

  it("another language's home address is a Page not found warning, in French", async () => {
    rows.push(home())
    mount({ admin: "fr" })
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filtrer par langue" }),
      {
        target: { value: "fr" },
      }
    )
    openMenu(/Actions pour Bienvenue/)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Dépublier" }))
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "Les visiteurs de /fr verront « Page introuvable » tant que vous ne la republierez pas."
    )
  })
})
