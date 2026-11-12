import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../../../messages/admin/en.json"
import fr from "../../../messages/admin/fr.json"
import type { ModuleGate } from "../module-gate"
import { PageWizard, type WriteLocale } from "./page-wizard"

const mocks = vi.hoisted(() => ({
  gate: { state: "on" } as ModuleGate,
  data: {} as Record<string, unknown>,
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  push: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  confirm: vi.fn(),
}))

const fn = (name: string) => (mocks.calls[name] ??= vi.fn())

vi.mock("convex/react", () => {
  const callable = (reference: unknown) => {
    const name = getFunctionName(reference as never)
    return (mocks.calls[name] ??= vi.fn())
  }
  return {
    useQueries: (request: Record<string, { query: unknown }>) =>
      Object.fromEntries(
        Object.entries(request).map(([key, { query }]) => [
          key,
          mocks.data[getFunctionName(query as never)],
        ])
      ),
    useQuery: (reference: unknown) =>
      mocks.data[getFunctionName(reference as never)],
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

const READY_STATUS = {
  connections: [
    { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", state: "connected" },
  ],
  assistants: [
    { id: "writing", provider: "anthropic", ready: true, available: true },
  ],
  card: { state: "active" },
}
const OUTLINE = {
  title: "About us",
  slug: "about-us",
  metaTitle: "About Northwind Studio",
  metaDescription: "Who we are.",
  outline: [
    { type: "features-icon-grid", purpose: "Open with who we are" },
    { type: "faq-simple", purpose: "Answer common questions" },
  ],
}
const runningJob = (jobId: string) => ({
  jobId,
  kind: "write",
  title: "About us",
  locale: "en",
  state: "running",
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
      purpose: "Open with who we are",
      state: "inProgress",
      reused: false,
      costMicros: 0,
    },
    {
      index: 1,
      kind: "write",
      purpose: "Answer common questions",
      state: "waiting",
      reused: false,
      costMicros: 0,
    },
  ],
})

function renderWizard(
  options: {
    locale?: "en" | "fr"
    languages?: WriteLocale[]
    initialLocale?: WriteLocale
    onOpenChange?: (open: boolean) => void
  } = {}
) {
  const locale = options.locale ?? "en"
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <PageWizard
        open
        onOpenChange={options.onOpenChange ?? vi.fn()}
        languages={options.languages ?? ["en", "fr"]}
        initialLocale={options.initialLocale ?? "en"}
        defaultLocale="en"
      />
    </NextIntlClientProvider>
  )
}

async function planPage(brief = "  A page about the studio.  ") {
  fireEvent.change(screen.getByLabelText("Brief"), { target: { value: brief } })
  fireEvent.click(screen.getByRole("button", { name: "Plan the page" }))
  await screen.findByLabelText("Page title")
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate = { state: "on" }
  mocks.calls = {}
  mocks.data = {
    "cms/aiSettings:status": READY_STATUS,
    "cms/aiJobs:pageJobProgress": [],
    "cms/agents:getContentPresets": {
      writeBriefs: [],
      refinePresets: [],
      pageBriefs: [],
    },
    "cms/settings:getSettings": { brandVoice: "Warm and direct." },
  }
  fn("agents/contentWriter:generatePageOutline").mockResolvedValue(OUTLINE)
})

