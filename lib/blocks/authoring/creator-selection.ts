// Which provider, model and effort the Block creator runs with on a local
// development server. Pure: the caller reads the saved settings and the key
// presence, this function only decides. It imports nothing from the AI
// module so the block authoring code keeps its own boundary.

type Provider = "anthropic" | "openrouter" | "openai"

/** Same order as `AI_CONNECTION_ORDER` in `convex/lib/aiConfig.ts`. */
const CONNECTION_ORDER: readonly Provider[] = ["anthropic", "openrouter", "openai"]

export type SavedBlockCreatorTuple<Effort extends string = string> = {
  readonly provider: Provider
  readonly model: string
  readonly reasoning?: { readonly kind: "effort"; readonly effort: Effort }
}

export type BlockCreatorSelection<Effort extends string = string> =
  | {
      readonly provider: Provider
      readonly model?: string
      readonly effort?: Effort
      readonly keyPresent: boolean
    }
  | { readonly provider: null; readonly keyPresent: false }

/** A saved tuple is kept even when its key is missing; it never falls back
 *  to another provider. With nothing saved, the first provider with a key
 *  runs on each step's own default model and effort. */
export function resolveBlockCreatorSelection<Effort extends string>(
  saved: SavedBlockCreatorTuple<Effort> | undefined,
  keys: Readonly<Record<Provider, boolean>>
): BlockCreatorSelection<Effort> {
  if (saved) {
    return {
      provider: saved.provider,
      model: saved.model,
      ...(saved.reasoning ? { effort: saved.reasoning.effort } : {}),
      keyPresent: keys[saved.provider],
    }
  }
  const provider = CONNECTION_ORDER.find((candidate) => keys[candidate])
  return provider
    ? { provider, keyPresent: true }
    : { provider: null, keyPresent: false }
}
