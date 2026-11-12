// Shared dev/prod boundary for machine-local admin capabilities (slice
// creation, slice edits, the Development AI selection). `next build` / `next
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
