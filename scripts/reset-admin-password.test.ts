import { describe, expect, test } from "vitest"

import {
  collectResetRequest,
  convexTargetArgs,
  parseResetOptions,
  selfHostedEnvIsValid,
  type RecoveryPrompts,
} from "./reset-admin-password"

function prompts(...answers: string[]): RecoveryPrompts {
  let index = 0
  return {
    async text() {
      const answer = answers[index]
      index += 1
      if (answer === undefined) throw new Error("Missing prompt answer")
      return answer
    },
    async secret() {
      const answer = answers[index]
      index += 1
      if (answer === undefined) throw new Error("Missing prompt answer")
      return answer
    },
  }
}

describe("admin password reset command", () => {
  test("defaults to the selected development deployment", () => {
    const options = parseResetOptions([])
    expect(options).toEqual({
      deployment: undefined,
      envFile: undefined,
      help: false,
      prod: false,
      selfHosted: false,
    })
    expect(convexTargetArgs(options)).toEqual(["--deployment", "dev"])
  })

  test("accepts one explicit deployment selector", () => {
    const options = parseResetOptions(["--deployment", "team:project:staging"])
    expect(options).toEqual({
      deployment: "team:project:staging",
      envFile: undefined,
      help: false,
      prod: false,
      selfHosted: false,
    })
    expect(convexTargetArgs(options)).toEqual([
      "--deployment",
      "team:project:staging",
    ])
  })

  test("self-hosted mode requires an env file and selects it without deployment flags", () => {
    const options = parseResetOptions([
      "--self-hosted",
      "--env-file",
      "/private/backend.env",
    ])
    expect(options).toMatchObject({
      envFile: "/private/backend.env",
      selfHosted: true,
      prod: false,
      deployment: undefined,
    })
    expect(convexTargetArgs(options)).toEqual([])
  })

  test("self-hosted mode rejects deployment selectors and missing env files", () => {
    expect(() => parseResetOptions(["--self-hosted"])).toThrow(
      "requires --env-file"
    )
    expect(() =>
      parseResetOptions([
        "--self-hosted",
        "--env-file",
        "/private/backend.env",
        "--deployment",
        "dev",
      ])
    ).toThrow("cannot be combined")
    expect(() =>
      parseResetOptions([
        "--self-hosted",
        "--env-file",
        "/private/backend.env",
        "--prod",
      ])
    ).toThrow("cannot be combined")
  })

  test("validates self-hosted env values without returning credential contents", () => {
    expect(
      selfHostedEnvIsValid(
        "CONVEX_SELF_HOSTED_URL=http://localhost:3338\nCONVEX_SELF_HOSTED_ADMIN_KEY=private"
      )
    ).toBe(true)
    expect(
      selfHostedEnvIsValid(
        "CONVEX_SELF_HOSTED_URL=https://example.com\nCONVEX_SELF_HOSTED_ADMIN_KEY=private"
      )
    ).toBe(false)
    expect(
      selfHostedEnvIsValid(
        "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3338\nCONVEX_SELF_HOSTED_ADMIN_KEY=private\nCONVEX_DEPLOYMENT=dev"
      )
    ).toBe(false)
    expect(
      selfHostedEnvIsValid(
        "CONVEX_SELF_HOSTED_URL=http://localhost:3338\nCONVEX_SELF_HOSTED_ADMIN_KEY=\nCONVEX_DEPLOY_KEY=private"
      )
    ).toBe(false)
    expect(
      selfHostedEnvIsValid(
        "CONVEX_SELF_HOSTED_URL=http://localhost:3338\nCONVEX_SELF_HOSTED_ADMIN_KEY=private",
        { CONVEX_DEPLOYMENT: "dev", NODE_ENV: "test" }
      )
    ).toBe(false)
  })

  test("rejects dotenv colon-form deployment selectors in self-hosted env files", () => {
    const local =
      "CONVEX_SELF_HOSTED_URL=http://localhost:3338\nCONVEX_SELF_HOSTED_ADMIN_KEY=synthetic-admin-key"
    const selectors = [
      "CONVEX_DEPLOY_KEY: synthetic-deploy-key",
      "CONVEX_DEPLOYMENT: synthetic-deployment",
      "export CONVEX_DEPLOYMENT_TOKEN: synthetic-deployment-token",
      "  export CONVEX_DEPLOY_KEY: synthetic-exported-key # fixture",
    ]

    for (const selector of selectors) {
      expect(selfHostedEnvIsValid(`${local}\n${selector}`)).toBe(false)
    }
  })

  test("rejects a later dotenv colon URL that overrides the loopback URL", () => {
    expect(
      selfHostedEnvIsValid(
        "CONVEX_SELF_HOSTED_URL=http://localhost:3338\nCONVEX_SELF_HOSTED_ADMIN_KEY=synthetic-admin-key\nCONVEX_SELF_HOSTED_URL: https://example.invalid"
      )
    ).toBe(false)
  })

  test("does not treat assignment-like text in a multiline quoted value as a setting", () => {
    expect(
      selfHostedEnvIsValid(
        'CONVEX_SELF_HOSTED_URL=https://example.invalid\nCONVEX_SELF_HOSTED_ADMIN_KEY=synthetic-admin-key\nUNRELATED="before\nCONVEX_SELF_HOSTED_URL=http://localhost:3338\nafter"'
      )
    ).toBe(false)
  })

  test("production is only selected by the guarded production option", () => {
    expect(convexTargetArgs(parseResetOptions(["--prod"]))).toEqual(["--prod"])
  })

  test("rejects password arguments and conflicting targets", () => {
    expect(() => parseResetOptions(["--password", "not-allowed"])).toThrow(
      "Unknown option"
    )
    expect(() => parseResetOptions(["--prod", "--deployment", "dev"])).toThrow(
      "Choose either --prod or --deployment"
    )
  })

  test("collects and normalizes a confirmed password without logging it", async () => {
    const request = await collectResetRequest(
      parseResetOptions([]),
      prompts(
        "  Owner@Example.com ",
        "a correct horse battery staple",
        "a correct horse battery staple"
      )
    )

    expect(request).toEqual({
      email: "owner@example.com",
      newPassword: "a correct horse battery staple",
    })
  })

  test("requires an exact production confirmation before asking for secrets", async () => {
    await expect(
      collectResetRequest(
        parseResetOptions(["--prod"]),
        prompts("reset production")
      )
    ).rejects.toThrow('Confirmation did not match "RESET PRODUCTION"')
  })

  test("requires exact self-hosted confirmation before asking for secrets", async () => {
    await expect(
      collectResetRequest(
        parseResetOptions([
          "--self-hosted",
          "--env-file",
          "/private/backend.env",
        ]),
        prompts("RESET SELF-HOSTED")
      )
    ).rejects.toThrow('Confirmation did not match "RESET SELF-HOSTED LOCAL"')
  })

  test("accepts the exact self-hosted confirmation", async () => {
    const request = await collectResetRequest(
      parseResetOptions([
        "--self-hosted",
        "--env-file",
        "/private/backend.env",
      ]),
      prompts(
        "RESET SELF-HOSTED LOCAL",
        "owner@example.invalid",
        "a correct horse battery staple",
        "a correct horse battery staple"
      )
    )

    expect(request.email).toBe("owner@example.invalid")
    expect(request.newPassword).toBe("a correct horse battery staple")
  })

  test("requires exact confirmation for any named deployment", async () => {
    await expect(
      collectResetRequest(
        parseResetOptions(["--deployment", "team:project:staging"]),
        prompts("RESET staging")
      )
    ).rejects.toThrow('Confirmation did not match "RESET team:project:staging"')
  })

  test("rejects invalid email, mismatched passwords, and invalid lengths", async () => {
    await expect(
      collectResetRequest(
        parseResetOptions([]),
        prompts("not-an-email", "long-enough", "long-enough")
      )
    ).rejects.toThrow("valid owner email")

    await expect(
      collectResetRequest(
        parseResetOptions([]),
        prompts("owner@example.com", "long-enough", "different-value")
      )
    ).rejects.toThrow("Passwords do not match")

    await expect(
      collectResetRequest(
        parseResetOptions([]),
        prompts("owner@example.com", "short", "short")
      )
    ).rejects.toThrow("at least 8 characters")
  })
})
