// @vitest-environment node
import { describe, expect, test, vi } from "vitest"
import { readCodexCliCatalog } from "./codex-cli-catalog"

describe("readCodexCliCatalog", () => {
  test("walks model/list pagination and returns only validated capability fields", async () => {
    const requestPage = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "older-model",
            model: "older-model",
            displayName: "Older Model",
            description: "private description",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
            inputModalities: ["text"],
          },
        ],
        nextCursor: "page-2-private-cursor",
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "private" },
            ],
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: null,
      })

    const catalog = await readCodexCliCatalog({ requestPage, pageSize: 25 })

    expect(requestPage).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      limit: 25,
    })
    expect(requestPage).toHaveBeenNthCalledWith(2, {
      cursor: "page-2-private-cursor",
      limit: 25,
    })
    expect(catalog).toEqual({
      data: [
        {
          model: "older-model",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          inputModalities: ["text"],
          displayName: "Older Model",
        },
        {
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          inputModalities: ["text", "image"],
        },
      ],
    })
    expect(JSON.stringify(catalog)).not.toMatch(/private|cursor/u)
  })

  // The installed catalog (codex-cli 0.144.0-alpha.4) advertises efforts formulacms
  // does not model (`ultra`) and efforts above the owner's xhigh ceiling (`max`).
  // A vendor value we do not select must never be fatal to the whole read — that
  // would make every model unreadable because one of them knows more than we do.
  test("keeps the menu fields when well formed and drops them otherwise", async () => {
    const row = {
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      inputModalities: ["text"],
    }
    const catalog = await readCodexCliCatalog({
      requestPage: async () => ({
        data: [
          { ...row, model: "a", hidden: true, displayName: "A", defaultReasoningEffort: "medium", upgrade: "b" },
          // Above the ceiling, wrong types and empty strings are dropped, not fatal.
          { ...row, model: "b", hidden: "yes", displayName: "", defaultReasoningEffort: "ultra", upgrade: null },
          { ...row, model: "c" },
        ],
        nextCursor: null,
      }),
    })
    expect(catalog.data).toEqual([
      { ...row, supportedReasoningEfforts: [{ reasoningEffort: "high" }], model: "a", hidden: true, displayName: "A", defaultReasoningEffort: "medium", upgrade: "b" },
      { ...row, model: "b" },
      { ...row, model: "c" },
    ])
  })

  test("ignores unmodelled and above-ceiling efforts instead of failing the read", async () => {
    const catalog = await readCodexCliCatalog({
      requestPage: async () => ({
        data: [
          {
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
              { reasoningEffort: "xhigh" },
              { reasoningEffort: "max" },
              { reasoningEffort: "ultra" },
            ],
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: null,
      }),
    })

    expect(catalog.data[0].supportedReasoningEfforts).toEqual([
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
    ])
  })

  test("keeps a model whose every effort is above the ceiling, with no selectable effort", async () => {
    const catalog = await readCodexCliCatalog({
      requestPage: async () => ({
        data: [
          {
            model: "ceiling-only-model",
            supportedReasoningEfforts: [
              { reasoningEffort: "max" },
              { reasoningEffort: "ultra" },
            ],
            inputModalities: ["text"],
          },
          {
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: null,
      }),
    })

    // Empty-after-filter is legitimate, not malformed: the model stays in the
    // catalog with nothing selectable, and its neighbour still parses.
    expect(catalog.data[0]).toEqual({
      model: "ceiling-only-model",
      supportedReasoningEfforts: [],
      inputModalities: ["text"],
    })
    expect(catalog.data[1].model).toBe("gpt-5.6-sol")
  })

  test("treats an absent inputModalities list as declaring no modalities", async () => {
    const catalog = await readCodexCliCatalog({
      requestPage: async () => ({
        data: [
          {
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
        nextCursor: null,
      }),
    })

    // Optional in the installed app-server schema. Absence must not fail the
    // read; the image gate then fails closed for that model instead.
    expect(catalog.data[0].inputModalities).toEqual([])
  })

  test("fails closed on malformed pages and pagination loops without leaking payloads", async () => {
    const payloads: unknown[] = [
      { data: "token=secret" },
      {
        data: [
          {
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: 42 }],
            inputModalities: ["text"],
          },
        ],
      },
      {
        data: [
          {
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: "high",
            inputModalities: ["text"],
          },
        ],
      },
    ]

    for (const payload of payloads) {
      const error = await readCodexCliCatalog({
        requestPage: async () => payload,
      }).catch((value: unknown) => value)
      expect(error).toMatchObject({ category: "INVALID_OUTPUT" })
      expect(JSON.stringify(error)).not.toContain("secret")
    }

    const loopError = await readCodexCliCatalog({
      requestPage: async () => ({ data: [], nextCursor: "same-cursor" }),
    }).catch((value: unknown) => value)
    expect(loopError).toMatchObject({ category: "INVALID_OUTPUT" })
    expect(JSON.stringify(loopError)).not.toContain("same-cursor")
  })
})