describe("brief step", () => {
  test("shows the prototype's brief step with the job's languages", () => {
    renderWizard({ initialLocale: "fr" })
    const dialog = screen.getByRole("dialog", { name: "Write a page with AI" })
    expect(dialog).toHaveAccessibleDescription(
      "Describe the page; the agent will plan a structure and write a draft you can edit before saving."
    )
    expect(screen.getByLabelText("Brief")).toHaveAttribute(
      "placeholder",
      "What’s this page about? Who’s it for? What’s the action you want a visitor to take?"
    )
    expect(
      screen.getByText(
        "One to three sentences works best. The model will propose a structure you can edit before any copy is written."
      )
    ).toBeInTheDocument()
    const language = screen.getByLabelText("Language")
    expect(language).toHaveValue("fr")
    expect(
      within(language)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["English (default)", "français"])
    expect(screen.getByText("Warm and direct.")).toBeInTheDocument()
    expect(screen.queryByTestId("starting-brief")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Plan the page" })).toBeDisabled()
  })

  test("offers starting briefs only when presets exist, and the empty brand voice text", () => {
    mocks.data["cms/agents:getContentPresets"] = {
      writeBriefs: [],
      refinePresets: [],
      pageBriefs: [{ label: "Services", body: "A page about our services." }],
    }
    mocks.data["cms/settings:getSettings"] = { brandVoice: "" }
    renderWizard()
    expect(
      screen.getByRole("button", { name: "Use a starting brief…" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "No brand voice configured. The agent will default to a neutral, professional tone."
      )
    ).toBeInTheDocument()
  })

  test("a refused presets read only hides the picker", () => {
    mocks.data["cms/agents:getContentPresets"] = new Error(
      "CMS_MODULE_NOT_READY"
    )
    renderWizard()
    expect(screen.queryByTestId("starting-brief")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Brief")).toBeInTheDocument()
  })

  test("plans with the trimmed brief and the chosen language", async () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "fr" },
    })
    await planPage()
    expect(fn("agents/contentWriter:generatePageOutline")).toHaveBeenCalledWith(
      {
        brief: "A page about the studio.",
        locale: "fr",
      }
    )
    expect(screen.getByLabelText("Page title")).toHaveValue("About us")
    expect(screen.getByLabelText("URL identifier")).toHaveValue("about-us")
    expect(screen.getByLabelText("Meta title")).toHaveValue(
      "About Northwind Studio"
    )
    expect(screen.getByLabelText("Meta description")).toHaveValue("Who we are.")
    expect(
      screen
        .getAllByRole("textbox", { name: "Section purpose" })
        .map((box) => (box as HTMLTextAreaElement).value)
    ).toEqual(["Open with who we are", "Answer common questions"])
  })

  test("a failed plan shows the translated fallback, never the server message", async () => {
    fn("agents/contentWriter:generatePageOutline").mockRejectedValue(
      new Error("Anthropic said: overloaded")
    )
    renderWizard()
    fireEvent.change(screen.getByLabelText("Brief"), {
      target: { value: "About" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Plan the page" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Planning failed"
    )
    expect(screen.queryByText(/overloaded/)).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Try planning again" })
    ).toBeEnabled()
  })

  test("Cancel closes the dialog", () => {
    const onOpenChange = vi.fn()
    renderWizard({ onOpenChange })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("outline step", () => {
  test("Start sends the exact input shape", async () => {
    fn("cms/aiJobs:startPageJob").mockResolvedValue("job-7")
    renderWizard()
    await planPage()
    fireEvent.change(screen.getByLabelText("URL identifier"), {
      target: { value: "studio" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    await waitFor(() =>
      expect(fn("cms/aiJobs:startPageJob")).toHaveBeenCalledTimes(1)
    )
    expect(fn("cms/aiJobs:startPageJob")).toHaveBeenCalledWith({
      input: {
        kind: "write",
        brief: "A page about the studio.",
        locale: "en",
        meta: {
          title: "About us",
          slug: "studio",
          metaTitle: "About Northwind Studio",
          metaDescription: "Who we are.",
        },
        rows: [
          { sliceType: "features-icon-grid", purpose: "Open with who we are" },
          { sliceType: "faq-simple", purpose: "Answer common questions" },
        ],
      },
    })
  })

  test("after Start the running view shows that job's card; closing cancels nothing", async () => {
    fn("cms/aiJobs:startPageJob").mockResolvedValue("job-7")
    const onOpenChange = vi.fn()
    renderWizard({ onOpenChange })
    await planPage()
    mocks.data["cms/aiJobs:pageJobProgress"] = [runningJob("job-7")]
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    const card = await screen.findByTestId("job-progress")
    expect(card).toHaveAttribute("data-job-id", "job-7")
    expect(within(card).getByRole("status")).toHaveTextContent("Running")
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(fn("cms/aiJobs:cancelPageJob")).not.toHaveBeenCalled()
    expect(fn("cms/aiJobs:dismissPageJob")).not.toHaveBeenCalled()
  })

  test("AI_JOB_ALREADY_ACTIVE shows the running-job notice and keeps the outline", async () => {
    fn("cms/aiJobs:startPageJob").mockRejectedValue(
      new ConvexError("AI_JOB_ALREADY_ACTIVE")
    )
    renderWizard()
    await planPage()
    mocks.data["cms/aiJobs:pageJobProgress"] = [runningJob("job-1")]
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(
      await screen.findByText("A page job is already running.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Open the running job" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Page title")).toHaveValue("About us")
  })

  test("another start failure keeps the outline and shows the translated line", async () => {
    fn("cms/aiJobs:startPageJob").mockRejectedValue(new Error("Server Error"))
    renderWizard()
    await planPage()
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The job could not start. Try again."
    )
    expect(screen.getByLabelText("Page title")).toHaveValue("About us")
    expect(
      screen.getAllByRole("textbox", { name: "Section purpose" })
    ).toHaveLength(2)
  })

  test("a mapped error keeps its existing copy", async () => {
    fn("cms/aiJobs:startPageJob").mockRejectedValue(
      new ConvexError("SLUG_TAKEN")
    )
    renderWizard()
    await planPage()
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This address is already used. Choose another."
    )
  })

  test("Start needs a row and no blank purpose; Add section stops at 8", async () => {
    renderWizard()
    await planPage()
    const start = screen.getByRole("button", { name: "Start" })
    expect(start).toBeEnabled()
    fireEvent.change(
      screen.getAllByRole("textbox", { name: "Section purpose" })[1]!,
      {
        target: { value: "   " },
      }
    )
    expect(start).toBeDisabled()
    for (const remove of screen.getAllByRole("button", {
      name: "Remove section",
    }))
      fireEvent.click(remove)
    expect(
      screen.getByText("No sections — add one below to write something.")
    ).toBeInTheDocument()
    expect(start).toBeDisabled()
    const add = screen.getByRole("button", { name: "Add section" })
    for (let i = 0; i < 8; i++) fireEvent.click(add)
    expect(
      screen.getAllByRole("textbox", { name: "Section purpose" })
    ).toHaveLength(8)
    expect(add).toBeDisabled()
  })

  test("Start waits for a page title; the brief and purposes keep the server limits", async () => {
    fn("agents/contentWriter:generatePageOutline").mockResolvedValue({
      ...OUTLINE,
      outline: [{ type: "faq-simple", purpose: "x".repeat(600) }],
    })
    renderWizard()
    expect(screen.getByLabelText("Brief")).toHaveAttribute("maxLength", "2000")
    await planPage()
    const purpose = screen.getByRole("textbox", { name: "Section purpose" })
    expect(purpose).toHaveValue("x".repeat(500))
    expect(purpose).toHaveAttribute("maxLength", "500")
    const start = screen.getByRole("button", { name: "Start" })
    expect(start).toBeEnabled()
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "  " } })
    expect(start).toBeDisabled()
  })

  test("Back returns to the brief with the brief kept", async () => {
    renderWizard()
    await planPage("Studio page")
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByLabelText("Brief")).toHaveValue("Studio page")
  })
})

describe("languages and copy", () => {
  test("French wizard uses the prototype's texts", async () => {
    renderWizard({ locale: "fr" })
    expect(
      screen.getByRole("dialog", { name: "Écrire une page avec l’IA" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Langue")).toBeInTheDocument()
    expect(
      screen.getByText("Voix de marque (définie dans Paramètres › Général)")
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Brief"), {
      target: { value: "Studio" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Planifier la page" }))
    expect(await screen.findByLabelText("Identifiant d’URL")).toHaveValue(
      "about-us"
    )
    expect(
      screen.getByLabelText("Titre pour les moteurs de recherche")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Ajouter une section" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Démarrer" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Retour" })).toBeInTheDocument()
  })

  test.each(["en", "fr"] as const)(
    "shows no cost word in %s",
    async (locale) => {
      renderWizard({ locale })
      const scan = () =>
        expect(document.body.textContent).not.toMatch(
          /\$|estimat|\bcap\b|reserved|r[ée]serv[ée]|co[uû]t|limite|cost|charge|frais/i
        )
      scan()
      fireEvent.change(screen.getByLabelText("Brief"), {
        target: { value: "Studio" },
      })
      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "fr" ? "Planifier la page" : "Plan the page",
        })
      )
      await screen.findByLabelText(
        locale === "fr" ? "Titre de la page" : "Page title"
      )
      scan()
    }
  )
})
