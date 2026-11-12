import * as z from "zod"

/**
 * Field constraints for the contact form. Exported so the renderer's HTML
 * attributes and default error copy stay bound to the same numbers the Zod
 * schema enforces — a hardcoded `maxLength={120}` in JSX is a drift vector.
 */
export const CONTACT_LIMITS = {
  nameMin: 1,
  nameMax: 120,
  emailMax: 254,
  messageMin: 10,
  messageMax: 5_000,
  honeypotMax: 500,
} as const

/**
 * The persisted shape of a contact submission.
 *
 * This is the single enumeration of the stored fields: the `formSubmissions`
 * table validator, the admin row validator, and the mutation's insert all
 * derive from it (see `convex/lib/formPayloads.ts`). Adding a field here
 * reaches storage automatically instead of being silently dropped.
 */
export const contactPayloadSchema = z.object({
  name: z.string().trim().min(CONTACT_LIMITS.nameMin).max(CONTACT_LIMITS.nameMax),
  email: z.string().trim().max(CONTACT_LIMITS.emailMax).pipe(z.email()),
  message: z
    .string()
    .trim()
    .min(CONTACT_LIMITS.messageMin)
    .max(CONTACT_LIMITS.messageMax),
})

/**
 * The authored structure of the contact form.
 *
 * Both React Hook Form and the public Convex mutation consume this exact
 * schema. Request metadata and the signed IP proof are transport concerns,
 * so they deliberately live outside the form contract. `company_url` is the
 * honeypot: submitted, never persisted.
 */
export const contactFormSchema = contactPayloadSchema.extend({
  company_url: z.string().max(CONTACT_LIMITS.honeypotMax).optional(),
})

export type ContactPayload = z.output<typeof contactPayloadSchema>
export type ContactFormInput = z.input<typeof contactFormSchema>
export type ContactFormData = z.output<typeof contactFormSchema>
