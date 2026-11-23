import { act, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import { toast } from "sonner"
import { writeRecoveryDraft } from "./page-editor/lib/recovery"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page } from "./page-editor/lib/types"
import type { AdminAiTranslationHostProps } from "./contributions/ai-translation"
import { createInstalledDefaultBlock } from "@/test-utils/block-profile"
import { INSTALLED_BLOCK_TYPES } from "@/convex/lib/blocks"

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
  translation: null as AdminAiTranslationHostProps | null,
  returnDraftGenerations: false,
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
      if (mocks.returnDraftGenerations && name.endsWith(":saveEditorDraft")) {
        const patch = args[0] as { localized?: { expectedGeneration: number } }
        return { updatedAt: 101, draftGeneration: (patch.localized?.expectedGeneration ?? 0) + 1 }
      }
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
    parentId,
    onParentIdChange,
  }: {
    slug: string
    onSlugChange(value: string): void
    parentId: string
    onParentIdChange(value: string): void
  }) => (
    <>
    <input
      data-testid="address"
      value={slug}
      onChange={(e) => onSlugChange(e.target.value)}
    />
    <input aria-label="Parent" value={parentId} onChange={(e) => onParentIdChange(e.target.value)} />
    </>
  ),
}))
vi.mock("./page-editor/components/blocks-panel", () => ({
  BlocksPanel: () => null,
}))

vi.mock("./contributions/history", () => ({
  ADMIN_HISTORY_BROWSER_BINDING: { PanelSlot: () => null },
}))

vi.mock("./contributions/ai-translation", () => ({
  ADMIN_AI_TRANSLATION_BROWSER_BINDING: (props: AdminAiTranslationHostProps) => {
    mocks.translation = props
    return props.children({
      fieldTranslate: undefined, busy: false, command: null, control: null,
      setTranslateOpen() {}, runPushedTranslate() {}, panel: null,
    })
  },
}))

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
  mocks.translation = null
  mocks.returnDraftGenerations = false
  window.localStorage.clear()
  window.sessionStorage.clear()
})

type Content = Record<string, { title: string; blocks: import("@/convex/lib/blocks").Block[] }>

