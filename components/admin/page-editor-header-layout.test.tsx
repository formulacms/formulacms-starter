import { cleanup, fireEvent, within } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"

// Mounted production header; jsdom proves structure/semantics, not pixel width.
// Browser geometry is a separate runtime receipt, never inferred from classes.
const mocks = vi.hoisted(() => ({
  convex: { query: vi.fn(async () => []) },
  enabledLocales: ["en"] as string[],
  checklist: {
    canPublish: true,
    blockers: [],
    warnings: [],
  } as PrePublishChecklist,
}))

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation: () =>
    vi.fn(async () => ({ status: "acquired", updatedAt: 101, generation: 1 })),
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/owner:getOwnerSession") {
      return { ownerId: "owner-1", role: "admin" }
    }
    if (name === "cms/settings:getSiteConfig") {
      return {
        defaultLocale: "en",
        enabledLocales: mocks.enabledLocales,
        timezone: "UTC",
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return mocks.checklist
    }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length ? { checklist: mocks.checklist } : {},
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
  useRegisterAdminCommands: (commands: Array<{ id: string }>) => {
    void commands
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

vi.mock("./contributions/history", () => ({
  ADMIN_HISTORY_BROWSER_BINDING: { PanelSlot: () => null },
}))

import { PageEditor } from "./page-editor"

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const scenarios = (["en", "fr"] as const).flatMap((locale) =>
  [false, true].flatMap((multilingual) =>
    ["", "Title twelve", "T".repeat(80)].map((title) => ({
      locale,
      multilingual,
      title,
      length: title.length,
    }))
  )
)

test.each(scenarios)(
  "title priority and named actions: $locale M05=$multilingual length=$length",
  ({ locale, multilingual, title }) => {
    mocks.enabledLocales = multilingual ? ["en", "fr"] : ["en"]
    const messages = locale === "fr" ? fr : en
    const copy = messages.editor.page
    const page = {
      _id: "page-1" as Id<"pages">,
      _creationTime: 1,
      slug: "about",
      localizedSlugs: {},
      pageType: "page",
      status: "published",
      createdAt: 100,
      updatedAt: 100,
      content: {
        en: { title, slices: [] },
        fr: { title, slices: [] },
      },
      tags: [],
      createdBy: "owner-1",
    } as Page
    const view = render(
      <PageEditor
        page={page}
        hasStaging={false}
        stagingUpdatedAt={undefined}
      />,
      { locale }
    )
    const header = view.container.querySelector("header")!
    const controls = within(header)
    const input = controls.getByRole("textbox", { name: copy.pageTitle })
    const save = controls.getByRole("button", { name: copy.save })
    const titleRow = input.closest(".col-span-3")!.parentElement!
    const toolbar = save.closest(".col-start-3")!.parentElement!
    const readiness = controls.getByRole("button", {
      name: `${messages.editor.readiness.title}: ${messages.editor.readiness.readyShort}`,
    })
    const published = controls.getByText(copy.status.published)

    // One layout owner allocates the whole title row before toolbar wrapping.
    expect(header).toHaveClass("sm:flex-col", "sm:items-stretch")
    expect(titleRow.parentElement).toBe(header)
    expect(toolbar.parentElement).toBe(header)
    expect(titleRow).not.toBe(toolbar)
    expect(toolbar).not.toContainElement(input)
    expect(toolbar).not.toContainElement(titleRow)
    expect(titleRow).toHaveClass("sm:w-full", "sm:min-w-0")
    expect(input.closest(".col-span-3")).toHaveClass("sm:flex-1")
    expect(toolbar).toHaveClass("sm:w-full", "sm:min-w-0", "sm:flex-wrap")
    expect(toolbar).not.toHaveClass("sm:shrink-0")
    expect(
      titleRow.compareDocumentPosition(toolbar) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // Publication badge and readiness occupy distinct normal-flow sibling
    // branches; neither is positioned over, or nested inside, the other.
    const identity = input.closest(".col-span-3")!
    const attention = readiness.parentElement!
    expect(identity.parentElement).toBe(titleRow)
    expect(attention.parentElement).toBe(titleRow)
    expect(identity).toContainElement(published)
    expect(attention).not.toContainElement(published)
    expect(identity).not.toContainElement(readiness)
    expect(attention).toHaveClass("shrink-0")
    expect(attention).not.toHaveClass("absolute", "fixed")
    expect(attention).toHaveClass("sm:[&>button>span]:sr-only")
    expect(readiness).toHaveAttribute(
      "title",
      readiness.getAttribute("aria-label")
    )
    expect(input).toHaveClass(
      "sm:focus-visible:ring-3",
      "sm:focus-visible:ring-ring/50"
    )

    // Controls retain names even when their desktop labels become icons.
    for (const button of controls.getAllByRole("button")) {
      expect(button).toHaveAccessibleName()
    }
    expect(controls.queryByRole("tablist")).toBe(
      multilingual ? controls.getByRole("tablist") : null
    )
    if (multilingual) {
      // The language switch keeps its width; a control that does not fit beside
      // it (Translate) wraps below it instead of covering a language tab.
      const tabs = controls.getByRole("tablist")
      expect(tabs).toHaveClass("shrink-0", "max-w-full")
      expect(tabs.parentElement).toHaveClass("flex-wrap", "min-w-0")
    }
    expect(input).toHaveValue(title)
    expect(input).toBeEnabled()
    fireEvent.change(input, { target: { value: "Edited title" } })
    expect(input).toHaveValue("Edited title")

    // Status details still activate the existing readiness popover.
    fireEvent.click(readiness)
    expect(within(document.body).getByRole("dialog")).toHaveTextContent(
      messages.editor.readiness.title
    )
  }
)
