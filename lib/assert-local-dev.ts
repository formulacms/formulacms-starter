// Shared dev/prod boundary for machine-local admin capabilities (block
// creation, block edits, the Development AI selection). `next build` / `next
// start` always run with NODE_ENV=production, so "not production" is the
// platform's own signal for a developer-run server. Keeping the predicate in
// one place guarantees every gated surface flips together if the definition
// of "local" ever changes.

export function isLocalDevelopment(): boolean {
  return process.env.NODE_ENV !== "production"
}

export function assertLocalDevelopment(capability: string): void {
  if (!isLocalDevelopment()) {
    throw new Error(`${capability} is only available in local development.`)
  }
}

// The local tool route (Claude Code `claude -p`, Codex `codex exec`) runs the
// owner's own command-line tool on the owner's computer (ADR-0057 step 1).
// The engine guard refuses it outside local development. Request-scoped
// callers also require a loopback request (`lib/local-request.ts`).
export const LOCAL_TOOL_ENGINES = Object.freeze(["claude", "codex"] as const)
export type LocalToolEngine = (typeof LOCAL_TOOL_ENGINES)[number]

export function isLocalToolEngine(engine: string): engine is LocalToolEngine {
  return (LOCAL_TOOL_ENGINES as readonly string[]).includes(engine)
}

export function assertLocalToolRoute(engine: string): void {
  if (isLocalToolEngine(engine) && !isLocalDevelopment()) {
    throw new Error(
      "Local AI tools run only in local development. Use an API connection on the live site."
    )
  }
}
