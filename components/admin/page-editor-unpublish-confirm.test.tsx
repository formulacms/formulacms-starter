import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import type { Id } from "@/convex/_generated/dataModel"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { render } from "@/test-utils/admin-i18n"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import type { Page } from "./page-editor/lib/types"

const mocks = vi.hoisted(() => ({
  homePageId: undefined as string | undefined,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  publishCommand: null as { run(): unknown } | null,
}))

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvex: () => ({
    query: vi.fn(async (reference: unknown) =>
      getFunctionName(reference as never) === "cms/pages:getPrePublishChecklist"
        ? { canPublish: true, blockers: [], warnings: [] }
        : []
    ),
  }),
  useMutation: (reference: unknown) =>
    (mocks.mutations[getFunctionName(reference as never)] ??= vi.fn(
      async () => ({ status: "acquired", updatedAt: 101, generation: 1 })
    )),
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/owner:getOwnerSession") {
      return { ownerId: "owner-1", role: "admin" }
    }
    if (name === "cms/settings:getSiteConfig") {
      return {
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        homePageId: mocks.homePageId,
        timezone: "UTC",
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return { canPublish: true, blockers: [], warnings: [] }
    }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length
      ? { checklist: { canPublish: true, blockers: [], warnings: [] } }
      : {},
}))

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))

vi.mock("@/components/admin/command-palette", () => ({
  useRegisterAdminCommands: (
    commands: Array<{ id: string; run(): unknown }>
  ) => {
    const publish = commands.find(
      (command) => command.id === "page-editor:publish"
    )
    if (publish) mocks.publishCommand = publish
  },
}))

vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => null }))
vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: () => null,
}))
vi.mock("./page-editor/components/blocks-panel", () => ({
  BlocksPanel: () => null,
}))

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">
const copy = en.editor.page

function page(
  status: Page["status"] = "published",
  pageType: "page" | "landing-page" = "page"
): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "about",
    localizedSlugs: { fr: "a-propos" },
    pageType,
    status,
    ...(status === "published" ? { publishedAt: 50 } : {}),
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: { title: "About", blocks: [] },
      fr: { title: "À propos", blocks: [] },
    },
    tags: [],
    createdBy: "owner-1",
  } as Page
}

type Entry = {
  locale: string
  // Absent: the editor reads a snapshot as published, like the header.
  state?: "published" | "draft" | "not_translated"
  path: string | null
}

function publication(entries: Entry[]) {
  return {
    authority: "snapshot_active" as const,
    lifecycleGeneration: 3,
    sharedDraftGeneration: 4,
    locales: entries.map((entry) => ({
      ...entry,
      draftGeneration: 2,
      publicGeneration: 7,
      releaseGeneration: 1,
      ...(entry.state === undefined || entry.state === "published"
        ? {
            currentSnapshotId:
              `snap-${entry.locale}` as Id<"pagePublishedSnapshots">,
          }
        : {}),
    })),
  }
}

function mount(
  entries: Entry[],
  status: Page["status"] = "published",
  {
    locale = "en",
    hasStaging = false,
    contentLocale,
    pageType = "page",
  }: {
    locale?: "en" | "fr"
    hasStaging?: boolean
    contentLocale?: "en" | "fr"
    pageType?: "page" | "landing-page"
  } = {}
) {
  return render(
    <ConfirmProvider>
      <PageEditor
        page={page(status, pageType)}
        requestedLocale={contentLocale}
        hasStaging={hasStaging}
        stagingUpdatedAt={hasStaging ? 100 : undefined}
        publication={publication(entries)}
      />
    </ConfirmProvider>,
    { locale }
  )
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: copy.moreActions }), {
    key: "Enter",
  })
}

function chooseUnpublish() {
  openMenu()
  fireEvent.click(screen.getByRole("menuitem", { name: copy.unpublish }))
}

const withdraw = () => mocks.mutations["cms/publication:withdrawLocale"]!

