import { describe, expect, test } from "vitest"
import { group, list, relation } from "./primitives"
import { collectRelationIds } from "./resolve"
import type { Slice } from "./index"
import type { Id } from "../../_generated/dataModel"

describe("collectRelationIds", () => {
  test("walks relation fields through groups and lists using the registry", () => {
    const postId = "post_1" as Id<"pages">
    const pageId = "page_1" as Id<"pages">
    const registry = {
      "test-slice": {
        primary: group({
          featured: relation({ pageTypes: ["post"] }),
        }),
        items: list(
          group({
            page: relation({ pageTypes: ["page"] }),
          })
        ),
      },
    }

    const slices = [
      {
        id: "slice_1",
        type: "test-slice",
        enabled: true,
        primary: { featured: { pageId: postId } },
        items: [{ page: { pageId } }, { page: { pageId } }],
      },
    ] as unknown as Slice[]

    expect(collectRelationIds(slices, registry as never)).toEqual([
      postId,
      pageId,
    ])
  })
})
