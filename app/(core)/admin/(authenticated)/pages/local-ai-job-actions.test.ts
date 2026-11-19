// @vitest-environment node
import { createHash } from "node:crypto"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  isLocalDevelopment: vi.fn(),
  requireInstallationOwner: vi.fn(),
  isLocalToolRequest: vi.fn(),
  readDevAiSelection: vi.fn(),
  fetchAuthMutation: vi.fn(),
  startLocalJobRunner: vi.fn(),
  runPageOutlineLocally: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/assert-local-dev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assert-local-dev")>()),
  isLocalDevelopment: mocks.isLocalDevelopment,
}))
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))
vi.mock("@/lib/local-request", () => ({
  isLocalToolRequest: mocks.isLocalToolRequest,
}))
vi.mock("@/scripts/lib/dev-ai-selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()),
  readDevAiSelection: mocks.readDevAiSelection,
}))
vi.mock("@/lib/auth/server", () => ({
  fetchAuthMutation: mocks.fetchAuthMutation,
}))
vi.mock("@/lib/ai/local-job-runner", () => ({
  startLocalJobRunner: mocks.startLocalJobRunner,
}))
vi.mock("./local-ai-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-ai-run")>()),
  runPageOutlineLocally: mocks.runPageOutlineLocally,
}))

import type { Id } from "@/convex/_generated/dataModel"
import { makeSubscriptionCliError } from "@/scripts/lib/subscription-cli-contract"
import {
  generatePageOutlineLocal,
  resumeLocalPageJob,
  startLocalPageJob,
} from "./local-ai-job-actions"

const WRITING = { engine: "codex", model: "gpt-6.1-terra", effort: "low" } as const
const JOB = "job-1" as Id<"aiJobs">
const WRITE_INPUT = {
  kind: "write",
  brief: "About us",
  locale: "en",
  meta: { title: "About", slug: "about", metaTitle: "About", metaDescription: "Us" },
  rows: [{ sliceType: "hero", purpose: "Intro" }],
} as const

const selection = (writing?: typeof WRITING) => ({
  version: 3,
  engine: "openrouter",
  ...(writing
    ? { tasks: { "editorial-copy": writing, "structured-outline-meta": writing } }
    : {}),
})

const actions = [
  ["startLocalPageJob", () => startLocalPageJob(WRITE_INPUT as never)],
  ["resumeLocalPageJob", () => resumeLocalPageJob(JOB, "write")],
  ["generatePageOutlineLocal", () => generatePageOutlineLocal({ brief: "About us", locale: "en" })],
] as const

const nothingRan = () => {
  expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
  expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
  expect(mocks.startLocalJobRunner).not.toHaveBeenCalled()
  expect(mocks.runPageOutlineLocally).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isLocalDevelopment.mockReturnValue(true)
  mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner" })
  mocks.isLocalToolRequest.mockResolvedValue(true)
  mocks.readDevAiSelection.mockReturnValue(selection(WRITING))
  mocks.fetchAuthMutation.mockImplementation(async (reference: unknown) =>
    getFunctionName(reference as never) === "cms/aiLocalJobs:startLocalPageJob" ? JOB : null
  )
  mocks.startLocalJobRunner.mockResolvedValue(undefined)
  mocks.runPageOutlineLocally.mockResolvedValue({ title: "About", outline: [] })
})

describe.each(actions)("%s refuses in order", (_name, run) => {
  test("outside local development: refused before the owner check", async () => {
    mocks.isLocalDevelopment.mockReturnValue(false)
    await expect(run()).rejects.toThrow(/local development/)
    expect(mocks.requireInstallationOwner).not.toHaveBeenCalled()
    nothingRan()
  })

  test("anyone but the owner: refused before the request check", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(new Error("owner only"))
    await expect(run()).rejects.toThrow("owner only")
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    nothingRan()
  })

  test("another device: a refusal value; no file read, no Convex call, no tool", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    await expect(run()).resolves.toEqual({ ok: false, refusal: "LOCAL_TOOL_OTHER_DEVICE" })
    nothingRan()
  })
})

