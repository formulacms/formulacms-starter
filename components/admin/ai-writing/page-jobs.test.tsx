import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../../../messages/admin/en.json"
import fr from "../../../messages/admin/fr.json"
import { PageJobCard, RunningJobNotice, type PageJob } from "./page-jobs"

const mocks = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  queryArgs: [] as [string, unknown][],
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  confirm: vi.fn(),
  push: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

vi.mock("convex/react", () => ({
  useQueries: (request: Record<string, { query: unknown; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(request).map(([key, { query, args }]) => {
        const name = getFunctionName(query as never)
        mocks.queryArgs.push([name, args])
        return [key, mocks.data[name]]
      })
    ),
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    return (mocks.mutations[name] ??= vi.fn())
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

const unit = (
  index: number,
  state: PageJob["units"][number]["state"],
  reused = false
): PageJob["units"][number] => ({
  index,
  kind: "write",
  sliceType: "features-icon-grid",
  purpose: `Purpose ${index + 1}`,
  state,
  reused,
  costMicros: 0,
})

function makeJob(over: Partial<PageJob> = {}): PageJob {
  return {
    jobId: "job-1" as PageJob["jobId"],
    kind: "write",
    title: "About us",
    locale: "en",
    state: "running",
    pageId: "page-1" as PageJob["pageId"],
    estimateMicros: 0,
    costMicros: 0,
    createdAt: 0,
    expiresAt: 0,
    reusedCount: 0,
    canResume: false,
    resumeEstimateMicros: 0,
    dismissMovesPageToTrash: true,
    month: { spentMicros: 0, reservedMicros: 0, capMicros: 0, status: "below" },
    units: [unit(0, "saved"), unit(1, "inProgress"), unit(2, "waiting")],
    ...over,
  }
}

const RESULT = {
  jobId: "job-1",
  pageId: "page-9",
  title: "About us",
  locale: "en",
  pageAvailable: true,
  sections: [
    {
      index: 0,
      sliceType: "features-icon-grid",
      purpose: "Open with who we are",
      fields: [
        { label: "Title", text: "A studio that sweats the details." },
        { label: "Body", text: "Calm, fast websites." },
      ],
    },
    {
      index: 2,
      sliceType: "faq-simple",
      purpose: "Answer common questions",
      fields: [{ label: "Question", text: "How long does a site take?" }],
    },
    {
      index: 5,
      sliceType: "rich-text-body",
      purpose: "Close with an invitation",
      fields: [{ label: "Body", text: "Let’s talk about your site." }],
    },
  ],
}

function renderCard(
  job: PageJob,
  options: {
    otherJobActive?: boolean
    onFinish?: () => void
    locale?: "en" | "fr"
  } = {}
) {
  const locale = options.locale ?? "en"
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <PageJobCard
        job={job}
        otherJobActive={options.otherJobActive ?? false}
        onFinish={options.onFinish}
      />
    </NextIntlClientProvider>
  )
}

const mutation = (name: string) => (mocks.mutations[name] ??= vi.fn())
const buttonNames = () =>
  within(screen.getByTestId("job-progress"))
    .queryAllByRole("button")
    .map((button) => button.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.data = { "cms/aiJobs:pageJobResult": RESULT }
  mocks.queryArgs.length = 0
  mocks.mutations = {}
  mocks.confirm.mockResolvedValue(true)
})

describe("PageJobCard states", () => {
  test.each([
    ["running", "Running", ["Cancel"]],
    ["canceling", "Finishing the current unit…", ["Cancel"]],
    ["canceled", "Canceled", ["Resume", "Dismiss"]],
    ["failed", "Failed", ["Resume", "Dismiss"]],
    ["capped", "Failed", ["Resume", "Dismiss"]],
    ["done", "Done", ["Review sections"]],
    ["expired", "Expired · saved results are gone", ["Dismiss"]],
  ] as const)("%s shows %s and its buttons", (state, status, buttons) => {
    renderCard(makeJob({ state }))
    expect(screen.getByRole("status")).toHaveTextContent(status)
    expect(buttonNames()).toEqual(buttons)
    if (state === "canceling")
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    if (state === "running")
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
  })

  test("counts saved units, fills the bar and labels each unit", () => {
    renderCard(
      makeJob({
        state: "failed",
        failedIndex: 2,
        reusedCount: 1,
        units: [
          unit(0, "saved", true),
          unit(1, "saved"),
          unit(2, "failed"),
          unit(3, "waiting"),
        ],
      })
    )
    expect(screen.getByTestId("job-count")).toHaveTextContent("2 of 4 sections")
    expect(
      screen.getByRole("progressbar", { name: "Saved units" })
    ).toHaveAttribute("aria-valuenow", "50")
    expect(screen.getByTestId("reused")).toHaveTextContent(
      "1 saved unit reused"
    )
    const rows = within(screen.getByRole("list", { name: "Saved results" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent)
    expect(rows).toEqual([
      "Section 1 · Purpose 1Reused",
      "Section 2 · Purpose 2Saved",
      "Section 3 · Purpose 3Failed",
      "Section 4 · Purpose 4Waiting",
    ])
  })

  test("shows In progress for the unit being written and no reused line at zero", () => {
    renderCard(makeJob())
    expect(screen.getByText("In progress")).toBeInTheDocument()
    expect(screen.queryByTestId("reused")).not.toBeInTheDocument()
  })

  test("pluralizes the reused line", () => {
    renderCard(makeJob({ state: "canceled", reusedCount: 3 }))
    expect(screen.getByTestId("reused")).toHaveTextContent(
      "3 saved units reused"
    )
  })

  test("an expired job has no unit list and only Dismiss", () => {
    renderCard(makeJob({ state: "expired", units: [] }))
    expect(
      screen.queryByRole("list", { name: "Saved results" })
    ).not.toBeInTheDocument()
    expect(buttonNames()).toEqual(["Dismiss"])
  })
})

describe("PageJobCard actions", () => {
  test("Cancel and Resume call their mutations with the job id", async () => {
    const view = renderCard(makeJob())
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mutation("cms/aiJobs:cancelPageJob")).toHaveBeenCalledWith({
      jobId: "job-1",
    })
    view.unmount()
    renderCard(makeJob({ state: "canceled" }))
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(mutation("cms/aiJobs:resumePageJob")).toHaveBeenCalledWith({
      jobId: "job-1",
    })
    await waitFor(() => expect(mocks.toast.error).not.toHaveBeenCalled())
  })

  test("Resume is disabled while another job is active", () => {
    renderCard(makeJob({ state: "failed" }), { otherJobActive: true })
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled()
  })

  test("a failed Cancel or Resume shows the generic error toast, never the server text", async () => {
    mutation("cms/aiJobs:resumePageJob").mockRejectedValue(
      new Error("provider said no")
    )
    renderCard(makeJob({ state: "canceled" }))
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Something went wrong. Try again."
      )
    )
  })
})

describe("Review list", () => {
  test("opening the review subscribes to the result, ticks every section and clears nothing", () => {
    renderCard(makeJob({ state: "done" }))
    const review = screen.getByRole("button", { name: "Review sections" })
    expect(review).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(review)
    expect(review).toHaveAttribute("aria-expanded", "true")
    expect(mocks.queryArgs).toContainEqual([
      "cms/aiJobs:pageJobResult",
      { jobId: "job-1" },
    ])
    expect(screen.getByText("Sections to review")).toBeInTheDocument()
    expect(screen.getByTestId("review-meta")).toHaveTextContent(
      "About us · Draft · English"
    )
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked()
    expect(screen.getByLabelText("Features Icon Grid")).toBeChecked()
    expect(
      screen.getAllByTestId("review-text").map((p) => p.textContent)
    ).toEqual([
      "A studio that sweats the details.",
      "Calm, fast websites.",
      "How long does a site take?",
      "Let’s talk about your site.",
    ])
    expect(
      screen.getByRole("button", { name: "Accept chosen (3)" })
    ).toBeEnabled()
    expect(
      Object.values(mocks.mutations).every((fn) => fn.mock.calls.length === 0)
    ).toBe(true)
  })

  test("Accept sends the ticked section indexes, toasts and opens the editor", async () => {
    const onFinish = vi.fn()
    mutation("cms/aiJobs:acceptPageJob").mockResolvedValue({
      pageId: "page-9",
      saved: 2,
    })
    renderCard(makeJob({ state: "done" }), { onFinish })
    fireEvent.click(screen.getByRole("button", { name: "Review sections" }))
    const boxes = screen.getAllByRole("checkbox")
    // Untick the last, then the first, then tick the first again.
    fireEvent.click(boxes[2]!)
    fireEvent.click(boxes[0]!)
    fireEvent.click(boxes[0]!)
    fireEvent.click(screen.getByRole("button", { name: "Accept chosen (2)" }))
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/admin/pages/page-9")
    )
    expect(mutation("cms/aiJobs:acceptPageJob")).toHaveBeenCalledWith({
      jobId: "job-1",
      chosen: [0, 2],
    })
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Saved to your draft. Nothing is published."
    )
    expect(onFinish).toHaveBeenCalled()
  })

  test("Accept chosen is disabled with nothing ticked", () => {
    renderCard(makeJob({ state: "done" }))
    fireEvent.click(screen.getByRole("button", { name: "Review sections" }))
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box)
    expect(
      screen.getByRole("button", { name: "Accept chosen (0)" })
    ).toBeDisabled()
  })

  test("a failed save keeps the ticks and the list; a second press retries", async () => {
    const accept = mutation("cms/aiJobs:acceptPageJob")
    accept.mockRejectedValueOnce(new Error("conflict")).mockResolvedValueOnce({
      pageId: "page-9",
      saved: 2,
    })
    renderCard(makeJob({ state: "done" }))
    fireEvent.click(screen.getByRole("button", { name: "Review sections" }))
    fireEvent.click(screen.getAllByRole("checkbox")[1]!)
    fireEvent.click(screen.getByRole("button", { name: "Accept chosen (2)" }))
    expect(
      await screen.findByText(
        "Could not save. Your sections are kept. Try again."
      )
    ).toHaveAttribute("role", "alert")
    expect(
      screen
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("aria-checked"))
    ).toEqual(["true", "false", "true"])
    expect(mocks.push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Accept chosen (2)" }))
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/admin/pages/page-9")
    )
    expect(accept).toHaveBeenNthCalledWith(2, {
      jobId: "job-1",
      chosen: [0, 5],
    })
  })
})

