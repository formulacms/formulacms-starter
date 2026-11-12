import type { ApiProvider } from "./execution-contract"

export type AiConnectionMethod = "api-key" | "subscription"

export type AiConnectionIssue =
  | "missing-key"
  | "missing-cli"
  | "signed-out"
  | "wrong-auth-method"
  | "credentials-rejected"
  | "wrong-key-type"
  | "quota-exhausted"
  | "rate-limited"
  | "timeout"
  | "network"
  | "service-error"
  | "command-failed"

export type AiConnectionCheck =
  | { state: "authenticated"; method: AiConnectionMethod }
  | { state: "not-configured"; issue: AiConnectionIssue }
  | { state: "invalid"; issue: AiConnectionIssue }
  | { state: "unreachable"; issue: AiConnectionIssue }

export type AiConnectionStatus =
  | { state: "off" }
  | { state: "configured"; method: "api-key" }
  | { state: "checking" }
  | AiConnectionCheck

export type FetchLike = typeof fetch

const API_CHECKS: Record<
  ApiProvider,
  (apiKey: string) => { url: string; headers: Record<string, string> }
> = {
  openrouter: (apiKey) => ({
    url: "https://openrouter.ai/api/v1/key",
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  anthropic: (apiKey) => ({
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    },
  }),
  openai: (apiKey) => ({
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Validate one API credential without generating content. Provider response
 * bodies are never returned or included in errors; only this normalized state
 * crosses into Settings.
 */
export async function validateApiConnection(
  provider: ApiProvider,
  apiKey: string | undefined,
  options: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<AiConnectionCheck> {
  const credential = apiKey?.trim()
  if (!credential) return { state: "not-configured", issue: "missing-key" }

  const request = API_CHECKS[provider](credential)
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )

  try {
    const response = await (options.fetch ?? fetch)(request.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...request.headers,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    })

    if (response.ok) {
      if (provider === "openrouter") {
        const issue = await openRouterKeyIssue(response)
        if (issue) return { state: "invalid", issue }
      }
      return { state: "authenticated", method: "api-key" }
    }
    if (response.status === 401 || response.status === 403) {
      return { state: "invalid", issue: "credentials-rejected" }
    }
    if (response.status === 429) {
      return { state: "unreachable", issue: "rate-limited" }
    }
    return { state: "unreachable", issue: "service-error" }
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      return { state: "unreachable", issue: "timeout" }
    }
    return { state: "unreachable", issue: "network" }
  } finally {
    clearTimeout(timeout)
  }
}

async function openRouterKeyIssue(
  response: Response
): Promise<"wrong-key-type" | "quota-exhausted" | null> {
  try {
    const body = (await response.json()) as {
      data?: {
        is_management_key?: unknown
        is_provisioning_key?: unknown
        limit_remaining?: unknown
      }
    }
    const data = body.data
    if (
      data?.is_management_key === true ||
      data?.is_provisioning_key === true
    ) {
      return "wrong-key-type"
    }
    if (data?.limit_remaining === 0) return "quota-exhausted"
  } catch {
    // A successful response already authenticated the credential. Treat an
    // unfamiliar optional metadata shape as authenticated, not as a failure.
  }
  return null
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}
