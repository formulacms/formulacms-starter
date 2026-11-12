import { describe, expect, test } from "vitest"
import { contactFormSchema, CONTACT_LIMITS, type ContactFormInput } from "./contact"

describe("contactFormSchema", () => {
  test("normalizes a valid contact submission", () => {
    expect(
      contactFormSchema.parse({
        name: "  Ada Lovelace  ",
        email: "  ADA@EXAMPLE.COM  ",
        message: "  Please tell me more about formulacms.  ",
        company_url: "",
      })
    ).toEqual({
      name: "Ada Lovelace",
      email: "ADA@EXAMPLE.COM",
      message: "Please tell me more about formulacms.",
      company_url: "",
    })
  })

  const validInput: ContactFormInput = {
    name: "Ada Lovelace",
    email: "ADA@EXAMPLE.COM",
    message: "Please tell me more about formulacms.",
    company_url: "",
  }

  test.each(["name", "email", "message"] as const)(
    "requires %s even when a caller bypasses the client form",
    (field) => {
      const input: Partial<ContactFormInput> = { ...validInput }
      delete input[field]
      expect(contactFormSchema.safeParse(input).success).toBe(false)
    }
  )

  test.each([
    ["whitespace-only name", { name: "   " }],
    ["overlong name", { name: "n".repeat(CONTACT_LIMITS.nameMax + 1) }],
    ["invalid email", { email: "ada@exam_ple.com" }],
    ["overlong email", { email: "a".repeat(CONTACT_LIMITS.emailMax + 1) }],
    ["short message after trimming", { message: "  short  " }],
    ["overlong message", { message: "m".repeat(CONTACT_LIMITS.messageMax + 1) }],
    ["overlong honeypot", { company_url: "h".repeat(CONTACT_LIMITS.honeypotMax + 1) }],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(
      contactFormSchema.safeParse({ ...validInput, ...overrides }).success
    ).toBe(false)
  })

  test("accepts the authored length boundaries without changing email case", () => {
    const email =
      `${"A".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`
    expect(email).toHaveLength(CONTACT_LIMITS.emailMax)
    expect(
      contactFormSchema.parse({
        name: "n".repeat(CONTACT_LIMITS.nameMax),
        email,
        message: "m".repeat(CONTACT_LIMITS.messageMax),
        company_url: "h".repeat(CONTACT_LIMITS.honeypotMax),
      }).email
    ).toBe(email)
    expect(() =>
      contactFormSchema.parse({
        ...validInput,
        name: "n".repeat(CONTACT_LIMITS.nameMin),
        message: "m".repeat(CONTACT_LIMITS.messageMin),
      })
    ).not.toThrow()
  })
})
