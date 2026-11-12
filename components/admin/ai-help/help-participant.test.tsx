import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../../../messages/admin/en.json"
import fr from "../../../messages/admin/fr.json"
import { AdminCommandPaletteProvider } from "../command-palette"
import type { AdminAiHelpHostResult } from "../contributions/ai-help"
import type { ModuleGate } from "../module-gate"
import { HelpParticipant } from "./help-participant"

const mocks = vi.hoisted(() => ({
  gate: { state: "on" } as ModuleGate,
  data: {} as Record<string, unknown>,
  queryNames: [] as string[],
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  results: [] as unknown[],
  push: vi.fn(),
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => "/admin/pages",
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

const ANSWER = "agents/helpAssistant:answer"
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
    // Writing is ready on purpose: Help reads only its own entry.
    { id: "writing", provider: "openrouter", ready: true, available: true },
    { id: "help", provider: "anthropic", ready, available: true },
  ],
  card: { state: ready ? "active" : "missing" },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function slot(language: "en" | "fr" = "en") {
  return (
    <NextIntlClientProvider
      locale={language}
      messages={language === "fr" ? fr : en}
    >
      <HelpParticipant routeData={null} query="" route="/admin/pages">
        {(result: AdminAiHelpHostResult) => {
          mocks.results.push(result)
          return (
            <>
              <main>Admin page</main>
              {result.command && (
                <button type="button" onClick={() => void result.command!.run()}>
                  {`palette: ${result.command.label}`}
                </button>
              )}
              {result.panel}
            </>
          )
        }}
      </HelpParticipant>
    </NextIntlClientProvider>
  )
}

const lastResult = () => mocks.results.at(-1) as AdminAiHelpHostResult
const openButton = () => screen.queryByRole("button", { name: "Open Help" })
const openCard = () => fireEvent.click(screen.getByRole("button", { name: "Open Help" }))
const openCardFr = () =>
  fireEvent.click(screen.getByRole("button", { name: "Ouvrir l'aide" }))
const card = () => screen.getByTestId("help-floating")
const question = (name: string) => screen.getByRole("button", { name })
const answerCalls = () => mocks.calls[ANSWER]?.mock.calls ?? []

beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate = { state: "on" }
  mocks.queryNames.length = 0
  mocks.results.length = 0
  mocks.calls = {}
  mocks.calls[ANSWER] = vi.fn()
  mocks.data = { "cms/aiSettings:status": status(true) }
  Element.prototype.scrollIntoView = vi.fn()
})

describe("(a) AI module off", () => {
  test.each([{ state: "off" }, { state: "loading" }, { state: "error" }] as ModuleGate[])(
    "$state: no button, no card, no command, and no AI read",
    (gate) => {
      mocks.gate = gate
      render(slot())
      expect(screen.getByText("Admin page")).toBeInTheDocument()
      expect(lastResult()).toEqual({ command: null, panel: null })
      expect(openButton()).not.toBeInTheDocument()
      expect(screen.queryByTestId("help-floating")).not.toBeInTheDocument()
      expect(
        mocks.queryNames.filter(
          (name) => AI_QUERY.test(name) || name === "cms/aiSettings:status"
        )
      ).toEqual([])
    }
  )

  test("a failed status read hides Help and reports the failure", () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const failure = new Error("status read failed")
    mocks.data = { "cms/aiSettings:status": failure }
    render(slot())
    expect(screen.getByText("Admin page")).toBeInTheDocument()
    expect(lastResult()).toEqual({ command: null, panel: null })
    expect(openButton()).not.toBeInTheDocument()
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining("module=ai boundary=admin.contribution"),
      expect.objectContaining({ cause: "status read failed" })
    )
    report.mockRestore()
  })

  test("needs_setup still shows Help (the module is on)", () => {
    mocks.gate = { state: "needs_setup", setup: [] }
    render(slot())
    expect(openButton()).toBeInTheDocument()
    expect(mocks.queryNames).toContain("cms/aiSettings:status")
  })
})

describe("bottom space for the round button", () => {
  test("the launcher wrapper carries the marker the admin <main> rule keys on", () => {
    render(slot())
    const launcher = document.querySelector("[data-help-launcher]")
    expect(launcher).not.toBeNull()
    expect(
      within(launcher as HTMLElement).getByRole("button", { name: "Open Help" })
    ).toBeInTheDocument()
  })

  test("no marker while Help is not rendered", () => {
    mocks.gate = { state: "off" }
    render(slot())
    expect(document.querySelector("[data-help-launcher]")).toBeNull()
  })
})

