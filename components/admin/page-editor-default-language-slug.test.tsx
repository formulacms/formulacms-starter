import { act, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import { toast } from "sonner"
import { writeRecoveryDraft } from "./page-editor/lib/recovery"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page } from "./page-editor/lib/types"

// Mounted editor: the address a language starts from. A language with no
// saved address of its own starts from its own title, whichever language is the
// default today (audit F1); a saved address is kept.
const mocks = vi.hoisted(() => ({
  convex: { query: vi.fn(async () => []) },
  mutationNames: [] as string[],
  mutationCalls: [] as Array<{ name: string; args: unknown[] }>,
  locales: ["en", "fr"] as string[],
  defaultLocale: "en" as string,
  homePageId: null as string | null,
  cold: false,
  refuseAdoption: false,
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
      if (mocks.cold) return undefined
      return { defaultLocale: mocks.defaultLocale, enabledLocales: mocks.locales, homePageId: mocks.homePageId, timezone: "UTC" }
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
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => <input id="page-meta-title" aria-label="Meta title" /> }))
vi.mock("./page-editor/components/page-readiness", () => ({
  PageReadinessTrigger: ({ onAction }: { onAction: (value: { id: string }) => void }) => <button onClick={() => onAction({ id: "open-seo" })}>ED3 Open SEO</button>,
}))
vi.mock("@/lib/rich-text/adopt-hero-titles", async (original) => {
  const actual = await original<typeof import("@/lib/rich-text/adopt-hero-titles")>()
  return { ...actual, prepareHeroTitleDraft: (...args: Parameters<typeof actual.prepareHeroTitleDraft>) => {
    if (mocks.refuseAdoption && args[1] === "fr") throw new Error("Refused draft conversion")
    return actual.prepareHeroTitleDraft(...args)
  } }
})
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
  mocks.locales = ["en", "fr"]
  mocks.defaultLocale = "en"
  mocks.homePageId = null
  mocks.cold = false
  mocks.refuseAdoption = false
  mocks.closeCalls.length = 0
  mocks.confirm = null
  window.localStorage.clear()
  window.sessionStorage.clear()
})

type Content = Record<string, { title: string; slices: never[] }>

// A snapshot-authority page as the editor receives it: `slug` is the default
// language's address (or the legacy base address), `localizedSlugs` the others.
function mount(options: {
  content: Content
  slug: string
  localizedSlugs?: Record<string, string>
  requestedLocale: "en" | "fr"
  route?: { homePageId?: string }
}) {
  const page = {
    _id: "page-1" as Id<"pages">,
    _creationTime: 1,
    slug: options.slug,
    localizedSlugs: options.localizedSlugs ?? {},
    pageType: "page",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    content: options.content,
    tags: [],
    createdBy: "owner-1",
  } as Page
  const editor = (requestedLocale: "en" | "fr") => (
    <PageEditor
      page={page}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      requestedLocale={requestedLocale}
      routeDefaultLocale="en"
      routeEnabledLocales={["en", "fr"]}
      routeHomePageId={options.route?.homePageId}
      publication={{
        authority: "snapshot_active",
        lifecycleGeneration: 3,
        sharedDraftGeneration: 4,
        locales: ["en", "fr"].map((locale) => ({
          locale,
          draftGeneration: 2,
          publicGeneration: 1,
          releaseGeneration: 1,
        })),
      }}
    />
  )
  const view = render(editor(options.requestedLocale), { locale: "en" })
  return {
    view,
    rerenderLocale: (locale: "en" | "fr") => view.rerender(editor(locale)),
    copy: en.editor.page,
    input: view.getByRole("textbox", {
      name: en.editor.page.pageTitle,
    }) as HTMLInputElement,
    save: view.getByRole("button", { name: en.editor.page.save }),
  }
}

// Snapshot sites show the saved address in the header; the address being
// typed is the URL identifier field in the Settings tab.
function liveAddress(view: ReturnType<typeof render>): string {
  fireEvent.click(view.getByTitle(en.editor.page.tabs.settings))
  return (view.getByTestId("address") as HTMLInputElement).value
}

const frOnly: Content = { fr: { title: "À propos", slices: [] } }

async function saveAndReadWrites(save: HTMLElement) {
  await act(async () => {
    fireEvent.click(save)
  })
  await waitFor(() =>
    expect(
      mocks.mutationNames.some((n) => n.endsWith(":saveEditorDraft"))
    ).toBe(true)
  )
  return mocks.mutationCalls
    .filter((c) => c.name.endsWith(":saveEditorDraft"))
    .map((c) => JSON.stringify(c.args))
    .join(" ")
}

