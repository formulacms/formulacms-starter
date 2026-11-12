import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { toast } from "sonner"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page } from "./page-editor/lib/types"

// Mounted editor: a blank title refuses Save before any mutation, keeps the
// title marked until one is typed, and a blank address refuses with a toast.
const mocks = vi.hoisted(() => ({
  convex: { query: vi.fn(async () => []) },
  mutationNames: [] as string[],
  mutationCalls: [] as Array<{ name: string; args: unknown[] }>,
  locales: ["en"] as string[],
  confirm: null as null | (() => Promise<boolean>),
  // Whether each editor close-autofocus call took over focus (prevented the
  // default return to the opener).
  closeCalls: [] as boolean[],
}))

function recordCloseAutoFocus(
  handler: ((event: Event) => void) | undefined
): ((event: Event) => void) | undefined {
  return (event) => {
    handler?.(event)
    mocks.closeCalls.push(event.defaultPrevented)
  }
}

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    return vi.fn(async (...args: unknown[]) => {
      mocks.mutationNames.push(name)
      mocks.mutationCalls.push({ name, args })
      return { status: "acquired", updatedAt: 101, generation: 1 }
    })
  },
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/owner:getOwnerSession") {
      return { ownerId: "owner-1", role: "admin" }
    }
    if (name === "cms/settings:getSiteConfig") {
      return { defaultLocale: "en", enabledLocales: mocks.locales, timezone: "UTC" }
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
  useConfirm: () => () =>
    mocks.confirm ? mocks.confirm() : Promise.resolve(true),
}))

vi.mock("@/components/admin/command-palette", () => ({
  useRegisterAdminCommands: (commands: Array<{ id: string }>) => {
    void commands
  },
}))

vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => null }))
vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: ({
    slug,
    onSlugChange,
  }: {
    slug: string
    onSlugChange(value: string): void
  }) => (
    <input
      data-testid="address"
      value={slug}
      onChange={(e) => onSlugChange(e.target.value)}
    />
  ),
}))
vi.mock("./page-editor/components/slices-panel", () => ({
  SlicesPanel: () => null,
}))

vi.mock("./contributions/history", () => ({
  ADMIN_HISTORY_BROWSER_BINDING: { PanelSlot: () => null },
}))

vi.mock("./duplicate-page-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./duplicate-page-dialog")>()
  return {
    DuplicatePageDialog: (
      props: Parameters<typeof actual.DuplicatePageDialog>[0]
    ) => (
      <actual.DuplicatePageDialog
        {...props}
        onCloseAutoFocus={recordCloseAutoFocus(props.onCloseAutoFocus)}
      />
    ),
  }
})
vi.mock("./page-editor/components/transfer-popover-content", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./page-editor/components/transfer-popover-content")
    >()
  return {
    TransferPopoverContent: (
      props: Parameters<typeof actual.TransferPopoverContent>[0]
    ) => (
      <actual.TransferPopoverContent
        {...props}
        onCloseAutoFocus={recordCloseAutoFocus(props.onCloseAutoFocus)}
      />
    ),
  }
})

import { PageEditor } from "./page-editor"

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.mutationNames.length = 0
  mocks.mutationCalls.length = 0
  mocks.locales = ["en"]
  mocks.closeCalls.length = 0
  mocks.confirm = null
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// Snapshot sites show the saved address in the header; the address being
// typed is the URL identifier field in the Settings tab.
function liveAddress(view: ReturnType<typeof render>): string {
  fireEvent.click(view.getByTitle(en.editor.page.tabs.settings))
  return (view.getByTestId("address") as HTMLInputElement).value
}

