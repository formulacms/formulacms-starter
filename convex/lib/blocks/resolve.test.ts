import { describe, expect, test } from "vitest"
import { group, list, relation } from "./primitives"
import { collectRelationIds } from "./resolve"
import type { Block } from "./index"
import type { Id } from "../../_generated/dataModel"

describe("collectRelationIds", () => {
  test("walks relation fields through groups and lists using the registry", () => {
    const postId = "post_1" as Id<"pages">
    const pageId = "page_1" as Id<"pages">
    const registry = {
      "test-block": {
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

    const blocks = [
      {
        id: "block_1",
        type: "test-block",
        enabled: true,
        primary: { featured: { pageId: postId } },
        items: [{ page: { pageId } }, { page: { pageId } }],
      },
    ] as unknown as Block[]

    expect(collectRelationIds(blocks, registry as never)).toEqual([
      postId,
      pageId,
    ])
  })
})
