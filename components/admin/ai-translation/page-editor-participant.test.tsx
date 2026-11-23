import { readFileSync } from "node:fs"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"

// The local job server actions are fakes: the screens decide the route.
vi.mock("@/app/(core)/admin/(authenticated)/pages/local-ai-job-actions", () => ({
  startLocalPageJob: vi.fn(),
  resumeLocalPageJob: vi.fn(),
  generatePageOutlineLocal: vi.fn(),
}))
import en from "../../../messages/admin/en.json"
import fr from "../../../messages/admin/fr.json"
import type { Locale } from "@/lib/i18n/config"
import type { AdminAiTranslationHostResult } from "../contributions/ai-translation"
import type { ModuleGate } from "../module-gate"
import { startLocalPageJob } from "@/app/(core)/admin/(authenticated)/pages/local-ai-job-actions"
import { PageEditorTranslationSlot } from "./page-editor-participant"

const mocks = vi.hoisted(() => ({
  gates: {} as Record<string, ModuleGate>,
  data: {} as Record<string, unknown>,
  queryNames: [] as string[],
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  results: [] as unknown[],
  push: vi.fn(),
  refresh: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  confirm: vi.fn(),
}))

vi.mock("convex/react", () => {
  const callable = (reference: unknown) => {
    const name = getFunctionName(reference as never)
    return (mocks.calls[name] ??= vi.fn())
  }
  return {
    useQueries: (request: Record<string, { query: unknown }>) =>
      Object.fromEntries(
        Object.entries(request).map(([key, { query }]) => {
          const name = getFunctionName(query as never)
          mocks.queryNames.push(name)
          return [key, mocks.data[name]]
        })
      ),
    useQuery: (reference: unknown, args: unknown) => {
      const name = getFunctionName(reference as never)
      if (args !== "skip") mocks.queryNames.push(name)
      return mocks.data[name]
    },
    useMutation: callable,
    useAction: callable,
  }
})
vi.mock("../admin-module-state-provider", () => ({
  useModuleGate: (id: string) => mocks.gates[id] ?? { state: "off" },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

const AI_QUERY = /^cms\/(ai|agents)|^agents\//
const PROGRESS = "cms/aiJobs:pageJobProgress"
const RESULT = "cms/aiJobs:pageJobResult"
const START = "cms/aiJobs:startPageJob"
const ACCEPT = "cms/aiJobs:acceptPageJob"
const DISMISS = "cms/aiJobs:dismissPageJob"
const CANCEL = "cms/aiJobs:cancelPageJob"
const RESUME = "cms/aiJobs:resumePageJob"

const status = (
  ready: boolean,
  state: "missing" | "refused" | "connected" = ready ? "connected" : "missing"
) => ({
  connections: [
    { provider: "openrouter", envVar: "OPENROUTER_API_KEY", state },
    {
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      state: "connected",
    },
  ],
  assistants: [
    { id: "translation", provider: "openrouter", ready, available: true },
    { id: "writing", provider: "anthropic", ready: true, available: true },
  ],
  card: { state: ready ? "active" : "missing" },
})

const segment = (index: number, state = "saved") => ({
  index,
  kind: "translation",
  segmentIndex: index,
  address: `blocks[${index}]`,
  state,
  reused: false,
  costMicros: 0,
})

const job = (jobId: string, over: Record<string, unknown> = {}) => ({
  jobId,
  kind: "translation",
  title: "About us",
  locale: "fr",
  sourceLocale: "en",
  targetLocale: "fr",
  state: "running",
  pageId: "page-1",
  estimateMicros: 0,
  costMicros: 0,
  createdAt: 0,
  expiresAt: 0,
  reusedCount: 0,
  canResume: false,
  resumeEstimateMicros: 0,
  dismissMovesPageToTrash: false,
  month: { spentMicros: 0, reservedMicros: 0, capMicros: 0, status: "below" },
  units: [segment(0), segment(1, "inProgress"), segment(2, "waiting")],
  ...over,
})

const RESULT_DATA = {
  jobId: "job-1",
  kind: "translation",
  pageId: "page-1",
  title: "About us",
  locale: "fr",
  pageAvailable: true,
  sourceLocale: "en",
  targetLocale: "fr",
  sourceChanged: false,
  pageFields: [
    { label: "Title", text: "À propos de nous" },
    { label: "Meta description", text: "Une petite équipe." },
    { label: "Role title", text: "Fondatrice" },
  ],
  sections: [
    {
      index: 0,
      blockType: "features-icon-grid",
      purpose: "",
      fields: [
        { label: "Heading", text: "Un atelier qui soigne les détails" },
        { label: "Text", text: "Nous concevons des sites." },
      ],
    },
    {
      index: 1,
      blockType: "rich-text-body",
      purpose: "",
      fields: [{ label: "Body", text: "Parlons de votre site." }],
    },
  ],
}

type SlotOptions = {
  currentLocale?: Locale
  fieldSource?: Locale | undefined
  content?: Record<string, unknown>
  hasAny?: (locale: Locale) => boolean
  language?: "en" | "fr"
  beginSavedLanguage?: (locale: Locale) => {
    complete: (generation: number) => void
  }
  ensureSaved?: () => Promise<boolean>
  canTranslateCurrentLocale?: boolean
  hasUnsavedTarget?: (locale: Locale) => boolean
  getActiveLocale?: () => Locale
  /** Translation's route data: `{ engine }` on this computer, null elsewhere. */
  route?: { engine: "claude" | "codex" | null } | null
}

function slot(options: SlotOptions = {}) {
  const language = options.language ?? "en"
  const hasAny = options.hasAny ?? ((locale: Locale) => locale === "en")
  const target = options.currentLocale ?? "fr"
  const saved = options.content?.[target] as { blocks?: unknown[] } | undefined
  return (
    <NextIntlClientProvider
      locale={language}
      messages={language === "fr" ? fr : en}
    >
      <PageEditorTranslationSlot
        routeData={{
          mechanicalTranslation: options.route ?? null,
          brandTranslation: options.route ?? null,
        }}
        page={
          {
            _id: "page-1",
            pageType: "page",
            content: options.content ?? { en: { title: "About us" } },
          } as never
        }
        currentLocale={options.currentLocale ?? "fr"}
        otherLocales={["en"]}
        fieldSource={"fieldSource" in options ? options.fieldSource : "en"}
        getLocaleSummary={(locale) =>
          ({
            hasAny: hasAny(locale),
            hasTranslatable: hasAny(locale),
          }) as never
        }
        canTranslateCurrentLocale={options.canTranslateCurrentLocale ?? (saved
          ? Array.isArray(saved.blocks) && saved.blocks.length === 0
          : !hasAny(target))}
        hasUnsavedTranslationTarget={options.hasUnsavedTarget ?? ((locale) => hasAny(locale) && options.content?.[locale] === undefined)}
        getActiveLocale={options.getActiveLocale ?? (() => options.currentLocale ?? "fr")}
        ensureSaved={options.ensureSaved ?? (async () => true)}
        prepareTransfer={async () => true}
        closeTransfer={() => {}}
        readSourceContent={() => ({}) as never}
        storeDraft={(_, draft) => draft}
        applyActiveDraft={() => {}}
        beginSavedLanguage={options.beginSavedLanguage}
      >
        {(result: AdminAiTranslationHostResult) => {
          mocks.results.push(result)
          return (
            <div data-testid="editor">
              <header data-testid="header">
                <div role="tablist" aria-label="Language" />
                {result.control}
                <button type="button">Save</button>
              </header>
              {result.panel}
              <main data-testid="body" />
            </div>
          )
        }}
      </PageEditorTranslationSlot>
    </NextIntlClientProvider>
  )
}

const renderSlot = (options: SlotOptions = {}) => render(slot(options))
const lastResult = () => mocks.results.at(-1) as AdminAiTranslationHostResult
const translateButton = () => screen.queryByTestId("translate-page")

beforeEach(() => {
  mocks.gates = {
    ai: { state: "on" },
    multilingual: { state: "on" },
  } as Record<string, ModuleGate>
  mocks.data = {
    "cms/aiSettings:status": status(true),
    [PROGRESS]: [],
    [RESULT]: RESULT_DATA,
  }
  mocks.queryNames = []
  mocks.calls = {}
  mocks.results = []
  mocks.push.mockReset()
  mocks.refresh.mockReset()
  mocks.toast.mockReset()
  mocks.toast.error.mockReset()
  mocks.toast.success.mockReset()
  mocks.confirm.mockReset()
  window.location.hash = ""
  Element.prototype.scrollIntoView = vi.fn()
})

describe("gate", () => {
  test.each([
    ["AI off", { ai: { state: "off" }, multilingual: { state: "on" } }],
    ["AI loading", { ai: { state: "loading" }, multilingual: { state: "on" } }],
    ["Multilingual off", { ai: { state: "on" }, multilingual: { state: "off" } }],
    [
      "Multilingual loading",
      { ai: { state: "on" }, multilingual: { state: "loading" } },
    ],
  ])("%s: the editor renders with no AI read and no Translation", (_, gates) => {
    mocks.gates = gates as Record<string, ModuleGate>
    renderSlot()
    expect(screen.getByTestId("editor")).toBeInTheDocument()
    expect(mocks.queryNames.filter((name) => AI_QUERY.test(name))).toEqual([])
    expect(translateButton()).not.toBeInTheDocument()
    expect(lastResult()).toMatchObject({
      busy: false,
      control: null,
      panel: null,
      command: null,
      fieldTranslate: undefined,
    })
  })

  test("a single-language page (no source language) gets no Translation", () => {
    renderSlot({ fieldSource: undefined })
    expect(mocks.queryNames.filter((name) => AI_QUERY.test(name))).toEqual([])
    expect(lastResult().control).toBeNull()
  })

  test("AI on but Translation not ready: the key notice replaces the button", () => {
    mocks.data["cms/aiSettings:status"] = status(false)
    renderSlot()
    expect(translateButton()).not.toBeInTheDocument()
    const notice = screen.getByTestId("api-key-notice")
    expect(notice).toHaveTextContent("Not configured: API key is missing")
    expect(screen.getByTestId("header")).toContainElement(notice)
    // Jobs are read whatever Translation's setup; with none, no panel shows.
    expect(mocks.queryNames).toContain(PROGRESS)
    expect(screen.queryByTestId("translate-panel")).not.toBeInTheDocument()
  })

  test("a refused key names the provider and variable", () => {
    mocks.data["cms/aiSettings:status"] = status(false, "refused")
    renderSlot()
    expect(screen.getByTestId("api-key-notice")).toHaveTextContent(
      "OPENROUTER_API_KEY"
    )
  })

  test("the host result never brings back the old Translate popover", () => {
    renderSlot()
    const result = lastResult()
    expect(result.fieldTranslate).toBeUndefined()
    expect(result.command).toBeNull()
    expect(() => result.setTranslateOpen(true)).not.toThrow()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const editor = readFileSync("components/admin/page-editor.tsx", "utf8")
    expect(editor).not.toMatch(/mode="translate"/)
  })
})

// The header control shows only on an eligible empty language, in every state.
// While this page's job runs, its card and running note stay on every tab.
describe("header control eligibility", () => {
  const tabs: [string, SlotOptions, boolean][] = [
    ["the source tab", { currentLocale: "en" }, false],
    [
      "a target with typed text",
      { currentLocale: "fr", hasAny: (locale) => locale !== "de" },
      false,
    ],
    [
      "a target with a saved entry",
      { currentLocale: "fr", content: { en: { title: "About us" }, fr: {} } },
      false,
    ],
    ["the empty target", { currentLocale: "fr" }, true],
    ["another empty language", { currentLocale: "de" as Locale }, true],
  ]
  const cells = (["idle", "running", "not ready"] as const).flatMap((state) =>
    tabs.map(([tab, options, shown]) => ({ state, tab, options, shown }))
  )

  test.each(cells)(
    "$state on $tab: control shown = $shown",
    ({ state, options, shown }) => {
      if (state === "running") mocks.data[PROGRESS] = [job("job-1")]
      if (state === "not ready")
        mocks.data["cms/aiSettings:status"] = status(false)
      renderSlot(options)
      const header = screen.getByTestId("header")
      const control =
        state === "not ready"
          ? screen.queryByTestId("api-key-notice")
          : translateButton()
      if (shown) {
        expect(header).toContainElement(control)
        if (state === "idle")
          expect(control).toHaveTextContent("Translate from EN")
        if (state === "running") {
          expect(control).toHaveTextContent("Translating…")
          expect(control).toBeDisabled()
        }
      } else {
        expect(control).not.toBeInTheDocument()
        // Only the host's own tab list and Save remain in the header.
        expect(header.children).toHaveLength(2)
      }
      if (state === "running") {
        expect(screen.getByTestId("job-progress")).toBeInTheDocument()
        expect(screen.getByTestId("translate-running")).toHaveTextContent(
          "Translating this page into French."
        )
      }
    }
  )

  test("while running, typing or switching tabs hides and shows it again", () => {
    mocks.data[PROGRESS] = [job("job-1")]
    let typed = false
    const options = (over: SlotOptions): SlotOptions => ({
      hasAny: (locale) => locale === "en" || (typed && locale === "fr"),
      ...over,
    })
    const view = renderSlot(options({ currentLocale: "fr" }))
    expect(translateButton()).toHaveTextContent("Translating…")
    typed = true
    view.rerender(slot(options({ currentLocale: "fr" })))
    expect(translateButton()).not.toBeInTheDocument()
    view.rerender(slot(options({ currentLocale: "en" })))
    expect(translateButton()).not.toBeInTheDocument()
    view.rerender(slot(options({ currentLocale: "de" as Locale })))
    expect(translateButton()).toHaveTextContent("Translating…")
    expect(screen.getByTestId("job-progress")).toBeInTheDocument()
    expect(screen.getByTestId("translate-running")).toBeInTheDocument()
  })
})

describe("Translate from EN", () => {
  test("Start saves a pending title before pinning the target generation", async () => {
    const ensureSaved = vi.fn().mockResolvedValue(true)
    mocks.calls[START] = vi.fn().mockResolvedValue("job-1")
    renderSlot({ content: { en: { title: "About" }, fr: { title: "Mon titre", blocks: [] } }, hasAny: () => true, ensureSaved })
    fireEvent.click(translateButton()!)
    fireEvent.click(screen.getByTestId("start-job"))
    await waitFor(() => expect(mocks.calls[START]).toHaveBeenCalled())
    expect(ensureSaved.mock.invocationCallOrder[0]).toBeLessThan(mocks.calls[START].mock.invocationCallOrder[0])
  })

  test("Start stops when saving fails or the owner switches locale while saving", async () => {
    let finish!: (ok: boolean) => void
    let active: Locale = "fr"
    const ensureSaved = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    mocks.calls[START] = vi.fn()
    renderSlot({ ensureSaved, getActiveLocale: () => active })
    fireEvent.click(translateButton()!)
    fireEvent.click(screen.getByTestId("start-job"))
    active = "en"
    finish(true)
    await waitFor(() => expect(screen.getByTestId("start-job")).toBeEnabled())
    expect(mocks.calls[START]).not.toHaveBeenCalled()
    active = "fr"
    fireEvent.click(screen.getByTestId("start-job"))
    finish(false)
    await waitFor(() => expect(screen.getByTestId("start-job")).toBeEnabled())
    expect(mocks.calls[START]).not.toHaveBeenCalled()
  })
  test("a saved title without blocks still offers Translate from EN", () => {
    renderSlot({ content: { en: { title: "About" }, fr: { title: "Mon titre", blocks: [] } }, hasAny: () => true })
    expect(translateButton()).toHaveTextContent("Translate from EN")
  })
  test("shows on an empty language other than the source", () => {
    renderSlot()
    expect(translateButton()).toHaveTextContent("Translate from EN")
    expect(screen.getByTestId("header")).toContainElement(translateButton())
  })

  test("never shows on the source language", () => {
    renderSlot({ currentLocale: "en" })
    expect(translateButton()).not.toBeInTheDocument()
  })

  test("never shows on a language with content or a saved draft", () => {
    const { unmount } = renderSlot({ hasAny: () => true })
    expect(translateButton()).not.toBeInTheDocument()
    unmount()
    renderSlot({ content: { en: {}, fr: { title: "" } } })
    expect(translateButton()).not.toBeInTheDocument()
  })

  test("never shows while this language has an unreviewed job", () => {
    mocks.data[PROGRESS] = [job("job-1", { state: "done" })]
    renderSlot()
    expect(translateButton()).not.toBeInTheDocument()
  })

  test("while this page's job runs it reads Translating… and is disabled", () => {
    mocks.data[PROGRESS] = [job("job-1")]
    renderSlot()
    expect(translateButton()).toHaveTextContent("Translating…")
    expect(translateButton()).toBeDisabled()
    expect(lastResult().busy).toBe(true)
    expect(screen.getByTestId("translate-running")).toHaveTextContent(
      "Translating this page into French."
    )
  })

  test("Start sends the whole-page translation input", async () => {
    mocks.calls[START] = vi.fn().mockResolvedValue("job-1")
    renderSlot()
    fireEvent.click(translateButton()!)
    const start = screen.getByTestId("start-job")
    expect(start).toHaveTextContent("Start")
    expect(screen.getByTestId("header")).not.toContainElement(start)
    fireEvent.click(start)
    await waitFor(() =>
      expect(mocks.calls[START]).toHaveBeenCalledWith({
        input: {
          kind: "translation",
          pageId: "page-1",
          sourceLocale: "en",
          targetLocale: "fr",
        },
      })
    )
    await waitFor(() =>
      expect(screen.queryByTestId("start-job")).not.toBeInTheDocument()
    )
  })

  test.each([
    [
      "AI_JOB_TARGET_HAS_CONTENT",
      "This language already has content. Translate page works only on an empty language.",
    ],
    [
      "AI_JOB_SOURCE_TOO_LARGE",
      "This page is too long to translate in one job.",
    ],
    [
      "CONTENT_TYPE_TRANSLATION_OFF",
      "Not shown on the site: translation is off for Pages.",
    ],
  ])("refusal %s shows its line", async (code, text) => {
    mocks.calls[START] = vi.fn().mockRejectedValue(new ConvexError(code))
    renderSlot()
    fireEvent.click(translateButton()!)
    fireEvent.click(screen.getByTestId("start-job"))
    expect(await screen.findByRole("alert")).toHaveTextContent(text)
  })

  test("any other refusal shows the start-failed line", async () => {
    mocks.calls[START] = vi.fn().mockRejectedValue(new Error("boom"))
    renderSlot()
    fireEvent.click(translateButton()!)
    fireEvent.click(screen.getByTestId("start-job"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The job could not start. Try again."
    )
  })

  test("another running job: the notice links to that job's page", async () => {
    mocks.data[PROGRESS] = [
      job("job-9", { pageId: "page-9", targetLocale: "fr" }),
    ]
    renderSlot()
    fireEvent.click(translateButton()!)
    const notice = screen.getByTestId("one-job")
    expect(notice).toHaveTextContent("A page job is already running.")
    expect(screen.queryByTestId("start-job")).not.toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Open the running job" })
    ).toHaveAttribute("href", "/admin/pages/page-9#ai-page-job-job-9")
  })

  test("AI_JOB_ALREADY_ACTIVE at Start shows the running notice", async () => {
    mocks.calls[START] = vi
      .fn()
      .mockRejectedValue(new ConvexError("AI_JOB_ALREADY_ACTIVE"))
    renderSlot()
    fireEvent.click(translateButton()!)
    fireEvent.click(screen.getByTestId("start-job"))
    expect(await screen.findByTestId("one-job")).toHaveTextContent(
      "A page job is already running."
    )
  })
})

describe("card", () => {
  test("counts segments and names each one", () => {
    mocks.data[PROGRESS] = [job("job-1")]
    renderSlot()
    expect(screen.getByTestId("job-count")).toHaveTextContent(
      "1 of 3 segments"
    )
    const units = screen.getAllByTestId("job-unit")
    expect(units[0]).toHaveTextContent("Segment 1")
    expect(units[2]).toHaveTextContent("Segment 3")
    expect(screen.getByTestId("header")).not.toContainElement(
      screen.getByTestId("job-progress")
    )
  })

  test("shows only this page's translation jobs", () => {
    mocks.data[PROGRESS] = [
      job("job-1", { state: "done" }),
      job("job-2", { pageId: "page-2", state: "done" }),
      { ...job("job-3", { state: "done" }), kind: "write" },
    ]
    renderSlot()
    expect(
      screen
        .getAllByTestId("job-progress")
        .map((card) => card.getAttribute("data-job-id"))
    ).toEqual(["job-1"])
  })

  test("Cancel, Resume and Dismiss call their mutations", async () => {
    mocks.data[PROGRESS] = [job("job-1")]
    const { unmount } = renderSlot()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(mocks.calls[CANCEL]).toHaveBeenCalledWith({ jobId: "job-1" })
    )
    unmount()
    mocks.data[PROGRESS] = [job("job-1", { state: "failed" })]
    mocks.confirm.mockResolvedValue(true)
    mocks.calls[DISMISS] = vi.fn().mockResolvedValue({ pageMovedToTrash: false })
    renderSlot()
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() =>
      expect(mocks.calls[RESUME]).toHaveBeenCalledWith({ jobId: "job-1" })
    )
    fireEvent.click(screen.getByTestId("dismiss-job"))
    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith({
        title: "Dismiss this translation?",
        description: "Nothing is saved.",
        confirmText: "Dismiss",
      })
    )
    await waitFor(() =>
      expect(mocks.calls[DISMISS]).toHaveBeenCalledWith({ jobId: "job-1" })
    )
  })

  test("Review translation toggles the list", () => {
    mocks.data[PROGRESS] = [job("job-1", { state: "done" })]
    renderSlot()
    const review = screen.getByRole("button", { name: "Review translation" })
    expect(review).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(review)
    expect(review).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("translation-review")).toBeInTheDocument()
    fireEvent.click(review)
    expect(screen.queryByTestId("translation-review")).not.toBeInTheDocument()
  })
})