describe("(g) the round button", () => {
  test("the card starts closed and the button toggles it", () => {
    render(slot())
    expect(screen.queryByTestId("help-floating")).not.toBeInTheDocument()
    openCard()
    expect(card()).toBeInTheDocument()
    expect(within(card()).getByRole("heading", { name: "Help" })).toBeInTheDocument()
    const toggles = screen.getAllByRole("button", { name: "Close Help" })
    // The header close button and the round button.
    expect(toggles).toHaveLength(2)
    fireEvent.click(toggles[1]!)
    expect(screen.queryByTestId("help-floating")).not.toBeInTheDocument()
    expect(openButton()).toBeInTheDocument()
  })
})

describe("(b) Help not ready", () => {
  test("missing connection: notice in place of the form, questions disabled, no call", () => {
    mocks.data["cms/aiSettings:status"] = status(false)
    render(slot())
    openCard()
    const notice = screen.getByTestId("help-finish-setup")
    expect(notice).toHaveTextContent(
      "Help is not set up yet: its connection is missing."
    )
    expect(within(notice).getByRole("link", { name: "Finish setup" })).toHaveAttribute(
      "href",
      "/admin/settings/ai"
    )
    expect(screen.queryByRole("textbox", { name: "Your question" })).not.toBeInTheDocument()
    const ask = question("How do I add French to my site?")
    expect(ask).toBeDisabled()
    fireEvent.click(ask)
    expect(answerCalls()).toHaveLength(0)
  })

  test("refused key: the refused notice names the provider and its variable", () => {
    mocks.data["cms/aiSettings:status"] = status(false, "refused")
    render(slot())
    openCard()
    expect(screen.getByTestId("help-finish-setup")).toHaveTextContent(
      "Key refused: Anthropic rejected ANTHROPIC_API_KEY Finish setup"
    )
  })

  test("while the status loads: no notice, Send and the questions disabled", () => {
    mocks.data["cms/aiSettings:status"] = undefined
    render(slot())
    openCard()
    expect(screen.queryByTestId("help-finish-setup")).not.toBeInTheDocument()
    expect(question("How do I publish a page?")).toBeDisabled()
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
      target: { value: "Hello" },
    })
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })
})

