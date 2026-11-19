import { providerReceipt } from "../provider-receipt"
import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
} from "@ai-sdk/openai"
import { generateText } from "ai"
import {
  REASONING_EFFORTS,
  UnsupportedAdapterInputError,
  type AdapterGenerationRequest,
  type ApiGenerationAdapter,
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
      // The Responses options accept any effort string; only send one of ours.
      const effort = request.tuple.reasoning?.effort
      if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
        throw new UnsupportedAdapterInputError("The OpenAI SDK does not accept this effort.")
      }
      const result = await generateText({
        model: openai.responses(request.tuple.model),
        instructions: request.instructions,
        system: request.system,
        ...request.input,
        providerOptions: effort
          ? {
              openai: {
                reasoningEffort: effort,
              } satisfies OpenAILanguageModelResponsesOptions,
            }
          : undefined,
        abortSignal: request.abortSignal,
        maxRetries: request.maxRetries,
        maxOutputTokens: request.maxOutputTokens,
      } as Parameters<typeof generateText>[0])

      return providerReceipt("openai", result)
    },
  }
}
