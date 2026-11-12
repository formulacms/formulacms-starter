/**
 * Browser-safe metadata for email providers compiled into this application.
 *
 * This module deliberately contains no adapter factory, environment-variable
 * name, credential, or delivery client. E05 may project this metadata through
 * an owner-authorized API without pulling server implementations into a
 * browser bundle.
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
    id: "resend",
    label: "Resend",
    description: "Transactional email delivery through Resend.",
    registered: true,
    bundled: true,
    documentationUrl: "https://resend.com/docs",
  },
] as const satisfies readonly EmailProviderMetadata[]

/** The official starter registers exactly one production provider in E02. */
export const REGISTERED_EMAIL_PROVIDER_METADATA = Object.freeze(
  registeredEmailProviderMetadata
)

export type RegisteredEmailProviderId =
  (typeof REGISTERED_EMAIL_PROVIDER_METADATA)[number]["id"]

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
      "https://github.com/convex/better-auth/tree/main/examples/next",
  },
] as const satisfies readonly EmailProviderCatalogueEntry[])

export function isRegisteredEmailProviderId(
  value: string
): value is RegisteredEmailProviderId {
  return REGISTERED_EMAIL_PROVIDER_METADATA.some(
    (metadata) => metadata.id === value
  )
}