describe("Help ready", () => {
  test("(c)(d)(f) one question is exactly one call; loading row, answer, link", async () => {
    const reply = deferred<unknown>()
    mocks.calls[ANSWER]!.mockReturnValue(reply.promise)
    render(slot())
    openCard()
    expect(
      screen.getByText(
        "Ask how something works. I answer and point you to the right screen. I never change your site."
      )
    ).toBeInTheDocument()
    fireEvent.click(question("How do I add French to my site?"))

    expect(answerCalls()).toEqual([
      [{ question: "How do I add French to my site?", route: "/admin/pages" }],
    ])
    // (d) the intro and the suggested questions are gone after the first question.
    expect(screen.queryByText(/Ask how something works/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "How do I publish a page?" })).not.toBeInTheDocument()
    // (c) loading row; Send stays disabled even with a draft.
    expect(screen.getByTestId("help-loading")).toHaveTextContent("Looking for the answer…")
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
      target: { value: "And then?" },
    })
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    // (f) no link before the answer is finished.
    expect(screen.queryByRole("button", { name: /Settings › Languages/ })).not.toBeInTheDocument()

    await act(async () => {
      reply.resolve({
        answer: "Open Settings, then Languages.",
        sources: ["languages"],
        suggestedAction: {
          id: "open-settings-languages",
          label: "Open Languages settings",
          href: "/admin/settings/languages",
        },
      })
    })
    expect(screen.queryByTestId("help-loading")).not.toBeInTheDocument()
    expect(screen.getByText("Open Settings, then Languages.")).toBeInTheDocument()
    expect(screen.queryByText("Open Languages settings")).not.toBeInTheDocument()
    expect(screen.queryByText(/languages$/)).not.toBeInTheDocument()
    const link = screen.getByRole("button", { name: "Settings › Languages" })
    fireEvent.click(link)
    expect(mocks.push).toHaveBeenCalledWith("/admin/settings/languages")
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
    expect(answerCalls()).toHaveLength(1)
  })

  test("a typed question is trimmed, sent once, and the draft clears", async () => {
    mocks.calls[ANSWER]!.mockResolvedValue({ answer: "Use Publish.", sources: [] })
    render(slot())
    openCard()
    const input = screen.getByRole("textbox", { name: "Your question" })
    fireEvent.change(input, { target: { value: "  How do I publish?  " } })
    const send = screen.getByRole("button", { name: "Send" })
    await act(async () => {
      fireEvent.click(send)
      fireEvent.click(send)
    })
    expect(answerCalls()).toEqual([
      [{ question: "How do I publish?", route: "/admin/pages" }],
    ])
    expect(input).toHaveValue("")
    expect(screen.getByText("Use Publish.")).toBeInTheDocument()
    // (f) an answer without a link shows no link button.
    expect(
      within(screen.getByTestId("help-answer")).queryAllByRole("button")
    ).toHaveLength(0)
  })

  test("an empty or over-long question cannot be sent", () => {
    render(slot())
    openCard()
    const input = screen.getByRole("textbox", { name: "Your question" })
    const send = screen.getByRole("button", { name: "Send" })
    fireEvent.change(input, { target: { value: "   " } })
    expect(send).toBeDisabled()
    fireEvent.change(input, { target: { value: "x".repeat(2_001) } })
    expect(send).toBeDisabled()
    fireEvent.submit(input.closest("form")!)
    fireEvent.change(input, { target: { value: "x".repeat(2_000) } })
    expect(send).toBeEnabled()
    expect(answerCalls()).toHaveLength(0)
  })

  test("an answer keeps its line breaks", async () => {
    const text = "1. Open Pages.\n2. Choose New page."
    mocks.calls[ANSWER]!.mockResolvedValue({ answer: text, sources: [] })
    render(slot())
    openCard()
    await act(async () => {
      fireEvent.click(question("How do I publish a page?"))
    })
    const paragraph = within(screen.getByTestId("help-answer")).getByText(
      (_content, element) =>
        element?.tagName === "P" && element.textContent === text
    )
    expect(paragraph).toHaveClass("whitespace-pre-wrap")
    expect(paragraph.textContent).toContain("\n")
  })

  test("an unknown link id shows the answer without a link", async () => {
    mocks.calls[ANSWER]!.mockResolvedValue({
      answer: "Here.",
      sources: [],
      suggestedAction: { id: "open-billing", label: "Billing", href: "/admin/billing" },
    })
    render(slot())
    openCard()
    await act(async () => {
      fireEvent.click(question("How do I publish a page?"))
    })
    expect(screen.getByText("Here.")).toBeInTheDocument()
    expect(
      within(screen.getByTestId("help-answer")).queryAllByRole("button")
    ).toHaveLength(0)
  })

  test.each([
    ["create-page", "Content › New page", "/admin/pages/new"],
    ["open-pages", "Content", "/admin/pages"],
    ["open-settings", "Settings › General", "/admin/settings"],
    ["open-settings-ai", "Settings › AI", "/admin/settings/ai"],
  ])("link %s reads %s", async (id, label, href) => {
    mocks.calls[ANSWER]!.mockResolvedValue({
      answer: "Here.",
      sources: [],
      suggestedAction: { id, label: "server label", href },
    })
    render(slot())
    openCard()
    await act(async () => {
      fireEvent.click(question("How do I publish a page?"))
    })
    fireEvent.click(screen.getByRole("button", { name: label }))
    expect(mocks.push).toHaveBeenCalledWith(href)
  })

  test("closing the card keeps the conversation", async () => {
    mocks.calls[ANSWER]!.mockResolvedValue({ answer: "Kept.", sources: [] })
    render(slot())
    openCard()
    await act(async () => {
      fireEvent.click(question("How do I publish a page?"))
    })
    fireEvent.click(screen.getAllByRole("button", { name: "Close Help" })[0]!)
    openCard()
    expect(screen.getByText("Kept.")).toBeInTheDocument()
  })
})

describe("a failed answer", () => {
  test.each([
    [
      "unreachable",
      new ConvexError({ category: "PROVIDER_UNAVAILABLE", message: "raw detail" }),
      "Couldn't reach Anthropic. Ask again in a moment.",
    ],
    [
      "busy",
      new ConvexError({ category: "RATE_LIMITED", message: "raw detail" }),
      "Too many questions in a short time. Wait a moment and ask again.",
    ],
    [
      "rate limiter",
      new ConvexError({ kind: "RateLimited", name: "aiCallPerUser", retryAfter: 5 }),
      "Too many questions in a short time. Wait a moment and ask again.",
    ],
    [
      "refused",
      new ConvexError({ category: "AUTH_REQUIRED", message: "raw detail" }),
      "Key refused: Anthropic rejected ANTHROPIC_API_KEY Finish setup",
    ],
    [
      "missing",
      new ConvexError({ category: "CONFIG_MISSING", message: "raw detail" }),
      "Help is not set up yet: its connection is missing. Finish setup",
    ],
    [
      "other",
      new Error("raw detail"),
      "Help could not answer this time. Ask again.",
    ],
  ])("%s: its notice in the answer slot; the form still works", async (_kind, error, text) => {
    mocks.calls[ANSWER]!.mockRejectedValueOnce(error)
    mocks.calls[ANSWER]!.mockResolvedValueOnce({ answer: "Second try.", sources: [] })
    render(slot())
    openCard()
    await act(async () => {
      fireEvent.click(question("How do I publish a page?"))
    })
    const answer = screen.getByTestId("help-answer")
    expect(within(answer).getByTestId("help-error")).toHaveTextContent(text)
    expect(screen.queryByText(/raw detail/)).not.toBeInTheDocument()

    const input = screen.getByRole("textbox", { name: "Your question" })
    fireEvent.change(input, { target: { value: "Again?" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }))
    })
    expect(answerCalls()).toHaveLength(2)
    expect(screen.getByText("Second try.")).toBeInTheDocument()
  })
})