// A snapshot-authority page as the editor receives it: `slug` is the default
// language's address (or the legacy base address), `localizedSlugs` the others.
function mount(options: {
  content: Content
  slug: string
  localizedSlugs?: Record<string, string>
  requestedLocale: "en" | "fr"
  route?: { homePageId?: string }
  draftGenerations?: Record<string, number>
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
      aiTranslationRouteData={{ mechanicalTranslation: null, brandTranslation: null }}
      publication={{
        authority: "snapshot_active",
        lifecycleGeneration: 3,
        sharedDraftGeneration: 4,
        locales: Object.entries(options.draftGenerations ?? { en: 2, fr: 2 }).map(([locale, generation]) => ({
          locale,
          draftGeneration: generation,
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

const frOnly: Content = { fr: { title: "À propos", blocks: [] } }

test("Copy into an untouched empty default language supplies the source title and blocks, then saves that language", async () => {
  mocks.defaultLocale = "fr"
  const sourceBlock = INSTALLED_BLOCK_TYPES[0]
    ? createInstalledDefaultBlock(INSTALLED_BLOCK_TYPES[0])
    : undefined
  const { view, input, save } = mount({ content: { en: { title: "About", blocks: sourceBlock ? [sourceBlock] : [] } }, slug: "about", requestedLocale: "fr" })
  fireEvent.click(view.getByTitle(en.editor.page.copyBetweenLocales))
  const copy = await view.findByRole("button", { name: /Copy from EN/ })
  await act(async () => { fireEvent.click(copy) })
  expect(input).toHaveValue("About")
  const written = await saveAndReadWrites(save)
  expect(written).toContain('"locale":"fr"')
  expect(written).toContain('"title":"About"')
  const call = mocks.mutationCalls.find((c) => c.name.endsWith(":saveEditorDraft"))!
  const args = call.args[0] as { localized: { draft: { blocks: { id: string }[] } } }
  expect(args.localized.draft.blocks).toHaveLength(sourceBlock ? 1 : 0)
  if (sourceBlock) expect(args.localized.draft.blocks[0].id).not.toBe(sourceBlock.id)
  expect(toast.error).not.toHaveBeenCalledWith(en.editor.pageSave.titleRequired)
})

test("an untouched empty default language is clean and can prepare a transfer", async () => {
  mocks.defaultLocale = "fr"
  const { save } = mount({ content: { en: { title: "About", blocks: [] } }, slug: "about", requestedLocale: "fr" })
  expect(save).toBeDisabled()
  await act(async () => { expect(await mocks.translation!.ensureSaved()).toBe(true) })
  expect(mocks.mutationNames).not.toContain("cms/publication:saveEditorDraft")
  expect(toast.error).not.toHaveBeenCalledWith(en.editor.pageSave.titleRequired)
})

test("copy after saving and caching EN keeps absent FR generation zero, then advances only FR on its next save", async () => {
  mocks.defaultLocale = "fr"
  mocks.returnDraftGenerations = true
  const sourceBlock = INSTALLED_BLOCK_TYPES[0]
    ? createInstalledDefaultBlock(INSTALLED_BLOCK_TYPES[0])
    : undefined
  const { view, input, save } = mount({ content: { en: { title: "About", blocks: sourceBlock ? [sourceBlock] : [] } }, slug: "about", requestedLocale: "en", draftGenerations: { en: 7 } })
  fireEvent.change(input, { target: { value: "About Northline" } })
  await saveAndReadWrites(save)
  fireEvent.click(view.getByRole("tab", { name: /^FR/ }))
  expect(input).toHaveValue("")
  fireEvent.click(view.getByTitle(en.editor.page.copyBetweenLocales))
  await act(async () => { fireEvent.click(await view.findByRole("button", { name: /Copy from EN/ })) })
  expect(input).toHaveValue("About Northline")
  await saveAndReadWrites(save)
  const saves = () => mocks.mutationCalls.filter((c) => c.name.endsWith(":saveEditorDraft")).map((c) => c.args[0] as { expectedLifecycleGeneration: number; localized: { locale: string; expectedGeneration: number; draft: { blocks: { id: string }[] } } })
  expect(saves().map((s) => [s.localized.locale, s.localized.expectedGeneration])).toEqual([["en", 7], ["fr", 0]])
  expect(saves()[1].expectedLifecycleGeneration).toBe(3)
  if (sourceBlock) expect(saves()[1].localized.draft.blocks[0].id).not.toBe(sourceBlock.id)
  fireEvent.change(input, { target: { value: "Mon titre" } })
  await saveAndReadWrites(save)
  expect(saves().at(-1)!.localized).toMatchObject({ locale: "fr", expectedGeneration: 1 })
})

test("a shared-only save on an empty default language preserves the other language's address", async () => {
  mocks.defaultLocale = "fr"
  const { view, save } = mount({ content: { en: { title: "About", blocks: [] } }, slug: "about", requestedLocale: "fr" })
  fireEvent.click(view.getByTitle(en.editor.page.tabs.settings))
  fireEvent.change(view.getByRole("textbox", { name: "Parent" }), { target: { value: "parent-1" } })
  await saveAndReadWrites(save)
  const sent = mocks.mutationCalls.find((c) => c.name.endsWith(":saveEditorDraft"))!.args[0]
  expect(sent).toHaveProperty("shared")
  expect(sent).not.toHaveProperty("localized")
  expect(toast.error).not.toHaveBeenCalled()
})

test("a saved title-only target stays eligible while active and cached target edits remain unsaved", () => {
  const { view, input } = mount({ content: { en: { title: "About", blocks: [] }, fr: { title: "Mon titre", blocks: [] } }, slug: "about", requestedLocale: "fr" })
  expect(mocks.translation!.canTranslateCurrentLocale).toBe(true)
  expect(mocks.translation!.hasUnsavedTranslationTarget("fr")).toBe(false)
  fireEvent.change(input, { target: { value: "Titre modifié" } })
  expect(mocks.translation!.hasUnsavedTranslationTarget("fr")).toBe(true)
  fireEvent.click(view.getByRole("tab", { name: /^EN/ }))
  expect(mocks.translation!.hasUnsavedTranslationTarget("fr")).toBe(true)
})

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
    content: { en: { title: "About us", blocks: [] } },
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
      en: { title: "About", blocks: [] },
      fr: { title: "À propos", blocks: [] },
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
      en: { title: "My products", blocks: [] },
      fr: { title: "Mes produits", blocks: [] },
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

const bilingual: Content = { en: { title: "English", blocks: [] }, fr: { title: "French", blocks: [] } }

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
  writeRecoveryDraft("page-1" as Id<"pages">, { base: null, ...{ locale: "en", savedAt: 500, title: "Recover", slug: "recover", pageType: "page", parentId: "", authorIds: [], tags: [], metaTitle: "", metaDescription: "", blocks: [], seoNoIndex: false, seoNoFollow: false, seoOgTitle: "", seoOgDescription: "", seoOgImage: "", sharedFieldValues: {}, localizedFieldValues: {}, inlineConflicts: [] } })
  const { view } = mount({ content: bilingual, slug: "english", requestedLocale: "en" })
  const walker = document.createTreeWalker(view.container, NodeFilter.SHOW_TEXT)
  const zeros: Node[] = []
  while (walker.nextNode()) if (walker.currentNode.textContent === "0") zeros.push(walker.currentNode)
  expect(zeros).toHaveLength(0)
})
