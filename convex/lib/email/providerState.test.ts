import { describe, expect, test } from "vitest"
import { isRegisteredEmailProviderId } from "./providerMetadata"
import {
  createRegisteredEmailProviderState,
  emailProviderStateFromRows,
  freshEmailProviderState,
  toEmailProviderClientState,
  type PersistedEmailProviderState,
} from "./providerState"

describe("FormulaCMS email provider state", () => {
  test("resolves missing state to the non-delivering fallback", () => {
    const state = emailProviderStateFromRows([])
    expect(state).toEqual(freshEmailProviderState())
    expect(toEmailProviderClientState(state)).toEqual({
      configuredProviderId: null,
      activeProviderId: null,
      readiness: "fallback",
      configurationVersion: 0,
    })
  })

  test("distinguishes active-provider setup from readiness", () => {
    const state = createRegisteredEmailProviderState({
      providerId: "resend",
      isRegistered: isRegisteredEmailProviderId,
      configuration: {},
      sender: { address: "sender@example.test", name: "FormulaCMS" },
      configurationVersion: 3,
      updatedAt: 100,
    })

    expect(toEmailProviderClientState(state, "needs_setup")).toMatchObject({
      configuredProviderId: "resend",
      activeProviderId: "resend",
      readiness: "needs_setup",
      configurationVersion: 3,
    })
    expect(toEmailProviderClientState(state, "ready")).toEqual({
      configuredProviderId: "resend",
      activeProviderId: "resend",
      readiness: "ready",
      sender: { address: "sender@example.test", name: "FormulaCMS" },
      configurationVersion: 3,
    })
  })

  test("rejects unknown activation and corrupt singleton state", () => {
    expect(() =>
      createRegisteredEmailProviderState({
        providerId: "unknown",
        isRegistered: isRegisteredEmailProviderId,
        configuration: {},
        sender: { address: "sender@example.test" },
        configurationVersion: 1,
        updatedAt: 100,
      })
    ).toThrow("CMS_EMAIL_PROVIDER_UNREGISTERED")

    const valid = createRegisteredEmailProviderState({
      providerId: "resend",
      isRegistered: isRegisteredEmailProviderId,
      configuration: {},
      sender: { address: "sender@example.test" },
      configurationVersion: 1,
      updatedAt: 100,
    })
    expect(() => emailProviderStateFromRows([valid, valid])).toThrow(
      "CMS_EMAIL_PROVIDER_STATE_INVALID"
    )
    expect(() =>
      emailProviderStateFromRows([
        {
          ...valid,
          configurationVersion: -1,
        } as PersistedEmailProviderState,
      ])
    ).toThrow("CMS_EMAIL_PROVIDER_STATE_INVALID")
  })

  test("projects only bounded non-secret state", () => {
    const state = createRegisteredEmailProviderState({
      providerId: "resend",
      isRegistered: isRegisteredEmailProviderId,
      configuration: {},
      sender: { address: "sender@example.test" },
      configurationVersion: 1,
      updatedAt: 100,
    })
    const client = toEmailProviderClientState(state, "ready")

    expect(Object.keys(client).sort()).toEqual([
      "activeProviderId",
      "configurationVersion",
      "configuredProviderId",
      "readiness",
      "sender",
    ])
    expect(JSON.stringify(client)).not.toContain("secret")
    expect(JSON.stringify(client)).not.toContain("API_KEY")
    expect(client).not.toHaveProperty("environment")
    expect(client).not.toHaveProperty("factory")
  })
})