describe("(e) admin language", () => {
  test("a change of admin language starts a new conversation", async () => {
    mocks.calls[ANSWER]!.mockResolvedValue({ answer: "English answer.", sources: [] })
    const view = render(slot("en"))
    openCard()
    await act(async () => {
      fireEvent.click(question("How do I publish a page?"))
    })
    expect(screen.getByText("English answer.")).toBeInTheDocument()
    view.rerender(slot("fr"))
    expect(screen.queryByText("English answer.")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Aide" })).toBeInTheDocument()
    expect(question("Comment publier une page ?")).toBeEnabled()
    expect(
      screen.getByText(
        "Demandez comment une chose fonctionne. Je réponds et je vous indique le bon écran. Je ne modifie jamais votre site."
      )
    ).toBeInTheDocument()
  })
})

describe("palette command", () => {
  test("ready: present in the AI section and it opens the card", () => {
    render(slot())
    const command = lastResult().command!
    expect(command).toMatchObject({ label: "Ask AI Help", section: "AI" })
    expect(command.description).toBeUndefined()
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "palette: Ask AI Help" }))
    })
    expect(card()).toBeInTheDocument()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  test("not ready: Finish setup in its description, and it opens Settings › AI", () => {
    mocks.data["cms/aiSettings:status"] = status(false)
    render(slot())
    expect(lastResult().command).toMatchObject({
      label: "Ask AI Help",
      description: "Finish setup",
    })
    fireEvent.click(screen.getByRole("button", { name: "palette: Ask AI Help" }))
    expect(mocks.push).toHaveBeenCalledWith("/admin/settings/ai")
    expect(screen.queryByTestId("help-floating")).not.toBeInTheDocument()
  })

  test("the French placeholder is short enough for the card", () => {
    render(slot("fr"))
    openCardFr()
    expect(
      screen.getByRole("textbox", { name: "Votre question" })
    ).toHaveAttribute("placeholder", "Posez votre question…")
  })

  test("French labels", () => {
    render(slot("fr"))
    expect(lastResult().command).toMatchObject({
      label: "Demander à l'aide IA",
      section: "IA",
    })
  })
})

describe("the real palette host", () => {
  const owner = { ownerId: "o", authId: "o", email: "o@example.com", role: "admin" }
  function palette() {
    return (
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminCommandPaletteProvider aiHelpRouteData={null}>
          <div>Child</div>
        </AdminCommandPaletteProvider>
      </NextIntlClientProvider>
    )
  }
  beforeEach(() => {
    mocks.data["cms/owner:getOwnerSession"] = owner
    mocks.data["cms/contentTypes:getArchivedContentTypes"] = []
    mocks.data["cms/pages:listSummaries"] = []
  })

  test("lists Ask AI Help with an empty query and runs it", () => {
    render(palette())
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const row = screen.getByRole("button", { name: /Ask AI Help/ })
    fireEvent.click(row)
    return vi.waitFor(() => expect(card()).toBeInTheDocument())
  })

  test("scores it like any command", () => {
    render(palette())
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const search = screen.getByRole("textbox", { name: "Search commands" })
    fireEvent.change(search, { target: { value: "ask" } })
    expect(screen.getByRole("button", { name: /Ask AI Help/ })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: "media" } })
    expect(screen.queryByRole("button", { name: /Ask AI Help/ })).not.toBeInTheDocument()
  })

  test("not ready: the row shows Finish setup", () => {
    mocks.data["cms/aiSettings:status"] = status(false)
    render(palette())
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    expect(screen.getByRole("button", { name: /Ask AI Help/ })).toHaveTextContent(
      "Ask AI HelpFinish setup"
    )
  })

  test("module off: no row and no floating button", () => {
    mocks.gate = { state: "off" }
    render(palette())
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    expect(screen.queryByRole("button", { name: /Ask AI Help/ })).not.toBeInTheDocument()
    expect(openButton()).not.toBeInTheDocument()
    expect(mocks.queryNames).not.toContain("cms/aiSettings:status")
  })
})
