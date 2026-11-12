import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Id } from "@/convex/_generated/dataModel"
import { render } from "@/test-utils/admin-i18n"
import en from "@/messages/admin/en.json"
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

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
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

vi.mock("./duplicate-page-dialog", () => ({ DuplicatePageDialog: () => null }))
vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => null }))
vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: () => null,
}))
vi.mock("./page-editor/components/slices-panel", () => ({
  SlicesPanel: () => null,
}))

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">
const copy = en.editor.page

function page(status: Page["status"] = "published"): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "about",
    localizedSlugs: { fr: "a-propos" },
    pageType: "page",
    status,
    ...(status === "published" ? { publishedAt: 50 } : {}),
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: { title: "About", slices: [] },
      fr: { title: "À propos", slices: [] },
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
  snapshot = true,
  status: Page["status"] = "published"
) {
  return render(
    <PageEditor
      page={page(status)}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={snapshot ? publication(entries) : undefined}
    />
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
      "Visitors to /about will see “Page not found” until you publish it again."
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

  it("the home page gets the Pages list's home warning", async () => {
    mocks.homePageId = pageId
    mount([
      { locale: "en", state: "published", path: "/" },
      { locale: "fr", state: "published", path: "/" },
    ])
    chooseUnpublish()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Unpublish the home page?")
    expect(dialog).toHaveTextContent(
      "Visitors to / will be sent to the French home page (/fr) until you publish this one again."
    )
    expect(withdraw()).not.toHaveBeenCalled()
  })

  it("the home page with no other published home is the red warning", async () => {
    mocks.homePageId = pageId
    mount([
      { locale: "en", state: "published", path: "/" },
      { locale: "fr", state: "draft", path: "/" },
    ])
    chooseUnpublish()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent(
      "No other home page is published. Visitors to / will see “Page not found” until you publish it again."
    )
    expect(
      within(dialog).getByRole("button", { name: "Unpublish" })
    ).toHaveAttribute("data-variant", "destructive")
  })

  it("the home warning finds the other published home when state is absent", async () => {
    mocks.homePageId = pageId
    mount([
      { locale: "en", path: "/" },
      { locale: "fr", path: "/" },
    ])
    chooseUnpublish()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent(
      "Visitors to / will be sent to the French home page (/fr) until you publish this one again."
    )
    expect(
      within(dialog).getByRole("button", { name: "Unpublish" })
    ).toHaveAttribute("data-variant", "default")
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

  it("offers Duplicate only under legacy authority", () => {
    const snapshot = mount([
      { locale: "en", state: "published", path: "/about" },
    ])
    openMenu()
    expect(screen.getByRole("menuitem", { name: copy.unpublish })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: copy.duplicate })).toBeNull()
    // No stray separator between the "Page" label and Unpublish.
    expect(screen.queryByRole("separator")).toBeNull()
    snapshot.unmount()

    mount([], false)
    openMenu()
    expect(
      screen.getByRole("menuitem", { name: copy.duplicate })
    ).toBeInTheDocument()
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
      true,
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
      true,
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
