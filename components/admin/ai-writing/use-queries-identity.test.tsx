import { fireEvent, render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../../../messages/admin/en.json"
import type { ModuleGate } from "../module-gate"
import { NewPageWritingSlot } from "./new-page-participant"
import { PageJobCard, type PageJob } from "./page-jobs"

// Convex's useQueries memoizes its subscription on the request object's
// identity; a new object on every render re-subscribes during render and
// loops ("Too many re-renders"). Vitest runs without the React Compiler, so
// these tests prove the identity does not depend on it.
const mocks = vi.hoisted(() => ({
  gate: { state: "on" } as { state: string },
  data: {} as Record<string, unknown>,
  requests: [] as Record<string, { query: unknown }>[],
}))

vi.mock("convex/react", () => ({
  useQueries: (request: Record<string, { query: unknown }>) => {
    mocks.requests.push(request)
    return Object.fromEntries(
      Object.entries(request).map(([key, { query }]) => [
        key,
        mocks.data[getFunctionName(query as never)],
      ])
    )
  },
  useQuery: (reference: unknown) =>
    mocks.data[getFunctionName(reference as never)],
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}))
vi.mock("../admin-module-state-provider", () => ({
  useModuleGate: () => mocks.gate as ModuleGate,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(),
}))

const status = (ready: boolean) => ({
  connections: [
    {
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      state: ready ? "connected" : "missing",
    },
  ],
  assistants: [
    { id: "writing", provider: "anthropic", ready, available: true },
  ],
  card: { state: ready ? "active" : "missing" },
})

const DONE_JOB = {
  jobId: "job-1",
  kind: "write",
  title: "About us",
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
    {
      index: 1,
      kind: "write",
      purpose: "Outro",
      state: "saved",
      reused: false,
      costMicros: 0,
    },
  ],
} as unknown as PageJob

/** Every request one call site (by its keys) passed, across all renders. */
const requestsFor = (keys: string) =>
  mocks.requests.filter((request) => Object.keys(request).join(",") === keys)

function expectOneIdentity(keys: string) {
  const seen = requestsFor(keys)
  const label = keys || "(empty)"
  expect(seen.length, `${label} renders`).toBeGreaterThan(1)
  // Function references are proxies that cannot be printed; count identities.
  expect(new Set(seen).size, `${label} request objects`).toBe(1)
}

function slot(isCreating = false) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <NewPageWritingSlot
        routeData={{ editorialCopy: null, structuredOutlineMeta: null }}
        title=""
        locale="en"
        pageType="page"
        canSubmit={false}
        canCreateSelected
        isCreating={isCreating}
        createShellPage={async () => undefined}
      >
        {(result) => (
          <form aria-label="New page">{result.pageWizardControl}</form>
        )}
      </NewPageWritingSlot>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mocks.requests.length = 0
  mocks.data = {
    "cms/aiSettings:status": status(true),
    "cms/aiJobs:pageJobProgress": [DONE_JOB],
    "cms/settings:getSiteConfig": {
      enabledLocales: ["en"],
      defaultLocale: "en",
    },
    "cms/settings:getSettings": { brandVoice: "" },
    "cms/agents:getContentPresets": {
      writeBriefs: [],
      refinePresets: [],
      pageBriefs: [],
    },
    "cms/aiJobs:pageJobResult": {
      jobId: "job-1",
      pageId: "page-1",
      title: "About us",
      locale: "en",
      pageAvailable: true,
      sections: [
        { index: 0, sliceType: "faq-simple", purpose: "Intro", fields: [] },
        { index: 1, sliceType: "faq-simple", purpose: "Outro", fields: [] },
      ],
    },
  }
})

describe("useQueries requests keep their identity across renders", () => {
  test("Writing not ready: the status and empty job requests", () => {
    mocks.data["cms/aiSettings:status"] = status(false)
    const view = render(slot())
    view.rerender(slot(true))
    expectOneIdentity("status")
    expectOneIdentity("")
  })

  test("Writing ready: the status, job and preset requests", () => {
    render(slot())
    fireEvent.click(screen.getByRole("button", { name: "Write page with AI" }))
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "A" } })
    fireEvent.change(screen.getByLabelText("Brief"), {
      target: { value: "AB" },
    })
    expectOneIdentity("status")
    expectOneIdentity("jobs")
    expectOneIdentity("presets")
  })

  test("the review list's result request, for one job", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PageJobCard job={DONE_JOB} otherJobActive={false} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Review sections" }))
    fireEvent.click(screen.getAllByRole("checkbox")[0]!)
    fireEvent.click(screen.getAllByRole("checkbox")[1]!)
    expectOneIdentity("result")
  })
})
