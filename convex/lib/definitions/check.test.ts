import { v } from "convex/values"
import { describe, expect, test } from "vitest"
import { blockDefs } from "../blocks"
import { group, list, relation, text } from "../blocks/primitives"
import { contentTypeDefs, CONTENT_TYPES } from "../contentTypes"
import type {
  ContentTypeDescriptor,
  DescriptorFieldMap,
} from "../contentTypes/types"
import { blockDefinitionProblems } from "./blocks"
import { contentTypeDefinitionProblems } from "./check"
import { formatDefinitionProblems } from "./common"

const baseLocalized = { title: text().public() }

/** A small valid content type; each test breaks one thing. */
function descriptor(
  type: string,
  parts: {
    shared?: DescriptorFieldMap
    localized?: DescriptorFieldMap
    pathPrefix?: string
  } = {}
): ContentTypeDescriptor {
  const shared = parts.shared ?? {}
  const localized = parts.localized ?? baseLocalized
  const validators = (fields: DescriptorFieldMap) =>
    Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [name, field.validator])
    )
  return {
    ...contentTypeDefs.job,
    type,
    sharedFields: shared,
    localizedFields: localized,
    sharedValidator: v.object(validators(shared)),
    localizedValidator: v.object(validators(localized)),
    routing:
      parts.pathPrefix === undefined
        ? undefined
        : { pathPrefix: parts.pathPrefix },
  } as ContentTypeDescriptor
}

function onlyProblem(
  problems: ReturnType<typeof contentTypeDefinitionProblems>,
  rule: string
) {
  expect(problems.map((problem) => problem.rule)).toEqual([rule])
  return problems[0]
}

describe("today's registries", () => {
  test("the shipped content types have no problems", () => {
    expect(
      contentTypeDefinitionProblems({
        definitions: contentTypeDefs,
        activeTypes: CONTENT_TYPES,
      })
    ).toEqual([])
  })

  test("the shipped blocks have no problems", () => {
    expect(blockDefinitionProblems({ definitions: blockDefs })).toEqual([])
  })
})