function openReview(options: SlotOptions = {}) {
  mocks.data[PROGRESS] = [job("job-1", { state: "done" })]
  renderSlot(options)
  fireEvent.click(
    screen.getByRole("button", {
      name:
        options.language === "fr"
          ? "Relire la traduction"
          : "Review translation",
    })
  )
  return screen.getByTestId("translation-review")
}

describe("review list", () => {
  test("lists page fields, then each section's text, with no checkboxes", () => {
    const list = openReview()
    expect(list).toHaveTextContent("Translation into French")
    const rows = screen.getAllByTestId("review-row")
    expect(rows.map((row) => row.firstChild?.textContent)).toEqual([
      "Title",
      "Meta description",
      "Role title",
      "Block 1",
      "Block 2",
    ])
    expect(rows[3]).toHaveTextContent("Un atelier qui soigne les détails")
    expect(rows[3]).toHaveTextContent("Nous concevons des sites.")
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(screen.queryByTestId("source-changed")).not.toBeInTheDocument()
  })

  test("a changed source adds the muted line", () => {
    mocks.data[RESULT] = { ...RESULT_DATA, sourceChanged: true }
    openReview()
    expect(screen.getByTestId("source-changed")).toHaveTextContent(
      "English was edited after the translation started. This translation follows the earlier text."
    )
  })

  test("Accept saves the whole page, toasts, and reloads that tab", async () => {
    const order: string[] = []
    const complete = vi.fn()
    const begin = vi.fn(() => {
      order.push("begin")
      return { complete }
    })
    mocks.calls[ACCEPT] = vi
      .fn()
      .mockResolvedValue({ pageId: "page-1", saved: 2, draftGeneration: 4 })
    openReview({
      beginSavedLanguage: begin,
      ensureSaved: async () => {
        order.push("ensureSaved")
        return true
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    await waitFor(() =>
      expect(mocks.calls[ACCEPT]).toHaveBeenCalledWith({
        jobId: "job-1",
        chosen: [],
      })
    )
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "Saved to your draft. Nothing is published."
      )
    )
    // Started at the press, before the open tab is saved; completed once.
    expect(begin).toHaveBeenCalledWith("fr")
    expect(order).toEqual(["begin", "ensureSaved"])
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(4)
  })

  test("a changed target refuses: red line, Accept disabled until reopened", async () => {
    mocks.calls[ACCEPT] = vi
      .fn()
      .mockRejectedValue(new ConvexError("AI_JOB_TARGET_CHANGED"))
    const complete = vi.fn()
    openReview({ beginSavedLanguage: () => ({ complete }) })
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(await screen.findByTestId("target-changed")).toHaveTextContent(
      "French was changed after the translation started. Nothing was saved."
    )
    expect(complete).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled()
    const review = screen.getByRole("button", { name: "Review translation" })
    fireEvent.click(review)
    fireEvent.click(review)
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled()
    expect(screen.queryByTestId("target-changed")).not.toBeInTheDocument()
  })

  test("Accept on an untitled target prepares the host before the atomic translation save", async () => {
    const ensureSaved = vi.fn().mockResolvedValue(true)
    mocks.calls[ACCEPT] = vi.fn().mockResolvedValue({ pageId: "page-1", saved: 2, draftGeneration: 4 })
    openReview({ content: { en: { title: "About" } }, hasAny: (locale) => locale === "en", ensureSaved })
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    await waitFor(() => expect(mocks.calls[ACCEPT]).toHaveBeenCalledWith({ jobId: "job-1", chosen: [] }))
    expect(ensureSaved).toHaveBeenCalledTimes(1)
    expect(ensureSaved.mock.invocationCallOrder[0]).toBeLessThan(mocks.calls[ACCEPT]!.mock.invocationCallOrder[0]!)
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  test("a saved target title alone does not block Accept", async () => {
    mocks.calls[ACCEPT] = vi.fn().mockResolvedValue({ pageId: "page-1", saved: 2, draftGeneration: 4 })
    openReview({ content: { en: { title: "About" }, fr: { title: "Mon titre", blocks: [] } }, hasAny: () => true })
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    await waitFor(() => expect(mocks.calls[ACCEPT]).toHaveBeenCalledWith({ jobId: "job-1", chosen: [] }))
  })

  test("unsaved text in the target language blocks Accept with the same line", async () => {
    let typed = false
    openReview({ hasAny: (locale) => locale === "en" || typed })
    typed = true
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(await screen.findByTestId("target-changed")).toHaveTextContent(
      "French was changed after the translation started. Nothing was saved."
    )
    expect(mocks.calls[ACCEPT] ?? vi.fn()).not.toHaveBeenCalled()
    expect(screen.getByTestId("job-progress")).toBeInTheDocument()
  })

  test("unsaved text in another language is saved before Accept", async () => {
    const ensureSaved = vi.fn().mockResolvedValue(true)
    mocks.calls[ACCEPT] = vi
      .fn()
      .mockResolvedValue({ pageId: "page-1", saved: 2, draftGeneration: 4 })
    openReview({ ensureSaved })
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    await waitFor(() => expect(mocks.calls[ACCEPT]).toHaveBeenCalled())
    expect(ensureSaved).toHaveBeenCalledTimes(1)
    expect(ensureSaved.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.calls[ACCEPT]!.mock.invocationCallOrder[0]!
    )
  })

  test("a refused editor save stops Accept with the save-failed line", async () => {
    const ensureSaved = vi.fn().mockResolvedValue(false)
    const complete = vi.fn()
    openReview({ ensureSaved, beginSavedLanguage: () => ({ complete }) })
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(await screen.findByTestId("save-error")).toHaveTextContent(
      "Could not save. Your blocks are kept. Try again."
    )
    expect(ensureSaved).toHaveBeenCalledTimes(1)
    expect(mocks.calls[ACCEPT] ?? vi.fn()).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  test("another save failure shows the save-failed line", async () => {
    mocks.calls[ACCEPT] = vi.fn().mockRejectedValue(new Error("boom"))
    const complete = vi.fn()
    openReview({ beginSavedLanguage: () => ({ complete }) })
    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(await screen.findByTestId("save-error")).toHaveTextContent(
      "Could not save. Your blocks are kept. Try again."
    )
    expect(complete).not.toHaveBeenCalled()
  })

  test("Dismiss asks first and saves nothing", async () => {
    mocks.confirm.mockResolvedValue(false)
    openReview()
    fireEvent.click(screen.getByTestId("dismiss-translation"))
    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Dismiss this translation?",
          description: "Nothing is saved.",
        })
      )
    )
    expect(mocks.calls[DISMISS] ?? vi.fn()).not.toHaveBeenCalled()
    expect(mocks.calls[ACCEPT] ?? vi.fn()).not.toHaveBeenCalled()
  })
})

describe("French interface", () => {
  test("button, running note, card and review read in French", () => {
    mocks.data[PROGRESS] = [job("job-1")]
    const { unmount } = renderSlot({ language: "fr" })
    expect(translateButton()).toHaveTextContent("Traduction en cours…")
    expect(screen.getByTestId("translate-running")).toHaveTextContent(
      "Traduction de cette page en français."
    )
    expect(screen.getByTestId("job-count")).toHaveTextContent(
      "1 sur 3 segments"
    )
    unmount()
    mocks.data[PROGRESS] = []
    const second = renderSlot({ language: "fr" })
    expect(translateButton()).toHaveTextContent("Traduire depuis EN")
    second.unmount()
    mocks.data[RESULT] = { ...RESULT_DATA, sourceChanged: true }
    openReview({ language: "fr" })
    expect(screen.getByTestId("translation-review")).toHaveTextContent(
      "Traduction en français"
    )
    expect(screen.getByTestId("source-changed")).toHaveTextContent(
      "L'anglais a été modifié après le début de la traduction. Cette traduction suit le texte précédent."
    )
    const rows = screen.getAllByTestId("review-row")
    expect(rows[0]!.firstChild?.textContent).toBe("Titre")
    expect(rows[1]!.firstChild?.textContent).toBe("Méta-description")
    expect(
      screen.getByRole("button", { name: "Relire la traduction" })
    ).toHaveAttribute("aria-expanded", "true")
  })

  test("a refused Accept names the target with its article", async () => {
    mocks.calls[ACCEPT] = vi
      .fn()
      .mockRejectedValue(new ConvexError("AI_JOB_TARGET_CHANGED"))
    openReview({ language: "fr" })
    fireEvent.click(screen.getByRole("button", { name: "Accepter" }))
    expect(await screen.findByTestId("target-changed")).toHaveTextContent(
      "Le français a été modifié après le début de la traduction. Rien n'a été enregistré."
    )
  })
})

describe("no cost anywhere", () => {
  test.each(["en", "fr"] as const)("%s screens show no cost words", (language) => {
    mocks.data[PROGRESS] = [
      job("job-1", { state: "done", costMicros: 250000, estimateMicros: 300000 }),
    ]
    openReview({ language })
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(
      /\$|€|estimat|\bcap\b|reserved|réserv|limite|coût|cost/i
    )
  })
})

// Approved image 4(a), Translation line (owner, 2026-11-16).
describe("Translation on a local tool", () => {
  const marked = { aiRuntime: { assistants: { translation: { localTool: true } } } }

  test("on this computer with no API connection: Start runs the local action", async () => {
    mocks.gates.ai = { state: "needs_setup", setup: ["required"] }
    mocks.data["cms/aiSettings:status"] = status(false)
    mocks.data["cms/settings:getSettings"] = marked
    vi.mocked(startLocalPageJob).mockResolvedValue({ ok: true, value: "job-3" } as never)
    renderSlot({ route: { engine: "codex" } })
    fireEvent.click(translateButton()!)
    fireEvent.click(screen.getByTestId("start-job"))
    await waitFor(() =>
      expect(startLocalPageJob).toHaveBeenCalledWith({
        kind: "translation",
        pageId: "page-1",
        sourceLocale: "en",
        targetLocale: "fr",
      })
    )
    expect(mocks.calls[START]).not.toHaveBeenCalled()
  })

  test.each([
    ["en", "Translation runs with a local tool. Open the admin on the computer that runs formulacms, or choose an API connection in Settings › AI.", "Settings › AI"],
    ["fr", "La traduction utilise un outil local. Ouvrez l'administration sur l'ordinateur qui exécute formulacms, ou choisissez une connexion API dans Paramètres › IA.", "Paramètres › IA"],
  ] as const)("another device (%s): the message replaces the button", (language, text, link) => {
    mocks.data["cms/settings:getSettings"] = marked
    renderSlot({ language })
    expect(translateButton()).not.toBeInTheDocument()
    const notice = screen.getByTestId("local-tool-elsewhere")
    expect(notice).toHaveTextContent(text)
    // Same notice as Help's (image 4): one component, one role.
    expect(notice).toHaveAttribute("data-slot", "amber-notice")
    expect(notice).toHaveAttribute("role", "status")
    expect(screen.getByRole("link", { name: link })).toHaveAttribute("href", "/admin/settings/ai")
  })

  test("a stale tab: Convex refuses the API start and the panel says why", async () => {
    mocks.calls[START] = vi.fn().mockRejectedValue(new ConvexError("AI_ASSISTANT_RUNS_ON_LOCAL_TOOL"))
    renderSlot()
    fireEvent.click(translateButton()!)
    fireEvent.click(screen.getByTestId("start-job"))
    expect(await screen.findByTestId("local-tool-elsewhere")).toHaveTextContent("Translation runs with a local tool.")
    expect(screen.queryByTestId("start-job")).not.toBeInTheDocument()
  })

  test.each([
    ["canceled", "resume-job"],
    ["done", "review-translation"],
  ] as const)("guard: back on an API service with no key, a %s local job keeps its card and controls", (state, control) => {
    // This computer, Translation's local choice removed, no key and no marker.
    mocks.gates.ai = { state: "needs_setup", setup: ["required"] }
    mocks.data["cms/aiSettings:status"] = status(false)
    const units = state === "done" ? [segment(0), segment(1)] : [segment(0), segment(1, "waiting")]
    mocks.data[PROGRESS] = [
      job("job-1", { state, canResume: state === "canceled", units, localTool: { engine: "codex" } }),
    ]
    renderSlot({ route: { engine: null } })
    expect(screen.getByTestId("job-progress")).toBeInTheDocument()
    expect(screen.getByTestId(control)).toBeInTheDocument()
    if (state === "canceled") expect(screen.getByTestId("dismiss-job")).toBeInTheDocument()
    // Starting a new job still needs a ready service.
    expect(translateButton()).not.toBeInTheDocument()
    expect(screen.getByTestId("api-key-notice")).toBeInTheDocument()
  })

  test("guard: a running local job holds the editor after Translation leaves its local tool", () => {
    mocks.gates.ai = { state: "needs_setup", setup: ["required"] }
    mocks.data["cms/aiSettings:status"] = status(false)
    mocks.data[PROGRESS] = [job("job-1", { localTool: { engine: "codex" } })]
    renderSlot({ route: { engine: null } })
    expect(lastResult().busy).toBe(true)
    expect(screen.getByTestId("job-progress")).toBeInTheDocument()
  })

  test("no marker: no local message", () => {
    renderSlot()
    expect(translateButton()).toBeInTheDocument()
    expect(screen.queryByTestId("local-tool-elsewhere")).not.toBeInTheDocument()
  })
})

// Round 2, S4: AI off (a null status) closes Start, even with a local tool.
describe("AI off with a local tool", () => {
  test.each(["claude", "codex"] as const)("%s: ready → null with the gate on hides an open Start; another language's job keeps its card", (engine) => {
    vi.mocked(startLocalPageJob).mockClear()
    mocks.data["cms/aiSettings:status"] = status(false)
    mocks.data[PROGRESS] = [
      job("job-de", { locale: "de", targetLocale: "de", state: "done", units: [segment(0), segment(1)], localTool: { engine } }),
    ]
    const view = renderSlot({ route: { engine } })
    fireEvent.click(translateButton()!)
    expect(screen.getByTestId("start-job")).toBeInTheDocument()
    mocks.data["cms/aiSettings:status"] = null
    view.rerender(slot({ route: { engine } }))
    expect(screen.queryByTestId("start-job")).not.toBeInTheDocument()
    expect(translateButton()).not.toBeInTheDocument()
    expect(screen.getByTestId("job-progress")).toBeInTheDocument()
    expect(startLocalPageJob).not.toHaveBeenCalled()
  })
})