function mount(
  locale: "en" | "fr" = "en",
  snapshot = false,
  savedSlug = "about-us",
  twoLocales = false,
  savedTitle = "About us"
) {
  if (twoLocales) mocks.locales = ["en", "fr"]
  const page = {
    _id: "page-1" as Id<"pages">,
    _creationTime: 1,
    slug: savedSlug,
    localizedSlugs: {},
    pageType: "page",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: { title: savedTitle, slices: [] },
      ...(twoLocales ? { fr: { title: "À propos", slices: [] } } : {}),
    },
    tags: [],
    createdBy: "owner-1",
  } as Page
  const view = render(
    <PageEditor
      page={page}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={
        snapshot
          ? {
              authority: "snapshot_active",
              lifecycleGeneration: 3,
              sharedDraftGeneration: 4,
              locales: [
                {
                  locale: "en",
                  draftGeneration: 2,
                  publicGeneration: 1,
                  releaseGeneration: 1,
                },
              ],
            }
          : undefined
      }
    />,
    { locale }
  )
  const messages = locale === "fr" ? fr : en
  return {
    view,
    copy: messages.editor.page,
    saveCopy: messages.editor.pageSave,
    input: view.getByRole("textbox", {
      name: messages.editor.page.pageTitle,
    }) as HTMLInputElement,
    save: view.getByRole("button", { name: messages.editor.page.save }),
  }
}

const saveCalls = () =>
  mocks.mutationNames.filter(
    (n) => n.endsWith(":updateDraft") || n.endsWith(":saveEditorDraft")
  )

test.each(["en", "fr"] as const)(
  "a blank title refuses Save, marks the title, and recovers on typing: %s",
  async (locale) => {
    const { view, input, save, saveCopy } = mount(locale)
    fireEvent.change(input, { target: { value: "   " } })
    await act(async () => {
      fireEvent.click(save)
    })

    expect(toast.error).toHaveBeenCalledWith(saveCopy.titleRequired)
    expect(saveCalls()).toEqual([])
    await waitFor(() => expect(input).toHaveFocus())
    expect(input).toHaveAttribute("aria-invalid", "true")
    const message = view.getByText(saveCopy.titleRequired)
    expect(message.closest("[id]")).toHaveAttribute("id")
    expect(input.getAttribute("aria-describedby")).toBe(
      message.closest("[id]")!.id
    )
    // The slug line is replaced, not duplicated.
    expect(view.queryByText(/^\/$/)).toBeNull()

    fireEvent.change(input, { target: { value: "Fresh title" } })
    expect(input).not.toHaveAttribute("aria-invalid")
    expect(input).not.toHaveAttribute("aria-describedby")
    expect(view.queryByText(saveCopy.titleRequired)).toBeNull()
    expect(view.getByText("/fresh-title")).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(save)
    })
    await waitFor(() => expect(saveCalls().length).toBeGreaterThan(0))
  }
)

test("clearing the address refuses with a toast and no title marking (snapshot)", async () => {
  const { view, input, save, saveCopy, copy } = mount("en", true)
  fireEvent.click(view.getByTitle(copy.tabs.settings))
  fireEvent.change(view.getByTestId("address"), { target: { value: "" } })
  await act(async () => {
    fireEvent.click(save)
  })

  expect(toast.error).toHaveBeenCalledWith(saveCopy.slugRequired)
  expect(toast.error).not.toHaveBeenCalledWith(saveCopy.titleRequired)
  expect(saveCalls()).toEqual([])
  expect(input).not.toHaveAttribute("aria-invalid")
})

test("a title with no Latin letters gets a page-<hash> address, so Save is not refused (snapshot)", async () => {
  const { input, save, saveCopy, view } = mount("en", true)
  fireEvent.change(input, { target: { value: "Иван" } })
  expect(liveAddress(view)).toBe("page-114d4170")
  await act(async () => {
    fireEvent.click(save)
  })

  expect(toast.error).not.toHaveBeenCalledWith(saveCopy.slugRequired)
  await waitFor(() => expect(saveCalls().length).toBeGreaterThan(0))
})