describe("Dismiss", () => {
  test("a job-created page: the confirm says it moves to Trash", async () => {
    mutation("cms/aiJobs:dismissPageJob").mockResolvedValue({
      pageMovedToTrash: true,
    })
    const onFinish = vi.fn()
    renderCard(makeJob({ state: "failed" }), { onFinish })
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Moved to Trash")
    )
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Dismiss these sections?",
      description:
        'The page "About us" was created for this job. It moves to Trash. You can restore it from Trash.',
      confirmText: "Dismiss and move to Trash",
    })
    expect(mutation("cms/aiJobs:dismissPageJob")).toHaveBeenCalledWith({
      jobId: "job-1",
    })
    expect(onFinish).toHaveBeenCalled()
  })

  test("an edited page: the confirm says it stays; the toast follows the returned value", async () => {
    // The server's answer wins over the earlier prediction.
    mutation("cms/aiJobs:dismissPageJob").mockResolvedValue({
      pageMovedToTrash: true,
    })
    renderCard(makeJob({ state: "done", dismissMovesPageToTrash: false }))
    fireEvent.click(screen.getByRole("button", { name: "Review sections" }))
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }))
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Moved to Trash")
    )
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Dismiss these sections?",
      description:
        'You edited the page "About us" after the job started, so it stays in your pages.',
      confirmText: "Dismiss",
    })
  })

  test("a kept page toasts Dismissed; a declined confirm calls nothing", async () => {
    mutation("cms/aiJobs:dismissPageJob").mockResolvedValue({
      pageMovedToTrash: false,
    })
    renderCard(makeJob({ state: "canceled", dismissMovesPageToTrash: false }))
    mocks.confirm.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
    expect(mutation("cms/aiJobs:dismissPageJob")).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Dismissed"))
  })

  test("a failed Dismiss shows the generic error toast", async () => {
    mutation("cms/aiJobs:dismissPageJob").mockRejectedValue(
      new Error("AI_JOB_NOT_REVIEWABLE")
    )
    renderCard(makeJob({ state: "failed" }))
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Something went wrong. Try again."
      )
    )
  })
})

