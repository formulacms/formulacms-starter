import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../../../messages/admin/en.json"
import fr from "../../../messages/admin/fr.json"
import type { ContentType } from "@/convex/lib/contentTypes"
import type { AdminAiWritingNewPageHostResult } from "../contributions/ai-writing"
import type { ModuleGate } from "../module-gate"
import { NewPageWritingSlot } from "./new-page-participant"

const mocks = vi.hoisted(() => ({
  gate: { state: "on" } as ModuleGate,
  data: {} as Record<string, unknown>,
  queryNames: [] as string[],
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  results: [] as unknown[],
  push: vi.fn(),
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
  useModuleGate: () => mocks.gate,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

const AI_QUERY = /^cms\/(ai|agents)|^agents\//
const status = (
  ready: boolean,
  state: "missing" | "refused" | "connected" = ready ? "connected" : "missing"
) => ({
  connections: [
    {
      provider: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      state: "connected",
    },
    { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", state },
  ],
  assistants: [
    { id: "translation", provider: "openrouter", ready: true, available: true },
    { id: "writing", provider: "anthropic", ready, available: true },
  ],
  card: { state: ready ? "active" : "missing" },
})
const job = (jobId: string, over: Record<string, unknown> = {}) => ({
  jobId,
  kind: "write",
  title: `Page ${jobId}`,
  locale: "en",
  state: "done",
  pageId: "page-1",
  estimateMicros: 0,
  costMicros: 0,
  createdAt: 0,
  expiresAt: 0,
  reusedCount: 0,
  canResume: false,
  resumeEstimateMicros: 0,
  dismissMovesPageToTrash: true,
  month: { spentMicros: 0, reservedMicros: 0, capMicros: 0, status: "below" },
  units: [
    {
      index: 0,
      kind: "write",
      purpose: "Intro",
      state: "saved",
      reused: false,
      costMicros: 0,
    },
  ],
  ...over,
})

type SlotOptions = {
  pageType?: ContentType
  locale?: string
  isCreating?: boolean
  canCreateSelected?: boolean
  language?: "en" | "fr"
}

function slot(options: SlotOptions = {}) {
  const language = options.language ?? "en"
  return (
    <NextIntlClientProvider
      locale={language}
      messages={language === "fr" ? fr : en}
    >
      <NewPageWritingSlot
        routeData={{ editorialCopy: null, structuredOutlineMeta: null }}
        title=""
        locale={options.locale ?? "en"}
        pageType={options.pageType ?? "page"}
        canSubmit={false}
        canCreateSelected={options.canCreateSelected ?? true}
        isCreating={options.isCreating ?? false}
        createShellPage={async () => undefined}
      >
        {(result: AdminAiWritingNewPageHostResult) => {
          mocks.results.push(result)
          return (
            <form aria-label="New page">
              <div data-testid="button-row">
                <button type="submit">Create page</button>
                {result.pageWizardControl}
                <button type="button">Import .md</button>
              </div>
            </form>
          )
        }}
      </NewPageWritingSlot>
    </NextIntlClientProvider>
  )
}

const renderSlot = (options?: SlotOptions) => render(slot(options))
const writeButton = () =>
  screen.queryByRole("button", { name: "Write page with AI" })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate = { state: "on" }
  mocks.queryNames.length = 0
  mocks.results.length = 0
  mocks.calls = {}
  mocks.data = {
    "cms/aiSettings:status": status(true),
    "cms/aiJobs:pageJobProgress": [],
    "cms/settings:getSiteConfig": {
      enabledLocales: ["en", "fr"],
      defaultLocale: "en",
    },
    "cms/agents:getContentPresets": {
      writeBriefs: [],
      refinePresets: [],
      pageBriefs: [],
    },
    "cms/settings:getSettings": { brandVoice: "" },
  }
  Element.prototype.scrollIntoView = vi.fn()
})

describe("module off", () => {
  test.each([
    { state: "off" },
    { state: "loading" },
    { state: "error" },
  ] as ModuleGate[])(
    "$state: the form renders alone and no AI read opens",
    (gate) => {
      mocks.gate = gate
      mocks.data["cms/aiJobs:pageJobProgress"] = [job("job-1")]
      renderSlot()
      expect(
        screen.getByRole("button", { name: "Create page" })
      ).toBeInTheDocument()
      expect(mocks.results.at(-1)).toEqual({
        busy: false,
        starterHeroControl: null,
        pageWizardControl: null,
      })
      expect(writeButton()).not.toBeInTheDocument()
      expect(screen.queryByTestId("job-progress")).not.toBeInTheDocument()
      expect(mocks.queryNames.filter((name) => AI_QUERY.test(name))).toEqual([])
    }
  )
})

describe("module on, Writing not ready", () => {
  test("the key notice replaces the button; no card and no job read", () => {
    mocks.data["cms/aiSettings:status"] = status(false)
    mocks.data["cms/aiJobs:pageJobProgress"] = [job("job-1")]
    renderSlot()
    expect(writeButton()).not.toBeInTheDocument()
    const notice = screen.getByTestId("api-key-notice")
    expect(notice).toHaveTextContent("Not configured: API key is missing")
    // On its own line under the form, never in the form's button row.
    const form = screen.getByRole("form", { name: "New page" })
    expect(form).not.toContainElement(notice)
    expect(
      form.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      [...screen.getByTestId("button-row").children].map(
        (node) => node.textContent
      )
    ).toEqual(["Create page", "Import .md"])
    expect(
      screen.getByRole("link", { name: "Go to Settings › AI" })
    ).toHaveAttribute("href", "/admin/settings/ai")
    expect(screen.queryByTestId("job-progress")).not.toBeInTheDocument()
    expect(mocks.queryNames).not.toContain("cms/aiJobs:pageJobProgress")
  })

  test("a refused key names the provider and its variable", () => {
    mocks.gate = { state: "needs_setup", setup: ["required"] }
    mocks.data["cms/aiSettings:status"] = status(false, "refused")
    renderSlot()
    expect(screen.getByTestId("api-key-notice")).toHaveTextContent(
      "Key refused: Anthropic rejected ANTHROPIC_API_KEY"
    )
    // No setup link from the containment boundary: the notice is the only hint.
    expect(screen.getAllByRole("link")).toHaveLength(1)
  })

  test("French key notice", () => {
    mocks.data["cms/aiSettings:status"] = status(false, "refused")
    renderSlot({ language: "fr" })
    expect(screen.getByTestId("api-key-notice")).toHaveTextContent(
      "Clé refusée : Anthropic a rejeté ANTHROPIC_API_KEY"
    )
    expect(
      screen.getByRole("link", { name: "Aller dans Paramètres › IA" })
    ).toBeInTheDocument()
    mocks.data["cms/aiSettings:status"] = status(false)
    renderSlot({ language: "fr" })
    expect(screen.getAllByTestId("api-key-notice")[1]).toHaveTextContent(
      "Non configuré : la clé API est absente"
    )
  })

  test.each([
    ["page type Post", { pageType: "post" as ContentType }, ["en", "fr"]],
    ["no English or French site language", {}, ["de"]],
  ])("no key notice for %s", (_case, options, locales) => {
    mocks.data["cms/aiSettings:status"] = status(false)
    mocks.data["cms/settings:getSiteConfig"] = {
      enabledLocales: locales,
      defaultLocale: locales[0],
    }
    renderSlot(options)
    expect(screen.queryByTestId("api-key-notice")).not.toBeInTheDocument()
    expect(writeButton()).not.toBeInTheDocument()
  })

  test("the status read is still loading: nothing shows", () => {
    mocks.data["cms/aiSettings:status"] = undefined
    renderSlot()
    expect(writeButton()).not.toBeInTheDocument()
    expect(screen.queryByTestId("api-key-notice")).not.toBeInTheDocument()
  })
})

describe("module on, Writing ready", () => {
  test("the button shows in the form's row for a Page", () => {
    renderSlot()
    const row = screen.getByTestId("button-row")
    expect(
      [...row.querySelectorAll("button")].map((button) => button.textContent)
    ).toEqual(["Create page", "Write page with AI", "Import .md"])
    expect(writeButton()).toBeEnabled()
  })

  test("French button", () => {
    renderSlot({ language: "fr" })
    expect(
      screen.getByRole("button", { name: "Écrire la page avec l'IA" })
    ).toBeInTheDocument()
  })

  test.each([
    ["another page type", { pageType: "post" as ContentType }, ["en", "fr"]],
    ["no English or French site language", {}, ["de", "es"]],
  ])("no button for %s", (_case, options, locales) => {
    mocks.data["cms/settings:getSiteConfig"] = {
      enabledLocales: locales,
      defaultLocale: locales[0],
    }
    renderSlot(options)
    expect(writeButton()).not.toBeInTheDocument()
  })

  test.each([{ isCreating: true }, { canCreateSelected: false }])(
    "the button is disabled for %o",
    (options) => {
      renderSlot(options)
      expect(writeButton()).toBeDisabled()
    }
  )

  test("a click opens a fresh wizard in the form's language", () => {
    renderSlot({ locale: "fr" })
    fireEvent.click(writeButton()!)
    expect(
      screen.getByRole("dialog", { name: "Write a page with AI" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Language")).toHaveValue("fr")
    fireEvent.change(screen.getByLabelText("Brief"), {
      target: { value: "Draft" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(writeButton()!)
    expect(screen.getByLabelText("Brief")).toHaveValue("")
  })

  test("the wizard closes when Writing stops being ready", async () => {
    const view = renderSlot()
    fireEvent.click(writeButton()!)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    mocks.data["cms/aiSettings:status"] = status(false)
    view.rerender(slot())
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(screen.getByTestId("api-key-notice")).toBeInTheDocument()
  })

  test("Write job cards show above the form, in order; translation jobs do not", () => {
    mocks.data["cms/aiJobs:pageJobProgress"] = [
      job("job-2"),
      job("job-t", { kind: "translation" }),
      job("job-1", { state: "failed" }),
    ]
    renderSlot()
    const cards = screen.getAllByTestId("job-progress")
    expect(cards.map((card) => card.getAttribute("data-job-id"))).toEqual([
      "job-2",
      "job-1",
    ])
    const form = screen.getByRole("form", { name: "New page" })
    expect(
      cards[1]!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test("a running job blocks the wizard; the notice sits under the form and leads to the card", () => {
    mocks.data["cms/aiJobs:pageJobProgress"] = [
      job("job-3", { state: "canceling" }),
    ]
    renderSlot()
    fireEvent.click(writeButton()!)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const notice = screen.getByTestId("one-job")
    expect(notice).toHaveTextContent("A page job is already running.")
    expect(screen.getByTestId("button-row")).not.toContainElement(notice)
    const form = screen.getByRole("form", { name: "New page" })
    expect(
      form.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Open the running job" })
    )
    const card = screen.getByTestId("job-progress")
    expect(card).toHaveFocus()
    expect(card.scrollIntoView).toHaveBeenCalled()
    expect(screen.queryByTestId("one-job")).not.toBeInTheDocument()
  })

  test("a running translation job also blocks the wizard", () => {
    mocks.data["cms/aiJobs:pageJobProgress"] = [
      job("job-t", { kind: "translation", state: "running" }),
    ]
    renderSlot()
    fireEvent.click(writeButton()!)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("one-job")).toHaveTextContent(
      "A page job is already running."
    )
  })

  test("Resume is disabled on a stopped card while another job runs", () => {
    mocks.data["cms/aiJobs:pageJobProgress"] = [
      job("job-2", { state: "running" }),
      job("job-1", { state: "failed" }),
    ]
    renderSlot()
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled()
  })

  test("a failing job read leaves the form usable", () => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.data["cms/aiJobs:pageJobProgress"] = new Error("Server Error")
    renderSlot()
    expect(screen.getByRole("button", { name: "Create page" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Import .md" })).toBeEnabled()
    expect(writeButton()).toBeEnabled()
    expect(screen.queryByTestId("job-progress")).not.toBeInTheDocument()
    signal.mockRestore()
  })

  test("a failing status read leaves the form usable", () => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.data["cms/aiSettings:status"] = new Error("Server Error")
    renderSlot()
    expect(screen.getByRole("button", { name: "Create page" })).toBeEnabled()
    expect(writeButton()).not.toBeInTheDocument()
    signal.mockRestore()
  })
})
