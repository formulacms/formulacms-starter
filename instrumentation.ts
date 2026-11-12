import { validateNextRuntimeEnv } from "@/lib/env"

export function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    validateNextRuntimeEnv()
  }
}
