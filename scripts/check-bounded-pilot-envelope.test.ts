import { describe, expect, test } from "vitest"
import {
  assertBoundedPilotCapacityAlert,
  assertBoundedPilotReleaseGate,
  checkBoundedPilotCapacityAlert,
  checkBoundedPilotReleaseGate,
  parseBoundedPilotReleaseGate,
} from "./check-bounded-pilot-envelope"

describe("bounded pilot release gate", () => {
  test("accepts a safe Convex response, including an informational prefix", () => {
    expect(() =>
      checkBoundedPilotReleaseGate(
        [
          "Connected to configured deployment.",
          '{"withinEnvelope":true,"totalPagesBelowCap":true,"publishedPagesBelowCap":true,"totalPagesAtOrAboveWarningThreshold":false,"publishedPagesAtOrAboveWarningThreshold":false}',
        ].join("\n")
      )
    ).not.toThrow()
  })

  test("fails closed when either bounded read has reached its sentinel", () => {
    const gate = parseBoundedPilotReleaseGate(
      '{"withinEnvelope":false,"totalPagesBelowCap":false,"publishedPagesBelowCap":true,"totalPagesAtOrAboveWarningThreshold":true,"publishedPagesAtOrAboveWarningThreshold":false}'
    )
    expect(() => assertBoundedPilotReleaseGate(gate)).toThrow(
      /Bounded pilot release gate failed/
    )
  })

  test("signals capacity at the early-warning threshold without blocking a safe release", () => {
    const gate = parseBoundedPilotReleaseGate(
      '{"withinEnvelope":true,"totalPagesBelowCap":true,"publishedPagesBelowCap":true,"totalPagesAtOrAboveWarningThreshold":true,"publishedPagesAtOrAboveWarningThreshold":false}'
    )

    expect(() => assertBoundedPilotReleaseGate(gate)).not.toThrow()
    expect(() => assertBoundedPilotCapacityAlert(gate)).toThrow(
      /Bounded pilot capacity alert.*total pages/i
    )
  })

  test("provides a dedicated nonzero capacity signal before the sentinel", () => {
    expect(() =>
      checkBoundedPilotCapacityAlert(
        '{"withinEnvelope":true,"totalPagesBelowCap":true,"publishedPagesBelowCap":true,"totalPagesAtOrAboveWarningThreshold":false,"publishedPagesAtOrAboveWarningThreshold":false}'
      )
    ).not.toThrow()

    expect(() =>
      checkBoundedPilotCapacityAlert(
        '{"withinEnvelope":true,"totalPagesBelowCap":true,"publishedPagesBelowCap":true,"totalPagesAtOrAboveWarningThreshold":false,"publishedPagesAtOrAboveWarningThreshold":true}'
      )
    ).toThrow(/Bounded pilot capacity alert.*published pages/i)
  })

  test("fails closed on malformed or shape-incompatible CLI output", () => {
    expect(() => parseBoundedPilotReleaseGate("not json")).toThrow(
      /Could not parse/
    )
    expect(() =>
      parseBoundedPilotReleaseGate('{"withinEnvelope":true}')
    ).toThrow(/Could not parse/)
  })
})
