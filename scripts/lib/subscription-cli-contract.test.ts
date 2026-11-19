// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  SubscriptionCliGenerationError,
  makeSubscriptionCliError,
  processFailureCategory,
} from "./subscription-cli-contract"

const selected = {
  lane: "local-build" as const,
  engine: "claude-cli" as const,
  model: "sonnet",
  effort: "high" as const,
}

describe("subscription CLI normalized contract", () => {
  test.each([
    ["missing-cli", "CONFIG_MISSING"],
    ["auth-required", "AUTH_REQUIRED"],
    ["quota-exhausted", "QUOTA_EXHAUSTED"],
    ["rate-limited", "RATE_LIMITED"],
    ["unsupported-capability", "UNSUPPORTED_CAPABILITY"],
    ["input-too-large", "INPUT_TOO_LARGE"],
    ["timeout", "TIMEOUT"],
    ["cancelled", "CANCELLED"],
    ["local-process-failed", "LOCAL_PROCESS_FAILED"],
  ] as const)("maps %s onto the shared category %s", (kind, category) => {
    expect(processFailureCategory(kind)).toBe(category)
  })

  test("serializes only safe selected identity and recovery metadata", () => {
    const error = makeSubscriptionCliError("AUTH_REQUIRED", {
      selected,
      attempts: 1,
      phase: "slice-spec",
    })

    expect(error).toBeInstanceOf(SubscriptionCliGenerationError)
    expect(error.toJSON()).toEqual({
      category: "AUTH_REQUIRED",
      message: "The selected local AI CLI requires authentication.",
      selected,
      attempts: 1,
      phase: "slice-spec",
      retryable: false,
      nextAction: "authenticate-provider",
    })
    expect(JSON.stringify(error)).not.toContain("token")
    expect(JSON.stringify(error)).not.toContain("session")
  })

  test("uses the local CLI recovery action for a missing executable", () => {
    expect(
      makeSubscriptionCliError("CONFIG_MISSING", {
        selected: { ...selected, engine: "codex-cli" },
        attempts: 0,
        phase: "renderer-jsx",
      }).toJSON()
    ).toMatchObject({
      category: "CONFIG_MISSING",
      nextAction: "check-local-cli",
      selected: { engine: "codex-cli" },
    })
  })
})
