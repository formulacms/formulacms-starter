import { fireEvent, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { MODULE_PARTICIPATION_FAILED } from "@/lib/modules/containment"
import { render } from "@/test-utils/admin-i18n"

// M01c-P5, client half (recovery design B5): the real Redirects route. A Convex
// hook call counts as a mounted reader or bound mutation.

const mocks = vi.hoisted(() => ({
  calls: [] as { hook: string; name: string; args: unknown }[],
  status: undefined as unknown,
  replace: vi.fn(),
  reload: vi.fn(),
  listFailure: null as unknown,
  mutationFailures: new Map<string, unknown>(),
  mutationCalls: [] as { name: string; args: unknown }[],
  redirects: [] as {
    _id: string
    fromPath: string
    toLabel: string
    toPageId?: string
    toPageTitle?: string
    locale: string
    statusCode: number
  }[],
}))

vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.calls.push({ hook: "useQuery", name, args })
    if (name === "cms/pages:getAllLocalizedPageUrls") return []
    if (name === "cms/pages:listSummaries") return []
    if (name === "cms/settings:getSiteConfig") {
      return { defaultLocale: "en", enabledLocales: ["en"] }
    }
    return undefined
  },
  usePaginatedQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.calls.push({ hook: "usePaginatedQuery", name, args })
    if (mocks.listFailure) throw mocks.listFailure
    return { loadMore: vi.fn(), results: mocks.redirects, status: "Exhausted" }
  },
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.calls.push({ hook: "useMutation", name, args: undefined })
    return vi.fn(async (args: unknown) => {
      mocks.mutationCalls.push({ name, args })
      const failure = mocks.mutationFailures.get(name)
      if (failure) throw failure
    })
  },
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))
vi.mock("@/components/admin/admin-module-state-provider", () => ({
  useModuleGate: () => ({
    state:
      mocks.status === undefined
        ? "loading"
        : mocks.status instanceof Error
          ? "error"
          : (mocks.status as { enabled: boolean }).enabled
            ? "on"
            : "off",
  }),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("@/components/admin/optional-module-route", async (original) => {
  const actual =
    await original<typeof import("@/components/admin/optional-module-route")>()
  return {
    ...actual,
    OptionalModuleRoute: (
      props: Parameters<typeof actual.OptionalModuleRoute>[0]
    ) => <actual.OptionalModuleRoute {...props} reloadPage={mocks.reload} />,
  }
})

import RedirectsPage from "./page"

function renderInShell(locale: "en" | "fr" = "en") {
  return render(shellElement(), { locale })
}

function shellElement() {
  return (
    <div>
      <nav aria-label="Admin shell">Shell</nav>
      <main>
        <RedirectsPage />
      </main>
    </div>
  )
}

function submitCreate(fromPath = "/retired", locale: "en" | "fr" = "en") {
  const french = locale === "fr"
  fireEvent.click(
    screen.getByRole("button", {
      name: french ? "Ajouter une redirection" : "Add redirect",
    })
  )
  fireEvent.mouseDown(
    screen.getByRole("tab", {
      name: french ? "Chemin personnalisé" : "Custom path",
    }),
    {
      button: 0,
      ctrlKey: false,
    }
  )
  fireEvent.change(
    screen.getByPlaceholderText(french ? "/ancienne-page" : "/old-page"),
    {
      target: { value: fromPath },
    }
  )
  fireEvent.mouseDown(
    screen.getByRole("tab", { name: french ? "URL externe" : "External URL" }),
    {
      button: 0,
      ctrlKey: false,
    }
  )
  fireEvent.change(
    screen.getByPlaceholderText(
      french
        ? "https://exemple.com ou /destination"
        : "https://example.com or /landing"
    ),
    { target: { value: "/replacement" } }
  )
  fireEvent.click(
    screen.getByRole("button", { name: french ? "Créer" : "Create" })
  )
}

function submitRemove() {
  fireEvent.click(
    screen.getByRole("button", { name: "Delete redirect /retired" })
  )
}

function managerCalls() {
  return mocks.calls
}

describe("admin Redirects route (M01c)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  function signals() {
    return consoleError.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes(MODULE_PARTICIPATION_FAILED)
    )
  }

  beforeEach(() => {
    mocks.replace.mockClear()
    mocks.reload.mockClear()
    vi.mocked(toast.info).mockClear()
    mocks.calls.length = 0
    mocks.status = undefined
    mocks.listFailure = null
    mocks.mutationFailures.clear()
    mocks.mutationCalls.length = 0
    mocks.redirects = []
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
    vi.spyOn(window, "confirm").mockReturnValue(true)
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
    vi.restoreAllMocks()
  })

  test("P5: while off it shows the plain-language off state and mounts no Redirects reader or mutation", () => {
    mocks.status = { enabled: false }

    renderInShell()

    expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules")
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      "Redirects is not enabled. You can enable it here."
    )
    expect(managerCalls()).toEqual([])
    expect(signals()).toEqual([])
  })

  test("renders the owner-gated off state in French", () => {
    mocks.status = { enabled: false }

    renderInShell("fr")

    expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules")
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      "Le module Redirections n’est pas activé. Vous pouvez l’activer ici."
    )
    expect(managerCalls()).toEqual([])
  })

  test.each([
    ["a ConvexError", new ConvexError("CMS_MODULE_DISABLED")],
    [
      "a server error message",
      new Error(
        "[CONVEX Q(cms/redirects:listPaginated)] Server Error\nUncaught ConvexError: CMS_MODULE_DISABLED"
      ),
    ],
  ])(
    "P5: CMS_MODULE_DISABLED arriving in a race (%s) renders the off state, not an error",
    (_name, failure) => {
      mocks.status = { enabled: true }
      mocks.listFailure = failure

      renderInShell()

      expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules")
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(
        document.querySelector('[aria-label="Admin shell"]')
      ).toBeInTheDocument()
      expect(signals()).toEqual([])
    }
  )

  test.each([
    ["ConvexError data", new ConvexError("CMS_MODULE_DISABLED")],
    [
      "server-shaped error",
      new Error(
        "[CONVEX M(cms/redirects:create)] Server Error\nUncaught ConvexError: CMS_MODULE_DISABLED"
      ),
    ],
  ])(
    "P5: a create disabled race (%s) unmounts the manager without a toast or signal",
    async (_name, failure) => {
      mocks.status = { enabled: true }
      mocks.mutationFailures.set("cms/redirects:create", failure)
      const view = renderInShell()

      submitCreate()

      await waitFor(() =>
        expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules")
      )
      expect(toast.info).toHaveBeenCalledOnce()
      expect(
        screen.queryByRole("button", { name: "Add redirect" })
      ).not.toBeInTheDocument()
      expect(toast.error).not.toHaveBeenCalled()
      expect(signals()).toEqual([])

      mocks.status = { enabled: false }
      view.rerender(shellElement())
      mocks.status = { enabled: true }
      view.rerender(shellElement())
      expect(
        screen.getByRole("button", { name: "Add redirect" })
      ).toBeInTheDocument()
    }
  )

  test.each([
    ["ConvexError data", new ConvexError("CMS_MODULE_DISABLED")],
    [
      "server-shaped error",
      new Error(
        "[CONVEX M(cms/redirects:remove)] Server Error\nUncaught ConvexError: CMS_MODULE_DISABLED"
      ),
    ],
  ])(
    "P5: a remove disabled race (%s) unmounts the manager without a toast or signal",
    async (_name, failure) => {
      mocks.status = { enabled: true }
      mocks.redirects = [
        {
          _id: "redirect-1",
          fromPath: "/retired",
          toLabel: "/replacement",
          locale: "en",
          statusCode: 301,
        },
      ]
      mocks.mutationFailures.set("cms/redirects:remove", failure)
      renderInShell()

      submitRemove()

      await waitFor(() =>
        expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules")
      )
      expect(toast.info).toHaveBeenCalledOnce()
      expect(
        screen.queryByRole("button", { name: "Delete redirect /retired" })
      ).not.toBeInTheDocument()
      expect(toast.error).not.toHaveBeenCalled()
      expect(signals()).toEqual([])
    }
  )

  test.each([
    ["create", "cms/redirects:create", submitCreate],
    ["remove", "cms/redirects:remove", submitRemove],
  ])(
    "P5: an ordinary %s mutation failure keeps the actionable toast path",
    async (_operation, functionName, submit) => {
      mocks.status = { enabled: true }
      mocks.redirects = [
        {
          _id: "redirect-1",
          fromPath: "/retired",
          toLabel: "/replacement",
          locale: "en",
          statusCode: 301,
        },
      ]
      mocks.mutationFailures.set(functionName, new Error("network lost"))
      renderInShell()

      submit()

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Something went wrong")
      )
      expect(toast.error).not.toHaveBeenCalledWith("network lost")
      expect(
        screen.queryByText("Redirects is turned off")
      ).not.toBeInTheDocument()
      expect(
        document.querySelector('[aria-label="Admin shell"]')
      ).toBeInTheDocument()
      expect(signals()).toEqual([])
    }
  )

  test("P5: an ordinary duplicate-path create error containing the disabled code keeps the actionable toast path", async () => {
    mocks.status = { enabled: true }
    const duplicateMessage =
      "A redirect from /CMS_MODULE_DISABLED already exists"
    mocks.mutationFailures.set(
      "cms/redirects:create",
      new ConvexError(duplicateMessage)
    )
    renderInShell()

    submitCreate("/CMS_MODULE_DISABLED")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Something went wrong")
    )
    expect(toast.error).not.toHaveBeenCalledWith(duplicateMessage)
    expect(mocks.mutationCalls).toContainEqual({
      name: "cms/redirects:create",
      args: expect.objectContaining({ fromPath: "/CMS_MODULE_DISABLED" }),
    })
    expect(
      screen.queryByText("Redirects is turned off")
    ).not.toBeInTheDocument()
    expect(
      document.querySelector('[aria-label="Admin shell"]')
    ).toBeInTheDocument()
    expect(signals()).toEqual([])
  })

  test.each([
    [
      "REDIRECT_EXISTS",
      "Une redirection existe déjà pour cette source et cette langue.",
    ],
    ["UNKNOWN_REDIRECT_FAILURE", "Une erreur est survenue"],
  ])(
    "French create maps structured %s without leaking diagnostics or changing module state",
    async (code, expected) => {
      const diagnostic = "English redirect diagnostic with internal details"
      mocks.status = { enabled: true }
      mocks.mutationFailures.set(
        "cms/redirects:create",
        new ConvexError({ code, message: diagnostic })
      )
      renderInShell("fr")
      submitCreate("/CMS_MODULE_DISABLED", "fr")
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected))
      expect(toast.error).not.toHaveBeenCalledWith(diagnostic)
      expect(mocks.mutationCalls).toContainEqual({
        name: "cms/redirects:create",
        args: expect.objectContaining({ fromPath: "/CMS_MODULE_DISABLED" }),
      })
      expect(
        screen.queryByText("Les redirections sont désactivées")
      ).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Créer" })).toBeEnabled()
      expect(
        document.querySelector('[aria-label="Admin shell"]')
      ).toBeInTheDocument()
      expect(signals()).toEqual([])
    }
  )

  test("P5: a failing status read is contained with the shell still rendered", () => {
    mocks.status = new Error("Uncaught ConvexError: CMS_MODULE_STATE_INVALID")

    renderInShell()

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Redirects couldn’t load"
    )
    expect(
      screen.queryByText("Redirects is turned off")
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("navigation", { name: "Admin shell" })
    ).toBeInTheDocument()
    expect(managerCalls()).toEqual([])
    expect(signals()).toEqual([
      [
        `[${MODULE_PARTICIPATION_FAILED}] module=redirects boundary=admin.route`,
        expect.objectContaining({
          moduleId: "redirects",
          boundary: "admin.route",
        }),
      ],
    ])
  })

  test("P5: any other reader error while on is contained with the shell still rendered", () => {
    mocks.status = { enabled: true }
    mocks.listFailure = new Error("network lost")

    renderInShell()

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Redirects couldn’t load"
    )
    expect(
      screen.getByRole("navigation", { name: "Admin shell" })
    ).toBeInTheDocument()
    expect(signals()).toHaveLength(1)
  })

  test("P5: while on the route mounts its Redirects readers and mutations", () => {
    mocks.status = { enabled: true }

    renderInShell()

    expect(
      screen.getByRole("heading", { name: "Redirects" })
    ).toBeInTheDocument()
    const names = new Set(
      managerCalls().map((call) => `${call.hook} ${call.name}`)
    )
    expect(names.has("usePaginatedQuery cms/redirects:listPaginated")).toBe(
      true
    )
    expect(names.has("useMutation cms/redirects:create")).toBe(true)
    expect(names.has("useMutation cms/redirects:remove")).toBe(true)
    expect(
      screen.queryByText("Redirects is turned off")
    ).not.toBeInTheDocument()
    expect(signals()).toEqual([])
  })
})

test("gate error Retry reloads; loading keeps today's line and mounts no manager", () => {
  mocks.status = new Error("module state read failed")
  const view = renderInShell()
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  expect(mocks.reload).toHaveBeenCalledOnce()
  mocks.status = undefined
  view.rerender(shellElement())
  expect(screen.getByText("Loading…")).toBeInTheDocument()
  expect(screen.getByText("Loading…").querySelector("svg")).toHaveClass(
    "animate-spin"
  )
})
