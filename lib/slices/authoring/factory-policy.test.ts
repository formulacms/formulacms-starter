import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { primitiveToSpec } from "./scaffold"
import { specToPrimitive } from "./scaffold"
import { assertNewSlicePolicy } from "./factory-policy"
import { parseSliceSpecJson, persistSliceSpec } from "./persist"

const roots: string[] = []

function parse(primaryFields: Record<string, unknown>, extra = {}) {
  return parseSliceSpecJson(
    JSON.stringify({
      type: "policy-fixture",
      label: "Policy fixture",
      description: "Factory policy test fixture",
      icon: "Layers",
      group: "misc",
      primary: { kind: "group", fields: primaryFields },
      ...extra,
    })
  )
}

const sliceTitle = {
  kind: "richText",
  config: {
    contract: "title",
    heading: { role: "sliceTitle" },
  },
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("new Slice Type factory policy", () => {
  test("refuses top-level items before persistence writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-policy-"))
    roots.push(root)
    const spec = parse(
      { title: sliceTitle },
      { items: { item: { kind: "ref", ref: "button" }, max: 2 } }
    )

    await expect(persistSliceSpec(spec, root)).rejects.toThrow(
      /named repeating list under "primary"/
    )
    expect(await readdir(root)).toEqual([])
  })

  test("accepts named primary lists and explicit title roles", () => {
    const spec = parse({
      title: sliceTitle,
      ctas: {
        kind: "list",
        item: { kind: "ref", ref: "button" },
        config: { max: 4 },
      },
    })

    expect(() => assertNewSlicePolicy(spec)).not.toThrow()
  })

  test("requires title roles and resolves heading floors through list paths", () => {
    const accepted = parse({
      cards: {
        kind: "list",
        item: {
          kind: "group",
          fields: {
            title: {
              kind: "richText",
              config: {
                contract: "title",
                heading: { role: "itemTitle" },
              },
            },
            body: {
              kind: "richText",
              config: {
                profile: "basic",
                headingFloor: { parent: "primary.cards[3].title" },
              },
            },
          },
        },
        config: { max: 4 },
      },
    })
    expect(() => assertNewSlicePolicy(accepted)).not.toThrow()

    const missingRole = parse({
      title: { kind: "richText", config: { contract: "title" } },
    })
    expect(() => assertNewSlicePolicy(missingRole)).toThrow(/heading\.role/)

    const missingFloor = parse({
      title: sliceTitle,
      body: { kind: "richText", config: { profile: "full" } },
    })
    expect(() => assertNewSlicePolicy(missingFloor)).toThrow(
      /must declare headingFloor.parent/
    )

    const unknownParent = parse({
      title: sliceTitle,
      body: {
        kind: "richText",
        config: {
          profile: "basic",
          headingFloor: { parent: "primary.missing" },
        },
      },
    })
    expect(() => assertNewSlicePolicy(unknownParent)).toThrow(
      /must resolve to a title field/
    )
  })

  test("rejects raw rich-text config.as while legacy items still round-trip", () => {
    expect(() =>
      parse({
        title: {
          kind: "richText",
          config: { profile: "inline", as: "h2" },
        },
      })
    ).toThrow(/config\.as is not supported/)

    const legacy = parse(
      { quote: { kind: "richText", config: { profile: "inline" } } },
      {
        items: {
          item: { kind: "group", fields: { author: { kind: "text" } } },
          max: 3,
        },
      }
    )
    expect(legacy.items).toBeDefined()
    expect(primitiveToSpec(specToPrimitive(legacy.primary))).toEqual(
      legacy.primary
    )
    expect(JSON.stringify(legacy)).not.toContain("newCreation")
  })
})

test("factory policy refuses conflicting contract/profile through the sole resolver", () => {
  const body = {
    kind: "richText",
    config: {
      contract: "basic",
      profile: "inline",
      headingFloor: { parent: "primary.title" },
    },
  }
  expect(() =>
    assertNewSlicePolicy(parse({ title: sliceTitle, body }))
  ).toThrow(/conflicts/)
  const spec = parse({
    title: sliceTitle,
    body: {
      kind: "richText",
      config: { contract: "basic", headingFloor: { parent: "primary.title" } },
    },
  })
  const parsedBody = spec.primary.fields.body
  if (parsedBody.kind !== "richText") throw new Error("Expected rich text body")
  parsedBody.config.profile = "inline"
  expect(() => assertNewSlicePolicy(spec)).toThrow(/conflicts/)
})
