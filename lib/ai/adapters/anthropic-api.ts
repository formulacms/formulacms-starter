import { providerReceipt } from "../provider-receipt"
import {
  createAnthropic,
  type AnthropicLanguageModelOptions,
} from "@ai-sdk/anthropic"
import { generateText } from "ai"
import type {
  AdapterGenerationRequest,
  ApiGenerationAdapter,
} from "../execution-contract"

export interface AnthropicAdapterOptions {
  readonly apiKey: string
}

export function createAnthropicGenerationAdapter(
  options: AnthropicAdapterOptions
): ApiGenerationAdapter {
  const anthropic = createAnthropic({ apiKey: options.apiKey })

  return {
    provider: "anthropic",
    async generate(request: AdapterGenerationRequest) {
      if (request.tuple.provider !== "anthropic") {
        throw new Error(
          "Anthropic adapter received a different provider tuple."
        )
      }
      const providerOptions =
        "reasoning" in request.tuple && request.tuple.reasoning
          ? {
              anthropic: {
                effort: request.tuple.reasoning.effort,
              } satisfies AnthropicLanguageModelOptions,
            }
          : undefined
      const result = await generateText({
        model: anthropic.messages(request.tuple.model),
        instructions: request.instructions,
        system: request.system,
        ...request.input,
        providerOptions,
        abortSignal: request.abortSignal,
        maxRetries: request.maxRetries,
        maxOutputTokens: request.maxOutputTokens,
      } as Parameters<typeof generateText>[0])

      return providerReceipt("anthropic", result)
    },
  }
}