test("a page created in French, default switched to English: the English translation gets its own address and saves only English", async () => {
  mocks.defaultLocale = "en"
  const { view, input, save } = mount({
    content: frOnly,
    slug: "a-propos",
    localizedSlugs: { fr: "a-propos" },
    requestedLocale: "en",
  })
  expect(input.value).toBe("")
  fireEvent.change(input, { target: { value: "About" } })
  expect(liveAddress(view)).toBe("about")

  const written = await saveAndReadWrites(save)
  expect(written).toContain('"locale":"en"')
  expect(written).toContain('"slug":"about"')
  expect(written).not.toContain('"locale":"fr"')
  expect(written).not.toContain("a-propos")
})

test("the untranslated default language keeps following the title until the address is edited by hand", async () => {
  const { view, input, copy } = mount({
    content: frOnly,
    slug: "a-propos",
    localizedSlugs: { fr: "a-propos" },
    requestedLocale: "en",
  })
  fireEvent.change(input, { target: { value: "About" } })
  fireEvent.change(input, { target: { value: "About us" } })
  expect(liveAddress(view)).toBe("about-us")

  fireEvent.click(view.getByTitle(copy.tabs.settings))
  fireEvent.change(view.getByTestId("address"), { target: { value: "company" } })
  fireEvent.change(input, { target: { value: "About our company" } })
  expect((view.getByTestId("address") as HTMLInputElement).value).toBe(
    "company"
  )
})

test("a page created in the current default keeps its base address", () => {
  const { view, input } = mount({
    content: { en: { title: "About us", slices: [] } },
    slug: "about-us",
    requestedLocale: "en",
  })
  expect(input.value).toBe("About us")
  expect(liveAddress(view)).toBe("about-us")
  fireEvent.change(input, { target: { value: "About them" } })
  expect(liveAddress(view)).toBe("about-them")
})

test("a default language that already has its own address keeps it after a default change", () => {
  // Translated while non-default (address "company"), then made the default.
  mocks.defaultLocale = "en"
  const { view, input } = mount({
    content: {
      en: { title: "About", slices: [] },
      fr: { title: "À propos", slices: [] },
    },
    slug: "company",
    localizedSlugs: { fr: "a-propos" },
    requestedLocale: "en",
  })
  expect(input.value).toBe("About")
  expect(liveAddress(view)).toBe("company")
})

test("a non-default language with no address of its own still generates one from its title", () => {
  const { view, input } = mount({
    content: {
      en: { title: "My products", slices: [] },
      fr: { title: "Mes produits", slices: [] },
    },
    slug: "my-products",
    requestedLocale: "fr",
  })
  expect(input.value).toBe("Mes produits")
  expect(liveAddress(view)).toBe("mes-produits")
})

test("the home page keeps its own base address even when its default language is not translated yet", () => {
  // Same shape as the first test, but this page is the home page: it never
  // adopts an address from a title typed in another language.
  mocks.homePageId = "page-1"
  const { view, input } = mount({
    content: frOnly,
    slug: "home",
    localizedSlugs: {},
    requestedLocale: "en",
  })
  expect(input.value).toBe("")
  expect(liveAddress(view)).toBe("home")
  fireEvent.change(input, { target: { value: "Welcome" } })
  expect(liveAddress(view)).toBe("home")
})

test("on a cold load the route's home page id already protects the home address", () => {
  // The client query has not answered yet: only the route's props are known.
  mocks.cold = true
  const { view, input } = mount({
    content: frOnly,
    slug: "home",
    requestedLocale: "en",
    route: { homePageId: "page-1" },
  })
  expect(input.value).toBe("")
  expect(liveAddress(view)).toBe("home")
})


const bilingual: Content = { en: { title: "English", slices: [] }, fr: { title: "French", slices: [] } }

test("A10 accepted locale update replaces only locale and ignores its own route echo", () => {
  window.history.replaceState(null, "", "/admin/pages/page-1?locale=en&keep=yes#field")
  const replace = vi.spyOn(window.history, "replaceState")
  const scroll = vi.spyOn(window, "scrollTo")
  const confirm = vi.fn(async () => true)
  mocks.confirm = confirm
  const { view, input, rerenderLocale } = mount({ content: bilingual, slug: "english", requestedLocale: "en" })
  fireEvent.change(input, { target: { value: "Unsaved English" } })
  fireEvent.click(view.getByRole("tab", { name: /^FR/ }))
  expect(window.location.search).toBe("?locale=fr&keep=yes")
  expect(window.location.hash).toBe("#field")
  expect(replace).toHaveBeenCalledTimes(1)
  expect(input).toHaveValue("French")
  rerenderLocale("fr")
  expect(replace).toHaveBeenCalledTimes(1)
  expect(confirm).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  expect(scroll).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole("tab", { name: /^EN/ }))
  expect(input).toHaveValue("Unsaved English")
  replace.mockRestore(); scroll.mockRestore()
})

