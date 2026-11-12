import { providerReceipt } from "../provider-receipt"
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider"
import { generateText } from "ai"
import type {
  ApiGenerationAdapter,
  AdapterGenerationRequest,
} from "../execution-contract"

export interface OpenRouterAdapterOptions {
  readonly apiKey: string
  readonly appName: string
  readonly appUrl: string
}

export function createOpenRouterGenerationAdapter(
  options: OpenRouterAdapterOptions
): ApiGenerationAdapter {
  const openrouter = createOpenRouter({
    apiKey: options.apiKey,
    appName: options.appName,
    appUrl: options.appUrl,
  })

  return {
    provider: "openrouter",
    async generate(request: AdapterGenerationRequest) {
      if (request.tuple.provider !== "openrouter") {
        throw new Error(
          "OpenRouter adapter received a different provider tuple."
        )
      }
      const reasoning =
        request.tuple.mode === "catalog" && request.tuple.reasoning
          ? { reasoning: { effort: request.tuple.reasoning.effort } }
          : {}
      const model = openrouter.chat(request.tuple.model, {
        provider: {
          allow_fallbacks: false,
          require_parameters: true,
        },
        ...reasoning,
      } as OpenRouterChatSettings)

      const result = await generateText({
        model,
        instructions: request.instructions,
        system: request.system,
        ...request.input,
        abortSignal: request.abortSignal,
        maxRetries: request.maxRetries,
        maxOutputTokens: request.maxOutputTokens,
      } as Parameters<typeof generateText>[0])

      return providerReceipt("openrouter", result)
    },
  }
}
