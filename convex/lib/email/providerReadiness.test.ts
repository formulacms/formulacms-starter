import { describe, expect, test } from "vitest"
import { parseSmtpPort } from "./providerMetadata"
import {
  emailProviderEnvironmentReadiness,
  emailProviderEnvironmentStatus,
} from "./providerReadiness"

const smtpEnvironment = {
  EMAIL_SMTP_HOST: "mail.example.test",
  EMAIL_SMTP_USER: "test-user",
  EMAIL_SMTP_PASSWORD: "test-password",
}

describe("email provider environment readiness", () => {
  test("SMTP is ready without a port", () => {
    const status = emailProviderEnvironmentStatus("smtp", smtpEnvironment)
    expect(status.readiness).toBe("ready")
    expect(status.variables).toEqual([
      { name: "EMAIL_SMTP_HOST", required: true, present: true },
      { name: "EMAIL_SMTP_PORT", required: false, present: false },
      { name: "EMAIL_SMTP_USER", required: true, present: true },
      { name: "EMAIL_SMTP_PASSWORD", required: true, present: true },
    ])
  })

  test("SMTP needs setup while any required variable is missing", () => {
    for (const missing of Object.keys(smtpEnvironment)) {
      const environment = { ...smtpEnvironment, [missing]: undefined }
      expect(emailProviderEnvironmentReadiness("smtp", environment)).toBe(
        "needs_setup"
      )
    }
    expect(emailProviderEnvironmentReadiness("smtp", {})).toBe("needs_setup")
  })

  test("a blank value counts as absent", () => {
    const status = emailProviderEnvironmentStatus("smtp", {
      ...smtpEnvironment,
      EMAIL_SMTP_PASSWORD: "   ",
      EMAIL_SMTP_PORT: "  ",
    })
    expect(status.readiness).toBe("needs_setup")
    expect(
      status.variables.find(({ name }) => name === "EMAIL_SMTP_PASSWORD")
    ).toMatchObject({ present: false })
    expect(
      status.variables.find(({ name }) => name === "EMAIL_SMTP_PORT")
    ).toMatchObject({ present: false })
  })

  test("returns only names and flags, never a value", () => {
    const status = emailProviderEnvironmentStatus("smtp", {
      ...smtpEnvironment,
      EMAIL_SMTP_PORT: "2525",
    })
    const serialized = JSON.stringify(status)
    for (const value of ["mail.example.test", "test-user", "test-password", "2525"]) {
      expect(serialized).not.toContain(value)
    }
    for (const variable of status.variables) {
      expect(Object.keys(variable).sort()).toEqual(["name", "present", "required"])
    }
  })

  test("Resend is unchanged and an unknown provider is refused", () => {
    expect(emailProviderEnvironmentReadiness("resend", {})).toBe("needs_setup")
    expect(
      emailProviderEnvironmentReadiness("resend", { RESEND_API_KEY: " key " })
    ).toBe("ready")
    expect(
      emailProviderEnvironmentStatus("resend", { RESEND_API_KEY: "key" })
        .variables
    ).toEqual([{ name: "RESEND_API_KEY", required: true, present: true }])
    expect(() => emailProviderEnvironmentReadiness("postmark", {})).toThrow(
      "CMS_EMAIL_PROVIDER_UNREGISTERED"
    )
  })

  test("parses the port: default 465, whole numbers 1 to 65535, else null", () => {
    expect(parseSmtpPort(undefined)).toBe(465)
    expect(parseSmtpPort("")).toBe(465)
    expect(parseSmtpPort(" 587 ")).toBe(587)
    expect(parseSmtpPort("2525")).toBe(2525)
    for (const bad of ["0", "65536", "-1", "25.5", "abc", "587a", "1e3", "0x19"]) {
      expect(parseSmtpPort(bad)).toBeNull()
    }
  })
})