test("A10 refused locale conversion leaves URL and draft unchanged", () => {
  window.history.replaceState(null, "", "/admin/pages/page-1?locale=en&keep=yes")
  const { view, input } = mount({ content: bilingual, slug: "english", requestedLocale: "en" })
  fireEvent.change(input, { target: { value: "Keep this draft" } })
  mocks.refuseAdoption = true
  fireEvent.click(view.getByRole("tab", { name: /^FR/ }))
  expect(window.location.search).toBe("?locale=en&keep=yes")
  expect(input).toHaveValue("Keep this draft")
})

test("R10 side panel controls expose pressed state without tab roles", () => {
  const { view } = mount({ content: bilingual, slug: "english", requestedLocale: "en" })
  const seo = view.getByTitle(en.editor.page.tabs.seo)
  expect(seo).toHaveAttribute("aria-pressed", "false")
  fireEvent.click(seo)
  expect(seo).toHaveAttribute("aria-pressed", "true")
  expect(seo).not.toHaveAttribute("role", "tab")
})

test("R11 Open SEO focuses its actual title input after panel commit and locale switch", async () => {
  const { view } = mount({ content: bilingual, slug: "english", requestedLocale: "fr" })
  fireEvent.click(view.getByRole("button", { name: "ED3 Open SEO" }))
  await waitFor(() => expect(view.getByLabelText("Meta title")).toHaveFocus())
})

test("R20 one Cmd+S listener sees current dirty and saved conditions", async () => {
  const add = vi.spyOn(window, "addEventListener")
  const { view, input } = mount({ content: bilingual, slug: "english", requestedLocale: "en" })
  const listeners = () => add.mock.calls.filter(([name]) => name === "keydown").length
  const initial = listeners()
  fireEvent.change(input, { target: { value: "Shortcut draft" } })
  fireEvent.change(input, { target: { value: "Latest shortcut draft" } })
  expect(listeners()).toBe(initial)
  await act(async () => { fireEvent.keyDown(window, { key: "s", metaKey: true }) })
  await waitFor(() => expect(mocks.mutationCalls.some((call) => call.name.endsWith(":saveEditorDraft"))).toBe(true))
  expect(JSON.stringify(mocks.mutationCalls)).toContain("Latest shortcut draft")
  expect(view.getByRole("button", { name: en.editor.page.save })).toBeDisabled()
  const writes = mocks.mutationCalls.length
  fireEvent.keyDown(window, { key: "s", ctrlKey: true })
  expect(mocks.mutationCalls).toHaveLength(writes)
  add.mockRestore()
})

test("A13 Preview reuses a named window and detaches its opener", () => {
  const previewWindow = { opener: window }
  const open = vi.spyOn(window, "open").mockReturnValue(previewWindow as unknown as Window)
  const { view } = mount({ content: bilingual, slug: "english", requestedLocale: "en" })
  const preview = view.getByRole("button", { name: en.editor.page.preview })
  fireEvent.click(preview); fireEvent.click(preview)
  expect(open).toHaveBeenCalledTimes(2)
  const targets = open.mock.calls.map((call) => call[1])
  expect(targets[0]).toBeTruthy()
  expect(targets[0]).not.toBe("_blank")
  expect(targets[1]).toBe(targets[0])
  expect(open.mock.calls.every((call) => !call[2]?.includes("noopener"))).toBe(true)
  expect(previewWindow.opener).toBeNull()
  open.mockRestore()
})

test("A9 an empty conflict array renders no stray numeric text", () => {
  writeRecoveryDraft("page-1" as Id<"pages">, { base: null, ...{ locale: "en", savedAt: 500, title: "Recover", slug: "recover", pageType: "page", parentId: "", authorIds: [], tags: [], metaTitle: "", metaDescription: "", slices: [], seoNoIndex: false, seoNoFollow: false, seoOgTitle: "", seoOgDescription: "", seoOgImage: "", sharedFieldValues: {}, localizedFieldValues: {}, inlineConflicts: [] } })
  const { view } = mount({ content: bilingual, slug: "english", requestedLocale: "en" })
  const walker = document.createTreeWalker(view.container, NodeFilter.SHOW_TEXT)
  const zeros: Node[] = []
  while (walker.nextNode()) if (walker.currentNode.textContent === "0") zeros.push(walker.currentNode)
  expect(zeros).toHaveLength(0)
})