describe("PageEditor Archive and Unarchive match the Content list", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.homePageId = undefined
    mocks.publishCommand = null
    for (const key of Object.keys(mocks.mutations)) delete mocks.mutations[key]
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it.each(["en", "fr"] as const)(
    "asks the shared Archive question in %s; Cancel writes nothing and confirm archives once",
    async (locale) => {
      const messages = locale === "fr" ? fr : en
      const editorCopy = messages.editor.page
      const dialogCopy = messages.pages.list.archiveDialog
      mount([{ locale: "en", state: "draft", path: "/about" }], "draft", {
        locale,
      })
      const archive = mocks.mutations["cms/publication:archivePage"]!
      archive.mockResolvedValue({ lifecycleGeneration: 4 })
      async function chooseArchive() {
        fireEvent.keyDown(
          screen.getByRole("button", { name: editorCopy.moreActions }),
          { key: "Enter" }
        )
        const menu = await screen.findByRole("menu")
        fireEvent.click(
          within(menu).getByRole("menuitem", { name: editorCopy.archive })
        )
        return screen.findByRole("dialog", { name: dialogCopy.title })
      }

      const dialog = await chooseArchive()
      expect(dialog).toHaveTextContent(dialogCopy.description)
      expect(
        within(dialog).getByRole("button", {
          name: locale === "fr" ? "Archiver" : "Archive",
        })
      ).toBeInTheDocument()
      expect(archive).not.toHaveBeenCalled()
      fireEvent.click(
        within(dialog).getByRole("button", { name: messages.common.cancel })
      )
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      expect(archive).not.toHaveBeenCalled()

      const confirmed = await chooseArchive()
      expect(archive).not.toHaveBeenCalled()
      fireEvent.click(
        within(confirmed).getByRole("button", {
          name: locale === "fr" ? "Archiver" : "Archive",
        })
      )
      await waitFor(() => expect(archive).toHaveBeenCalledExactlyOnceWith({
        pageId,
        expectedLifecycleGeneration: 3,
      }))
    }
  )

  it.each(["en", "fr"] as const)(
    "keeps home Archive disabled with its reason in %s and opens no dialog",
    async (locale) => {
      const messages = locale === "fr" ? fr : en
      mocks.homePageId = pageId
      mount([{ locale: "en", state: "draft", path: "/" }], "draft", { locale })
      fireEvent.keyDown(
        screen.getByRole("button", { name: messages.editor.page.moreActions }),
        { key: "Enter" }
      )
      const item = within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: messages.editor.page.archive,
      })
      expect(item).toHaveAttribute("aria-disabled", "true")
      expect(
        document.getElementById(item.getAttribute("aria-describedby")!)
      ).toHaveTextContent(messages.pages.list.actions.homeNoArchive)
      fireEvent.click(item)
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(mocks.mutations["cms/publication:archivePage"]).not.toHaveBeenCalled()
    }
  )

  it.each(["menu", "direct button"] as const)(
    "offers only Unarchive in the archived menu and restores as draft via the %s",
    async (entryPoint) => {
      mount([{ locale: "en", state: "draft", path: "/about" }], "archived", {
        hasStaging: true,
      })
      const restore = mocks.mutations["cms/publication:restorePage"]!
      restore.mockResolvedValue({ lifecycleGeneration: 4 })
      const direct = screen.getByRole("button", { name: copy.unarchive })
      expect(direct).toBeEnabled()
      openMenu()
      const menu = await screen.findByRole("menu")
      const items = within(menu).getAllByRole("menuitem")
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveAccessibleName(copy.unarchive)
      expect(restore).not.toHaveBeenCalled()
      if (entryPoint === "menu") {
        fireEvent.click(items[0]!)
      } else {
        fireEvent.keyDown(menu, { key: "Escape" })
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
        fireEvent.click(direct)
      }
      await waitFor(() => expect(restore).toHaveBeenCalledExactlyOnceWith({
        pageId,
        expectedLifecycleGeneration: 3,
      }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
        "“About” restored as draft"
      ))
    }
  )
})