test.each([true, false])(
  "a page stored with an empty address and a non-Latin title adopts page-<hash> on its first Save (snapshot: %s)",
  async (snapshot) => {
    const { view, save, saveCopy, input } = mount("en", snapshot, "", false, "Иван")
    expect(input.value).toBe("Иван")
    if (snapshot) expect(liveAddress(view)).toBe("page-114d4170")
    else expect(view.getByText("/page-114d4170")).toBeInTheDocument()
    // A page that opens with a pending address is not a clean page: Save is on.
    await act(async () => {
      fireEvent.click(save)
    })

    expect(toast.error).not.toHaveBeenCalledWith(saveCopy.slugRequired)
    await waitFor(() => expect(saveCalls().length).toBeGreaterThan(0))
    const written = mocks.mutationCalls
      .filter((c) => c.name.endsWith(":updateDraft") || c.name.endsWith(":saveEditorDraft"))
      .map((c) => JSON.stringify(c.args))
      .join(" ")
    expect(written).toContain("page-114d4170")
  }
)

test("clearing only the default-locale address refuses before any write (legacy)", async () => {
  const { view, input, save, saveCopy, copy } = mount()
  fireEvent.click(view.getByTitle(copy.tabs.settings))
  fireEvent.change(view.getByTestId("address"), { target: { value: "" } })
  await act(async () => {
    fireEvent.click(save)
  })

  expect(toast.error).toHaveBeenCalledWith(saveCopy.slugRequired)
  expect(toast.error).not.toHaveBeenCalledWith(saveCopy.titleRequired)
  expect(saveCalls()).toEqual([])
  expect(input).not.toHaveAttribute("aria-invalid")
})

test("a punctuation-only title on a page stored without an address adopts a page-<hash> address and saves on the legacy path", async () => {
  // The page never had an address, so nothing was cleared: it adopts the
  // address its title generates and saves as before.
  const { input, save, saveCopy } = mount("en", false, "")
  fireEvent.change(input, { target: { value: "!!! ???" } })
  await act(async () => {
    fireEvent.click(save)
  })

  expect(toast.error).not.toHaveBeenCalledWith(saveCopy.slugRequired)
  await waitFor(() => expect(saveCalls().length).toBeGreaterThan(0))
  const slugs = mocks.mutationCalls
    .filter((c) => c.name.endsWith(":updateDraft"))
    .map((c) => (c.args[0] as { slug?: string }).slug)
  expect(slugs).toHaveLength(1)
  expect(slugs[0]).toMatch(/^page-[0-9a-f]{8}$/)
})

// A blank desired address with no clear is only reachable with a non-blank
// title when the user empties the field of a page stored without an address:
// slugify(title) is never blank (use-page-save.ts, `defaultAddressCleared`
// needs a non-empty stored address). It saves and writes no address.
test("emptying the address of a page stored without one saves without writing an address (legacy)", async () => {
  const { view, save, saveCopy, copy, input } = mount("en", false, "")
  fireEvent.change(input, { target: { value: "Fresh title" } })
  fireEvent.click(view.getByTitle(copy.tabs.settings))
  fireEvent.change(view.getByTestId("address"), { target: { value: "" } })
  await act(async () => {
    fireEvent.click(save)
  })

  expect(toast.error).not.toHaveBeenCalledWith(saveCopy.slugRequired)
  await waitFor(() => expect(saveCalls().length).toBeGreaterThan(0))
  const calls = mocks.mutationCalls.filter((c) => c.name.endsWith(":updateDraft"))
  expect(calls).toHaveLength(1)
  expect(calls[0]!.args[0]).not.toHaveProperty("slug")
})