describe("content type rules", () => {
  test("key-mismatch names the key and the descriptor type", () => {
    const problem = onlyProblem(
      contentTypeDefinitionProblems({ definitions: { event: descriptor("job") } }),
      "key-mismatch"
    )
    expect(problem.type).toBe("event")
    expect(problem.message).toContain('Content type "event"')
    expect(problem.message).toContain('"job"')
  })

  test("duplicate-type: two descriptors with one type", () => {
    const problems = contentTypeDefinitionProblems({
      definitions: { a: descriptor("a"), b: descriptor("a") },
    })
    expect(problems.map((p) => p.rule)).toContain("duplicate-type")
    expect(problems.find((p) => p.rule === "duplicate-type")?.type).toBe("a")
  })

  test("duplicate-type: manifest rows with a repeated type, module or export", () => {
    const problems = contentTypeDefinitionProblems({
      definitions: { a: descriptor("a") },
      entries: [
        { type: "a", module: "mod", exportName: "aType" },
        { type: "a", module: "mod", exportName: "aType" },
      ],
    })
    expect(problems).toHaveLength(3)
    expect(new Set(problems.map((p) => p.rule))).toEqual(
      new Set(["duplicate-type"])
    )
    expect(problems.map((p) => p.message).join("\n")).toMatch(/module "mod"/)
    expect(problems.map((p) => p.message).join("\n")).toMatch(/export name "aType"/)
  })

  test("reserved-field: shared field in the live row", () => {
    const problem = onlyProblem(
      contentTypeDefinitionProblems({
        definitions: {
          job: descriptor("job", { shared: { status: text().public() } }),
        },
      }),
      "reserved-field"
    )
    expect(problem).toMatchObject({ type: "job", field: "status" })
    expect(problem.message).toBe(
      'Content type "job", field "status": reserved-field — the live page row already stores "status"; rename the field.'
    )
  })

  test("reserved-field: shared field only in the staging row", () => {
    const problem = onlyProblem(
      contentTypeDefinitionProblems({
        definitions: {
          job: descriptor("job", { shared: { pageId: text().public() } }),
        },
      }),
      "reserved-field"
    )
    expect(problem.message).toContain("the staging row already stores")
    expect(problem.message).not.toContain("live page row")
  })

  test("reserved-field: localized field every language already stores", () => {
    const problem = onlyProblem(
      contentTypeDefinitionProblems({
        definitions: {
          job: descriptor("job", {
            localized: { ...baseLocalized, blocks: text().public() },
          }),
        },
      }),
      "reserved-field"
    )
    expect(problem).toMatchObject({ type: "job", field: "blocks" })
    expect(problem.message).toContain("localized content")
  })

  test("missing-title: absent, not text, or optional", () => {
    const run = (localized: DescriptorFieldMap) =>
      contentTypeDefinitionProblems({
        definitions: { job: descriptor("job", { localized }) },
      })
    for (const localized of [
      { summary: text().public() },
      { title: group({ a: text() }) },
      { title: text().optional() },
    ] as DescriptorFieldMap[]) {
      const problem = onlyProblem(run(localized), "missing-title")
      expect(problem).toMatchObject({ type: "job", field: "title" })
    }
  })

  test("missing-title: the stored validator needs a required string title", () => {
    const run = (localizedValidator: ContentTypeDescriptor["localizedValidator"]) =>
      contentTypeDefinitionProblems({
        definitions: {
          job: { ...descriptor("job"), localizedValidator },
        },
      })
    for (const [label, validator] of [
      ["absent", v.object({})],
      ["numeric", v.object({ title: v.number() })],
      ["optional", v.object({ title: v.optional(v.string()) })],
    ] as const) {
      const problem = onlyProblem(
        run(validator as ContentTypeDescriptor["localizedValidator"]),
        "missing-title"
      )
      expect(problem, label).toMatchObject({ type: "job", field: "title" })
    }
    expect(run(v.object({ title: v.string() }))).toEqual([])
  })

  test("relation-target: a top-level and a nested relation to an unknown type", () => {
    const shared = {
      boss: relation({ pageTypes: ["ghost" as never] }),
      team: group({ lead: relation({ pageTypes: ["job", "phantom" as never] }) }),
      peers: list(relation({ pageTypes: ["spirit" as never] })),
    } as DescriptorFieldMap
    const problems = contentTypeDefinitionProblems({
      definitions: { job: descriptor("job", { shared }) },
    })
    expect(problems.map((p) => p.rule)).toEqual([
      "relation-target",
      "relation-target",
      "relation-target",
    ])
    expect(problems.map((p) => p.field)).toEqual([
      "boss",
      "team.lead",
      "peers[]",
    ])
    expect(problems[0].message).toContain('"ghost"')
  })

  test("validator-parity: a shared field and its stored validator must match", () => {
    const ok = descriptor("ok", { shared: { topic: text().optional() } })
    expect(
      contentTypeDefinitionProblems({ definitions: { ok } })
    ).toEqual([])

    const unstored = {
      ...ok,
      sharedValidator: v.object({}),
    } as ContentTypeDescriptor
    const missing = onlyProblem(
      contentTypeDefinitionProblems({ definitions: { ok: unstored } }),
      "validator-parity"
    )
    expect(missing.message).toMatch(
      /^Content type "ok", field "topic": validator-parity — /
    )

    const undeclared = {
      ...ok,
      sharedFields: {},
    } as ContentTypeDescriptor
    const extra = onlyProblem(
      contentTypeDefinitionProblems({ definitions: { ok: undeclared } }),
      "validator-parity"
    )
    expect(extra.field).toBe("topic")
  })

  test("validator-parity: only post's legacy stored category is exempt", () => {
    const stray = {
      ...descriptor("note"),
      sharedValidator: v.object({ category: text().optional().validator }),
    } as ContentTypeDescriptor
    onlyProblem(
      contentTypeDefinitionProblems({ definitions: { note: stray } }),
      "validator-parity"
    )
    const post = {
      ...stray,
      type: "post",
    } as ContentTypeDescriptor
    expect(
      contentTypeDefinitionProblems({ definitions: { post } })
    ).toEqual([])
  })

  test("post-only-field: tags and authorIds belong to post", () => {
    const news = descriptor("news", {
      shared: { tags: list(text()).optional() },
    })
    const problem = onlyProblem(
      contentTypeDefinitionProblems({ definitions: { news } }),
      "post-only-field"
    )
    expect(problem.message).toBe(
      'Content type "news", field "tags": post-only-field — the admin editor supports this field only on "post"; rename the field.'
    )
    // The same field on post is fine, and so is another name on another type.
    const post = descriptor("post", {
      shared: { tags: list(text()).optional() },
    })
    const ok = descriptor("ok", { shared: { labels: list(text()).optional() } })
    expect(
      contentTypeDefinitionProblems({ definitions: { post, ok } })
    ).toEqual([])
  })

  test("duplicate-path-prefix: non-empty repeats; empty may repeat", () => {
    const problem = onlyProblem(
      contentTypeDefinitionProblems({
        definitions: {
          a: descriptor("a", { pathPrefix: "news" }),
          b: descriptor("b", { pathPrefix: "news" }),
          c: descriptor("c", { pathPrefix: "" }),
          d: descriptor("d", { pathPrefix: "" }),
        },
      }),
      "duplicate-path-prefix"
    )
    expect(problem.type).toBe("b")
    expect(problem.message).toContain('"news"')
    expect(problem.message).toContain('"a"')
  })

  test("active-type: unknown and repeated selections", () => {
    const problems = contentTypeDefinitionProblems({
      definitions: { a: descriptor("a") },
      activeTypes: ["a", "a", "zzz"],
    })
    expect(problems.map((p) => [p.rule, p.type])).toEqual([
      ["active-type", "a"],
      ["active-type", "zzz"],
    ])
  })
})