describe("PageEditor Unpublish asks first", () => {
  beforeEach(() => {
    mocks.homePageId = undefined
    mocks.publishCommand = null
    for (const key of Object.keys(mocks.mutations)) delete mocks.mutations[key]
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it("asks the plain question from the menu; Cancel sends nothing, confirm withdraws as before", async () => {
    mount([
      { locale: "en", state: "published", path: "/about" },
      { locale: "fr", state: "published", path: "/a-propos" },
    ])
    chooseUnpublish()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Unpublish this page?")
    expect(dialog).toHaveTextContent(
      "This hides its link in your navigation menu."
    )
    expect(
      within(dialog).getByRole("button", { name: "Unpublish" })
    ).toHaveAttribute("data-variant", "default")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(withdraw()).not.toHaveBeenCalled()

    chooseUnpublish()
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Unpublish",
      })
    )
    await waitFor(() => expect(withdraw()).toHaveBeenCalledOnce())
    expect(withdraw()).toHaveBeenCalledWith({
      pageId,
      locale: "en",
      expectedSnapshotId: "snap-en",
      expectedPublicGeneration: 7,
      expectedLifecycleGeneration: 3,
    })
  })

  it("the command palette asks the same question before anything is written", async () => {
    mount([{ locale: "en", state: "published", path: "/about" }])
    act(() => {
      void mocks.publishCommand!.run()
    })
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "Unpublish this page?"
    )
    expect(withdraw()).not.toHaveBeenCalled()
  })

  it.each([
    ["en", "en", "published"],
    ["en", "fr", "published"],
    ["fr", "en", "published"],
    ["fr", "fr", "published"],
    ["en", "en", "draft"],
    ["en", "en", undefined],
  ] as const)(
    "home Unpublish is described and inert in admin %s, content %s, other home %s",
    async (admin, contentLocale, otherState) => {
      const messages = admin === "fr" ? fr : en
      mocks.homePageId = pageId
      mount([
        {
          locale: "en",
          state: otherState === undefined ? undefined : "published",
          path: "/",
        },
        { locale: "fr", state: otherState, path: "/" },
      ], "published", { locale: admin, contentLocale, pageType: "landing-page" })
      fireEvent.keyDown(screen.getByRole("button", {
        name: messages.editor.page.moreActions,
      }), { key: "Enter" })
      const unpublish = await screen.findByRole("menuitem", {
        name: messages.editor.page.unpublish,
      })
      expect(unpublish).toHaveAttribute("aria-disabled", "true")
      expect(unpublish).not.toHaveAttribute("data-disabled")
      expect(unpublish).toHaveAccessibleDescription(
        admin === "en"
          ? "The home page can’t be unpublished."
          : "La page d’accueil ne peut pas être dépubliée."
      )
      expect(unpublish.querySelector("svg")).toBeNull()
      fireEvent.click(unpublish)
      fireEvent.keyDown(unpublish, { key: "Enter" })
      expect(screen.queryByRole("alertdialog")).toBeNull()
      expect(withdraw()).not.toHaveBeenCalled()
      fireEvent.pointerMove(unpublish.parentElement!, { pointerType: "mouse" })
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        messages.pages.list.actions.homeNoUnpublish
      )
    }
  )

  it("a non-home Landing page still asks and withdraws its language", async () => {
    mount([{ locale: "en", state: "published", path: "/about" }], "published", {
      pageType: "landing-page",
    })
    openMenu()
    const unpublish = screen.getByRole("menuitem", { name: copy.unpublish })
    expect(unpublish).not.toHaveAttribute("aria-disabled", "true")
    fireEvent.click(unpublish)
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Unpublish this page?")
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }))
    await waitFor(() => expect(withdraw()).toHaveBeenCalledOnce())
  })

  it("a language that is not published asks nothing, as before", () => {
    mount([
      { locale: "en", state: "draft", path: "/about" },
      { locale: "fr", state: "published", path: "/a-propos" },
    ])
    chooseUnpublish()
    // The question would open in the same update as the click.
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("a page with no public address gets the question without an address", async () => {
    mount([{ locale: "en", state: "published", path: null }])
    chooseUnpublish()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Unpublish this page?")
    expect(dialog).not.toHaveTextContent("Visitors to")
    expect(withdraw()).not.toHaveBeenCalled()
  })

  it("offers no Duplicate in the menu", () => {
    mount([{ locale: "en", state: "published", path: "/about" }])
    openMenu()
    expect(screen.getByRole("menuitem", { name: copy.unpublish })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: /duplicate/i })).toBeNull()
    // No stray separator between the "Page" label and Unpublish.
    expect(screen.queryByRole("separator")).toBeNull()
  })
})

describe("PageEditor Publish right after an Unpublish", () => {
  beforeEach(() => {
    mocks.homePageId = undefined
    for (const key of Object.keys(mocks.mutations)) delete mocks.mutations[key]
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  function publishButton() {
    const header = within(document.querySelector("header")!)
    const buttons = header.getAllByRole("button", { name: copy.publish })
    expect(buttons).toHaveLength(1)
    return buttons[0]!
  }

  it("publishes the saved version when the language has one but no draft row", async () => {
    mount(
      [{ locale: "en", state: "draft", path: "/about" }],
      "draft"
    )
    const publish = publishButton()
    expect(publish).toBeEnabled()
    expect(publish).toHaveAttribute("title", copy.publish)
    fireEvent.click(publish)
    const publishLocale = () =>
      mocks.mutations["cms/publication:publishLocale"]!
    await waitFor(() => expect(publishLocale()).toHaveBeenCalledOnce())
    expect(publishLocale()).toHaveBeenCalledWith({
      pageId,
      locale: "en",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 4,
      expectedPublicGeneration: 7,
      expectedLifecycleGeneration: 3,
      expectedReleaseGeneration: 1,
    })
  })

  it("keeps Publish off when the language has nothing to publish", () => {
    mount(
      [{ locale: "en", state: "not_translated", path: null }],
      "draft"
    )
    const publish = publishButton()
    expect(publish).toBeDisabled()
    expect(publish).toHaveAttribute("title", copy.nothingToPublish.saveFirst)
  })

  it("publishes this language when another language is still published", async () => {
    mount([
      { locale: "en", state: "draft", path: "/about" },
      { locale: "fr", state: "published", path: "/a-propos" },
    ])
    const header = within(document.querySelector("header")!)
    const publish = header.getByRole("button", { name: copy.publishChanges })
    expect(publish).toBeEnabled()
    fireEvent.click(publish)
    const publishLocale = () =>
      mocks.mutations["cms/publication:publishLocale"]!
    await waitFor(() => expect(publishLocale()).toHaveBeenCalledOnce())
    expect(publishLocale()).toHaveBeenCalledWith({
      pageId,
      locale: "en",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 4,
      expectedPublicGeneration: 7,
      expectedLifecycleGeneration: 3,
      expectedReleaseGeneration: 1,
    })
  })

  it("keeps Publish changes off when this language is published with no changes", () => {
    mount([
      { locale: "en", state: "published", path: "/about" },
      { locale: "fr", state: "published", path: "/a-propos" },
    ])
    const header = within(document.querySelector("header")!)
    const publish = header.getByRole("button", { name: copy.publishChanges })
    expect(publish).toBeDisabled()
    expect(publish).toHaveAttribute("title", copy.nothingToPublish.noChanges)
  })
})