test("a blank-title refusal from Duplicate closes the dialog and puts the cursor in the title", async () => {
  const { view, input, copy, saveCopy } = mount()
  fireEvent.change(input, { target: { value: "" } })
  const more = view.getByRole("button", { name: copy.moreActions })
  fireEvent.keyDown(more, { key: "Enter" })
  fireEvent.click(await view.findByRole("menuitem", { name: copy.duplicate }))
  const dialog = await view.findByRole("dialog")
  const submit = within(dialog).getByRole("button", {
    name: en.editor.duplicateDialog.action,
  })
  await act(async () => {
    fireEvent.click(submit)
  })

  expect(toast.error).toHaveBeenCalledWith(saveCopy.titleRequired)
  expect(mocks.mutationNames.filter((n) => n.endsWith(":duplicate"))).toEqual([])
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull())
  // Radix runs its focus-return on the next timer tick; the title keeps focus.
  // jsdom has no live opener here, so the recorded close call below is what
  // proves the editor took over the focus return (duplicate-page-dialog.test
  // proves Radix honours that).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(input).toHaveFocus()
  // The editor took over the dialog's focus return.
  expect(mocks.closeCalls).toEqual([true])
})

async function openCopyFrom(view: ReturnType<typeof mount>["view"], copy: typeof en.editor.page) {
  fireEvent.click(view.getByTitle(copy.copyBetweenLocales))
  return view.findByRole("button", { name: /FR/ })
}

test("Copy from: a blank-title refusal closes the popover and puts the cursor in the title", async () => {
  const { view, input, copy, saveCopy } = mount("en", false, "about-us", true)
  fireEvent.change(input, { target: { value: "" } })
  fireEvent.click(await openCopyFrom(view, copy))
  await act(async () => {})

  expect(toast.error).toHaveBeenCalledWith(saveCopy.titleRequired)
  await waitFor(() =>
    expect(view.queryByText(en.editor.transfer.fillFrom.replace("{locale}", "EN"))).toBeNull()
  )
  // Radix returns focus to the trigger on the next timer tick; the title wins.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(input).toHaveFocus()
})

test("Copy from: a refusal that is not about the title reopens a popover that closed", async () => {
  const { view, copy, saveCopy } = mount("en", true, "about-us", true)
  fireEvent.click(view.getByTitle(copy.tabs.settings))
  fireEvent.change(view.getByTestId("address"), { target: { value: "" } })
  let answer!: (ok: boolean) => void
  mocks.confirm = () => new Promise<boolean>((resolve) => (answer = resolve))
  fireEvent.click(await openCopyFrom(view, copy))
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
  const fillFrom = en.editor.transfer.fillFrom.replace("{locale}", "EN")
  await waitFor(() => expect(view.queryByText(fillFrom)).toBeNull())
  await act(async () => {
    answer(true)
  })

  expect(toast.error).toHaveBeenCalledWith(saveCopy.slugRequired)
  expect(toast.error).not.toHaveBeenCalledWith(saveCopy.titleRequired)
  expect(await view.findByText(fillFrom)).toBeInTheDocument()
})

test("Copy from: a title refusal after the popover already closed leaves no stale focus request", async () => {
  const { view, input, copy } = mount("en", false, "about-us", true)
  fireEvent.change(input, { target: { value: "" } })
  // The replace confirm is still pending; focus moving into it dismisses the
  // popover, whose close handler runs before the refusal.
  let answer!: (ok: boolean) => void
  mocks.confirm = () => new Promise<boolean>((resolve) => (answer = resolve))
  const trigger = view.getByTitle(copy.copyBetweenLocales)
  fireEvent.click(await openCopyFrom(view, copy))
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
  await waitFor(() =>
    expect(view.queryByText(en.editor.transfer.fillFrom.replace("{locale}", "EN"))).toBeNull()
  )
  await act(async () => {
    answer(true)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(input).toHaveFocus()
  // The popover had closed before the refusal: no focus request is left over.
  expect(mocks.closeCalls.every((took) => !took)).toBe(true)

  // A later, unrelated close of the popover returns focus to its trigger.
  mocks.confirm = null
  fireEvent.click(trigger)
  await view.findByRole("button", { name: /FR/ })
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(trigger).toHaveFocus()
  expect(mocks.closeCalls.length).toBeGreaterThan(1)
  expect(mocks.closeCalls.every((took) => !took)).toBe(true)
})
