import { v, type Infer } from "convex/values"

/**
 * Browser-safe metadata for email providers compiled into this application.
 *
 * This module deliberately contains no adapter factory, credential value, or
 * delivery client. It declares the names of the deployment variables each
 * provider reads (names only: a value never appears here, in a result, or in
 * a log), so the owner API can report which names are present. E05 may
 * project this metadata through an owner-authorized API without pulling
 * server implementations into a browser bundle.
 */
export type EmailProviderMetadata<Id extends string = string> = Readonly<{
  id: Id
  label: string
  description: string
  registered: true
  bundled: boolean
  documentationUrl: string
}>

export type EmailProviderCatalogueEntry<Id extends string = string> = Readonly<{
  id: Id
  label: string
  description: string
  registered: boolean
  bundled: boolean
  documentationUrl: string
}>

const registeredEmailProviderMetadata = [
  {
    id: "smtp",
    label: "SMTP",
    description: "Send email through your own mail server with SMTP.",
    registered: true,
    bundled: true,
    documentationUrl: "https://nodemailer.com/smtp",
  },
  {
    id: "resend",
    label: "Resend",
    description: "Transactional email delivery through Resend.",
    registered: true,
    bundled: true,
    documentationUrl: "https://resend.com/docs",
  },
] as const satisfies readonly EmailProviderMetadata[]

/**
 * The official starter registers two production providers, in display order
 * (ADR-0054 amendment, 2026-11-14): SMTP first, then Resend.
 */
export const REGISTERED_EMAIL_PROVIDER_METADATA = Object.freeze(
  registeredEmailProviderMetadata
)

export type RegisteredEmailProviderId =
  (typeof REGISTERED_EMAIL_PROVIDER_METADATA)[number]["id"]

/**
 * Stored and returned provider id. The compile-time check below fails when
 * this union and the metadata list disagree.
 */
export const registeredEmailProviderIdValidator = v.union(
  v.literal("smtp"),
  v.literal("resend")
)

type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Compile-time proof: a mismatch makes `true` unassignable. */
export const registeredEmailProviderIdValidatorMatchesMetadata: SameType<
  Infer<typeof registeredEmailProviderIdValidator>,
  RegisteredEmailProviderId
> = true

/** Preselected in the owner screen until a provider is configured. */
export const EMAIL_DEFAULT_PROVIDER_ID: RegisteredEmailProviderId = "smtp"

export type EmailProviderEnvironmentDeclaration = Readonly<{
  name: string
  required: boolean
}>

/**
 * Deployment variable names each provider reads. Names only. The optional
 * port never blocks readiness.
 */
export const EMAIL_PROVIDER_ENVIRONMENT = Object.freeze({
  smtp: [
    { name: "EMAIL_SMTP_HOST", required: true },
    { name: "EMAIL_SMTP_PORT", required: false },
    { name: "EMAIL_SMTP_USER", required: true },
    { name: "EMAIL_SMTP_PASSWORD", required: true },
  ],
  resend: [{ name: "RESEND_API_KEY", required: true }],
} as const satisfies Record<
  RegisteredEmailProviderId,
  readonly EmailProviderEnvironmentDeclaration[]
>)

/** Implicit TLS port, used when EMAIL_SMTP_PORT is absent. */
export const EMAIL_SMTP_DEFAULT_PORT = 465

/**
 * Parse EMAIL_SMTP_PORT. A missing or blank value means the default port. A
 * present value must be a whole number from 1 to 65535; anything else gives
 * null, which the SMTP adapter reports as "could not connect" without
 * opening a connection.
 */
export function parseSmtpPort(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? ""
  if (trimmed === "") return EMAIL_SMTP_DEFAULT_PORT
  if (!/^[0-9]{1,5}$/.test(trimmed)) return null
  const port = Number(trimmed)
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * Deliberately small owner catalogue. Unregistered entries are documentation
 * links only; they cannot be selected or installed at runtime.
 */
export const EMAIL_PROVIDER_CATALOGUE = Object.freeze([
  ...REGISTERED_EMAIL_PROVIDER_METADATA,
  {
    id: "custom",
    label: "Custom provider",
    description:
      "Register a reviewed provider implementation in this application build.",
    registered: false,
    bundled: false,
    documentationUrl:
      "https://github.com/formulacms/formulacms-starter/blob/main/docs/starter/operations.md#register-another-email-provider",
  },
] as const satisfies readonly EmailProviderCatalogueEntry[])

export function isRegisteredEmailProviderId(
  value: string
): value is RegisteredEmailProviderId {
  return REGISTERED_EMAIL_PROVIDER_METADATA.some(
    (metadata) => metadata.id === value
  )
}
