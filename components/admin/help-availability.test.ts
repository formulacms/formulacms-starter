import { describe, expect, test } from "vitest"
import { canUseHelpAssistant } from "./help-availability"

describe("canUseHelpAssistant", () => {
  const permission = {
    permissionsResolved: true,
    hasContentAiPermission: true,
  }

  test("uses Production only when the effective Development route is Off", () => {
    expect(
      canUseHelpAssistant({
        effectiveRoute: { kind: "production" },
        productionConfigured: true,
        ...permission,
      })
    ).toBe(true)
    expect(
      canUseHelpAssistant({
        effectiveRoute: { kind: "production" },
        productionConfigured: false,
        ...permission,
      })
    ).toBe(false)
  })

  test("allows a ready selected-local route without consulting Production", () => {
    expect(
      canUseHelpAssistant({
        effectiveRoute: { kind: "selected-ready", engine: "claude" },
        productionConfigured: false,
        ...permission,
      })
    ).toBe(true)
  })

  test("fails closed for selected-local setup problems even when Production is configured", () => {
    expect(
      canUseHelpAssistant({
        effectiveRoute: {
          kind: "selected-needs-setup",
          engine: "openrouter",
        },
        productionConfigured: true,
        ...permission,
      })
    ).toBe(false)
  })

  test("requires resolved content permission for every effective route", () => {
    for (const permissions of [
      { permissionsResolved: false, hasContentAiPermission: true },
      { permissionsResolved: true, hasContentAiPermission: false },
    ]) {
      expect(
        canUseHelpAssistant({
          effectiveRoute: { kind: "selected-ready", engine: "claude" },
          productionConfigured: true,
          ...permissions,
        })
      ).toBe(false)
    }
  })
})