describe("languages and copy", () => {
  test("French card and review use the prototype's texts", async () => {
    mutation("cms/aiJobs:dismissPageJob").mockResolvedValue({
      pageMovedToTrash: true,
    })
    renderCard(makeJob({ state: "done", units: [unit(0, "saved")] }), {
      locale: "fr",
    })
    expect(screen.getByRole("status")).toHaveTextContent("Terminée")
    expect(screen.getByTestId("job-count")).toHaveTextContent(
      "1 sur 1 sections"
    )
    expect(
      screen.getByRole("progressbar", { name: "Unités enregistrées" })
    ).toBeInTheDocument()
    expect(screen.getByText("Section 1 · Purpose 1")).toBeInTheDocument()
    expect(screen.getByText("Enregistré")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Relire les sections" }))
    expect(screen.getByText("Sections à relire")).toBeInTheDocument()
    expect(screen.getByTestId("review-meta")).toHaveTextContent(
      "About us · Brouillon · English"
    )
    expect(
      screen.getByRole("button", { name: "Accepter la sélection (3)" })
    ).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Tout ignorer" }))
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Mise à la corbeille")
    )
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Ignorer ces sections ?",
      description:
        "La page « About us » a été créée pour cette tâche. Elle va dans la corbeille. Vous pouvez la restaurer depuis la corbeille.",
      confirmText: "Ignorer et mettre à la corbeille",
    })
  })

  test.each([
    ["running", "En cours", "Annuler"],
    ["canceling", "Fin de l’unité en cours…", "Annuler"],
    ["canceled", "Annulée", "Reprendre"],
    ["failed", "Échec", "Ignorer"],
    [
      "expired",
      "Expirée · les résultats enregistrés ont été supprimés",
      "Ignorer",
    ],
  ] as const)("French %s status", (state, status, button) => {
    renderCard(makeJob({ state }), { locale: "fr" })
    expect(screen.getByRole("status")).toHaveTextContent(status)
    expect(screen.getByRole("button", { name: button })).toBeInTheDocument()
  })

  test.each(["en", "fr"] as const)("shows no cost word in %s", (locale) => {
    renderCard(makeJob({ state: "done", reusedCount: 2 }), { locale })
    fireEvent.click(
      screen.getByRole("button", {
        name: locale === "fr" ? "Relire les sections" : "Review sections",
      })
    )
    expect(document.body.textContent).not.toMatch(
      /\$|estimat|\bcap\b|reserved|r[ée]serv[ée]|co[uû]t|limite|cost|charge|frais/i
    )
  })
})

describe("RunningJobNotice", () => {
  const renderNotice = (active: PageJob, onFollow = vi.fn()) => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <RunningJobNotice active={active} onFollow={onFollow} />
      </NextIntlClientProvider>
    )
    return onFollow
  }

  test("a Write job's card is on this screen: the link focuses it", () => {
    const onFollow = renderNotice(makeJob())
    fireEvent.click(screen.getByRole("button", { name: "Open the running job" }))
    expect(onFollow).toHaveBeenCalledWith("job-1")
  })

  test("a translation job's link leads to its page and card", () => {
    const onFollow = renderNotice(
      makeJob({ kind: "translation", pageId: "page-7" as PageJob["pageId"] })
    )
    expect(
      screen.getByRole("link", { name: "Open the running job" })
    ).toHaveAttribute("href", "/admin/pages/page-7#ai-page-job-job-1")
    expect(onFollow).not.toHaveBeenCalled()
  })
})
