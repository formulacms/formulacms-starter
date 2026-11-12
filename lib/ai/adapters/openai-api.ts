import { providerReceipt } from "../provider-receipt"
import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
} from "@ai-sdk/openai"
import { generateText } from "ai"
import type {
  AdapterGenerationRequest,
  ApiGenerationAdapter,
} from "../execution-contract"

export interface OpenAIAdapterOptions {
  readonly apiKey: string
}

export function createOpenAIGenerationAdapter(
  options: OpenAIAdapterOptions
): ApiGenerationAdapter {
  const openai = createOpenAI({ apiKey: options.apiKey })

  return {
    provider: "openai",
    async generate(request: AdapterGenerationRequest) {
      if (request.tuple.provider !== "openai") {
        throw new Error("OpenAI adapter received a different provider tuple.")
      }
      const result = await generateText({
        model: openai.responses(request.tuple.model),
        instructions: request.instructions,
        system: request.system,
        ...request.input,
        providerOptions: {
          openai: {
            reasoningEffort: request.tuple.reasoning.effort,
          } satisfies OpenAILanguageModelResponsesOptions,
        },
        abortSignal: request.abortSignal,
        maxRetries: request.maxRetries,
        maxOutputTokens: request.maxOutputTokens,
      } as Parameters<typeof generateText>[0])

      return providerReceipt("openai", result)
    },
  }
}