describe("block rules", () => {
  const [goodType, good] = Object.entries(blockDefs)[0]

  test("key-mismatch: the key differs from the descriptor type", () => {
    const problems = blockDefinitionProblems({
      definitions: { [`${goodType}-renamed`]: good },
    })
    expect(problems.map((p) => p.rule)).toEqual(["key-mismatch", "key-mismatch"])
    expect(problems[0].message).toContain(`Block "${goodType}-renamed"`)
  })

  test("key-mismatch: the validator literal is not the type", () => {
    const problem = onlyProblem(
      blockDefinitionProblems({
        definitions: {
          sample: {
            type: "sample",
            validator: v.object({ type: v.literal("other") }),
          },
        },
      }),
      "key-mismatch"
    )
    expect(problem).toMatchObject({ type: "sample", field: "type" })
  })

  test("duplicate-type: two blocks and a manifest repeat", () => {
    const problems = blockDefinitionProblems({
      definitions: { [goodType]: good, other: good },
      entries: [{ type: goodType }, { type: goodType }],
    })
    expect(problems.filter((p) => p.rule === "duplicate-type")).toHaveLength(2)
  })

  test("reserved-field: presentationIdV1 in the descriptor", () => {
    const problem = onlyProblem(
      blockDefinitionProblems({
        definitions: {
          x: {
            type: "x",
            validator: v.object({
              type: v.literal("x"),
              presentationIdV1: v.optional(v.string()),
            }),
          },
        },
      }),
      "reserved-field"
    )
    expect(problem).toMatchObject({ type: "x", field: "presentationIdV1" })
  })
})

describe("reporting", () => {
  test("every problem in one set is reported and formatted", () => {
    const problems = contentTypeDefinitionProblems({
      definitions: {
        job: descriptor("job", {
          shared: { status: text().public() },
          localized: { summary: text().public() },
        }),
        post: descriptor("blog"),
      },
      activeTypes: ["nope"],
    })
    expect(problems.map((p) => p.rule).sort()).toEqual([
      "active-type",
      "key-mismatch",
      "missing-title",
      "reserved-field",
    ])
    const report = formatDefinitionProblems(problems)
    expect(report.split("\n")).toHaveLength(problems.length + 1)
    expect(report).toContain("found 4 problems")
  })
})
