import { describe, expect, test } from "vitest"
import {
  openRouterCatalogCapability,
  parseOpenRouterCatalog,
} from "./openrouter-catalog"

describe("parseOpenRouterCatalog", () => {
  test("normalizes text models, capabilities, and per-million pricing", () => {
    const result = parseOpenRouterCatalog({
      data: [
        {
          id: "vendor/model",
          name: "Vendor Model",
          pricing: { prompt: "0.0000005", completion: "0.000002" },
          supported_parameters: ["reasoning", "structured_outputs"],
          architecture: {
            input_modalities: ["text", "image", "unknown"],
            output_modalities: ["text"],
          },
        },
      ],
    })

    expect(result).toEqual([
      {
        modelId: "vendor/model",
        name: "Vendor Model",
        inputModalities: ["text", "image"],
        structuredOutput: true,
        reasoningEfforts: ["high", "medium", "low"],
        inputPerM: 0.5,
        outputPerM: 2,
        ceilingInputPerM: 0.5,
        ceilingOutputPerM: 2,
      },
    ])
    expect(openRouterCatalogCapability(result[0]!)).toMatchObject({
      structuredOutput: true,
      pricing: { inputPerM: 0.5, outputPerM: 2 },
      reasoning: { kind: "effort" },
    })
  })

  test("does not label missing pricing as free", () => {
    const [model] = parseOpenRouterCatalog({
      data: [{ id: "vendor/unpriced" }],
    })
    expect(model).not.toHaveProperty("inputPerM")
    expect(model).not.toHaveProperty("outputPerM")
  })

  test("filters non-text models and rejects an unusable response", () => {
    expect(() =>
      parseOpenRouterCatalog({
        data: [
          {
            id: "vendor/image-only",
            architecture: { output_modalities: ["image"] },
          },
        ],
      })
    ).toThrow("no text-output models")
  })

  test("rejects malformed and duplicate entries", () => {
    expect(() =>
      parseOpenRouterCatalog({ data: [{ name: "Missing id" }] })
    ).toThrow("without an id")
    expect(() =>
      parseOpenRouterCatalog({ data: [{ id: "same" }, { id: "same" }] })
    ).toThrow("duplicate model id")
  })
})