describe("startLocalPageJob", () => {
  test("sends Convex the SHA-256 of a fresh secret and gives the runner the secret", async () => {
    await expect(startLocalPageJob(WRITE_INPUT as never)).resolves.toEqual({ ok: true, value: JOB })
    const [reference, args] = mocks.fetchAuthMutation.mock.calls[0]!
    expect(getFunctionName(reference)).toBe("cms/aiLocalJobs:startLocalPageJob")
    expect(args).toEqual({ input: WRITE_INPUT, localRoute: WRITING, runnerSecretHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const [job] = mocks.startLocalJobRunner.mock.calls[0]!
    expect(job.runnerSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createHash("sha256").update(job.runnerSecret).digest("hex")).toBe(args.runnerSecretHash)
    expect(JSON.stringify(args)).not.toContain(job.runnerSecret)
    expect(job).toEqual({ jobId: JOB, runnerSecret: job.runnerSecret })
  })

  test("each start mints a new secret", async () => {
    await startLocalPageJob(WRITE_INPUT as never)
    await startLocalPageJob(WRITE_INPUT as never)
    const [first, second] = mocks.fetchAuthMutation.mock.calls.map(([, args]) => args.runnerSecretHash)
    expect(first).not.toBe(second)
  })

  test("Writing back on its API service: refused, never started", async () => {
    mocks.readDevAiSelection.mockReturnValue(selection())
    await expect(startLocalPageJob(WRITE_INPUT as never)).resolves.toEqual({ ok: false, refusal: "LOCAL_TOOL_NOT_CHOSEN" })
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
  })

  test("a translation job reads Translation's choice", async () => {
    mocks.readDevAiSelection.mockReturnValue(selection(WRITING))
    const input = { kind: "translation", pageId: "p", sourceLocale: "en", targetLocale: "fr" }
    await expect(startLocalPageJob(input as never)).resolves.toEqual({ ok: false, refusal: "LOCAL_TOOL_NOT_CHOSEN" })
  })

  test("a Convex refusal comes back as a value; no runner starts", async () => {
    mocks.fetchAuthMutation.mockRejectedValue(new ConvexError("AI_JOB_ALREADY_ACTIVE"))
    await expect(startLocalPageJob(WRITE_INPUT as never)).resolves.toEqual({ ok: false, refusal: "AI_JOB_ALREADY_ACTIVE" })
    expect(mocks.startLocalJobRunner).not.toHaveBeenCalled()
  })

  test("any other failure throws", async () => {
    mocks.fetchAuthMutation.mockRejectedValue(new Error("network"))
    await expect(startLocalPageJob(WRITE_INPUT as never)).rejects.toThrow("network")
  })
})

describe("resumeLocalPageJob", () => {
  test("resumes with a new secret and passes no route (Convex returns it with each claim)", async () => {
    await expect(resumeLocalPageJob(JOB, "write")).resolves.toEqual({ ok: true, value: null })
    const [reference, args] = mocks.fetchAuthMutation.mock.calls[0]!
    expect(getFunctionName(reference)).toBe("cms/aiLocalJobs:resumeLocalPageJob")
    // The frozen route, not the current choice: only the job kind is sent.
    expect(args).toEqual({ jobId: JOB, kind: "write", runnerSecretHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const [job] = mocks.startLocalJobRunner.mock.calls[0]!
    expect(createHash("sha256").update(job.runnerSecret).digest("hex")).toBe(args.runnerSecretHash)
    expect(job).toEqual({ jobId: JOB, runnerSecret: job.runnerSecret })
  })

  test.each(["write", "translation"] as const)("guard: a %s job whose assistant is back on its API service: refused, never resumed", async (kind) => {
    // Writing back on its API service; Translation never had a local tool.
    mocks.readDevAiSelection.mockReturnValue(selection(kind === "write" ? undefined : WRITING))
    await expect(resumeLocalPageJob(JOB, kind)).resolves.toEqual({ ok: false, refusal: "LOCAL_TOOL_NOT_CHOSEN" })
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
    expect(mocks.startLocalJobRunner).not.toHaveBeenCalled()
  })

  test("an unknown job kind throws before any check", async () => {
    await expect(resumeLocalPageJob(JOB, "other" as never)).rejects.toThrow("Unknown page job kind.")
    nothingRan()
  })
})

describe("generatePageOutlineLocal", () => {
  test("runs the outline step on Writing's choice", async () => {
    await expect(generatePageOutlineLocal({ brief: "About us", locale: "en" })).resolves.toEqual({
      ok: true,
      value: { title: "About", outline: [] },
    })
    expect(mocks.runPageOutlineLocally).toHaveBeenCalledWith({ brief: "About us", locale: "en" }, WRITING)
  })

  test("an over-long brief is refused before any check or run", async () => {
    await expect(generatePageOutlineLocal({ brief: "x".repeat(2_001), locale: "en" })).rejects.toThrow("Brief too long.")
    nothingRan()
  })

  test("a run failure throws; it is never turned into a refusal", async () => {
    const selected = { lane: "local-build", engine: "codex-cli", model: "gpt-6.2-nova", effort: "low" } as const
    mocks.runPageOutlineLocally.mockRejectedValueOnce(
      makeSubscriptionCliError("UNSUPPORTED_CAPABILITY", { selected, attempts: 0, phase: "page-fill" })
    )
    await expect(generatePageOutlineLocal({ brief: "About us", locale: "en" })).rejects.toMatchObject({
      category: "UNSUPPORTED_CAPABILITY",
    })
  })
})
