import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { generateContentType } from "./generate"
import {
  ContentTypeCreationError,
  CREATION_RECORD_PATH,
  hasCreationRecord,
  recoverContentTypeCreation,
  recoveryReport,
  writeFilesUnderCreationRecord,
} from "./recovery"
import { parseContentTypeSpecJson } from "./spec"

// Every case runs on its own temporary root, never on the real tree.
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

// One existing text file, one existing file whose bytes are not UTF-8, and
// one new file.
const PRIOR_TEXT = '{ "a": 1 }\n'
const PRIOR_BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x41])

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "content-type-new-")))
  roots.push(root)
  const put = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  put("messages/admin/en.json", PRIOR_TEXT)
  put("convex/schema.ts", PRIOR_BINARY)
  const plan = {
    type: "event",
    files: [
      { path: "convex/lib/contentTypes/event.ts", content: "export {}\n" },
      { path: "messages/admin/en.json", content: '{ "a": 2 }\n' },
      { path: "convex/schema.ts", content: "// regenerated\n" },
    ],
  }
  const read = (path: string) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path)) : null
  return { root, plan, put, read }
}

function expectPriorState({ read }: ReturnType<typeof fixture>) {
  expect(read("convex/lib/contentTypes/event.ts")).toBeNull()
  expect(read("messages/admin/en.json")?.toString()).toBe(PRIOR_TEXT)
  expect(read("convex/schema.ts")?.equals(PRIOR_BINARY)).toBe(true)
}

describe("content-type creation record", () => {
  test("a run that finishes writes every file and deletes the record", async () => {
    const context = fixture()
    const result = await writeFilesUnderCreationRecord(
      context.root,
      context.plan
    )
    expect(result).toEqual({ interrupted: false })
    for (const file of context.plan.files) {
      expect(context.read(file.path)?.toString()).toBe(file.content)
    }
    expect(hasCreationRecord(context.root)).toBe(false)
  })

  test("an interrupted run recovers byte for byte", async () => {
    const context = fixture()
    // Stop after the record and two of three writes, as a killed process would.
    const result = await writeFilesUnderCreationRecord(
      context.root,
      context.plan,
      { afterWrite: (written) => written === 2 }
    )
    expect(result).toEqual({ interrupted: true })
    expect(hasCreationRecord(context.root)).toBe(true)
    const record = JSON.parse(
      context.read(CREATION_RECORD_PATH)!.toString()
    ) as { type: string; files: { path: string; prior: unknown }[] }
    expect(record.type).toBe("event")
    expect(record.files.map(({ prior }) => prior)).toEqual([
      "absent",
      { encoding: "utf8", content: PRIOR_TEXT },
      { encoding: "base64", content: PRIOR_BINARY.toString("base64") },
    ])

    const recovery = await recoverContentTypeCreation(context.root)
    expect(recovery).toEqual({
      type: "event",
      restored: ["convex/lib/contentTypes/event.ts", "messages/admin/en.json"],
      kept: [],
      temporaryFilesRemoved: 0,
    })
    expectPriorState(context)
    expect(hasCreationRecord(context.root)).toBe(false)
    expect(recoveryReport(recovery!)).toEqual({
      ok: true,
      text: 'Removed the half-created content type "event" (2 files restored). You can run pnpm content-type:new again.',
    })
    // Nothing left to recover.
    expect(await recoverContentTypeCreation(context.root)).toBeNull()
  })

  test("keeps and names a file the owner changed after the interrupted run", async () => {
    const context = fixture()
    await writeFilesUnderCreationRecord(context.root, context.plan, {
      afterWrite: (written) => written === 3,
    })
    context.put("messages/admin/en.json", '{ "a": "owner edit" }\n')

    const recovery = await recoverContentTypeCreation(context.root)
    expect(recovery).toEqual({
      type: "event",
      restored: ["convex/lib/contentTypes/event.ts", "convex/schema.ts"],
      kept: ["messages/admin/en.json"],
      temporaryFilesRemoved: 0,
    })
    expect(context.read("messages/admin/en.json")?.toString()).toBe(
      '{ "a": "owner edit" }\n'
    )
    expect(hasCreationRecord(context.root)).toBe(true)
    const report = recoveryReport(recovery!)
    expect(report.ok).toBe(false)
    expect(report.text).toContain(
      "  messages/admin/en.json (changed after the interrupted run)"
    )
    expect(report.text).toContain(
      `Their bytes from before the run are in ${CREATION_RECORD_PATH}.`
    )
    expect(report.text).toContain(
      "then run pnpm content-type:new -- --recover again."
    )

    // Once the owner resolves the file, --recover finishes.
    context.put("messages/admin/en.json", PRIOR_TEXT)
    expect(await recoverContentTypeCreation(context.root)).toEqual({
      type: "event",
      restored: [],
      kept: [],
      temporaryFilesRemoved: 0,
    })
    expectPriorState(context)
    expect(hasCreationRecord(context.root)).toBe(false)
  })

  test("removes leftover temp files beside recorded paths and keeps look-alikes", async () => {
    const context = fixture()
    await writeFilesUnderCreationRecord(context.root, context.plan, {
      afterWrite: (written) => written === 1,
    })
    const leftover =
      "messages/admin/.en.json.0f8e2c1a-3b4d-4e5f-8a9b-1c2d3e4f5a6b.tmp"
    const lookAlike = "messages/admin/.en.json.not-a-uuid.tmp"
    context.put(leftover, "partial")
    context.put(lookAlike, "owner file")

    const recovery = await recoverContentTypeCreation(context.root)
    expect(recovery?.temporaryFilesRemoved).toBe(1)
    expect(context.read(leftover)).toBeNull()
    expect(context.read(lookAlike)?.toString()).toBe("owner file")
    expect(recoveryReport(recovery!).text).toContain(
      "Removed 1 leftover temporary file."
    )
    expectPriorState(context)
  })

  test("a thrown error rolls back and deletes the record", async () => {
    const context = fixture()
    const error = await writeFilesUnderCreationRecord(
      context.root,
      context.plan,
      {
        afterWrite: (written) => {
          if (written === 2) throw new Error("disk full")
        },
      }
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ContentTypeCreationError)
    expect((error as ContentTypeCreationError).message).toBe("disk full")
    expect((error as ContentTypeCreationError).recovery).toEqual({
      type: "event",
      restored: [],
      kept: [],
      temporaryFilesRemoved: 0,
    })
    expectPriorState(context)
    expect(hasCreationRecord(context.root)).toBe(false)
  })

  test("content-type:new refuses while a record exists and names --recover", async () => {
    const context = fixture()
    await writeFilesUnderCreationRecord(context.root, context.plan, {
      afterWrite: () => true,
    })
    const spec = parseContentTypeSpecJson(
      JSON.stringify({
        type: "event",
        labels: { en: { singular: "Event", plural: "Events" } },
        capabilities: {
          blockBody: false,
          revisions: false,
          scheduling: false,
          presence: false,
          requiresBodyContent: false,
        },
        sharedFields: {},
        localizedFields: { title: { kind: "text", public: true } },
        referenceCard: { title: { scope: "localized", field: "title" } },
      })
    )
    for (const dryRun of [false, true]) {
      await expect(
        generateContentType(spec, { root: context.root, dryRun })
      ).rejects.toThrow(
        /run for content type "event" did not finish[\s\S]*Run pnpm content-type:new -- --recover/
      )
    }
    await expect(
      writeFilesUnderCreationRecord(context.root, context.plan)
    ).rejects.toThrow("pnpm content-type:new -- --recover")
  })
})
