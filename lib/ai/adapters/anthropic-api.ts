import { providerReceipt } from "../provider-receipt"
import {
  createAnthropic,
  type AnthropicLanguageModelOptions,
} from "@ai-sdk/anthropic"
import { generateText } from "ai"
import {
  UnsupportedAdapterInputError,
  type AdapterGenerationRequest,
  type ApiGenerationAdapter,
  type ReasoningEffort,
} from "../execution-contract"

type AnthropicSdkEffort = NonNullable<AnthropicLanguageModelOptions["effort"]>
const ANTHROPIC_SDK_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly AnthropicSdkEffort[]

function isAnthropicSdkEffort(effort: ReasoningEffort): effort is AnthropicSdkEffort {
  return (ANTHROPIC_SDK_EFFORTS as readonly ReasoningEffort[]).includes(effort)
}

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
      const effort = request.tuple.reasoning?.effort
      if (effort !== undefined && !isAnthropicSdkEffort(effort)) {
        throw new UnsupportedAdapterInputError("The Anthropic SDK does not accept this effort.")
      }
      const providerOptions = effort
        ? {
            anthropic: { effort } satisfies AnthropicLanguageModelOptions,
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
