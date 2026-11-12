import { ConvexError } from "convex/values"

// Only stable, explicitly allowed codes can select owner-visible copy.
const ERROR_KEYS = {
  SLUG_TAKEN: "slugTaken",
  MEDIA_FETCH_FAILED: "mediaFetchFailed",
  MEDIA_NOT_IMAGE: "mediaNotImage",
  MEDIA_TOO_LARGE: "mediaTooLarge",
  FOLDER_NAME_REQUIRED: "folderNameRequired",
  FOLDER_EXISTS: "folderExists",
  REDIRECT_DESTINATION_REQUIRED: "redirectDestinationRequired",
  REDIRECT_DESTINATION_AMBIGUOUS: "redirectDestinationAmbiguous",
  REDIRECT_SAME_PATH: "redirectSamePath",
  REDIRECT_EXISTS: "redirectExists",
  PILOT_PAGE_LIMIT: "pilotPageLimit",
  REVALIDATION_UNCONFIGURED: "revalidationUnconfigured",
  SITE_DESCRIPTION_LOCALE_NOT_ENABLED: "siteDescriptionLocaleNotEnabled",
  INVALID_EMAIL_OR_PASSWORD: "invalidCredentials",
  INVALID_PASSWORD: "invalidPassword",
  INVALID_EMAIL: "invalidEmail",
  PASSWORD_TOO_SHORT: "passwordTooShort",
  PASSWORD_TOO_LONG: "passwordTooLong",
  USER_ALREADY_EXISTS: "accountExists",
  invalid_url: "invalidUrl",
  forbidden_scheme: "urlScheme",
  forbidden_port: "urlPort",
  credentials: "urlCredentials",
  local_hostname: "urlLocal",
  non_global_ip: "urlIp",
  redirect_location_missing: "urlRedirectMissing",
  redirect_status_unsupported: "urlRedirectUnsupported",
  redirect_limit: "urlRedirectLimit",
} as const

const IMAGE_REASON_KEYS = {
  unsupported_mime: "imageUnsupported",
  mime_mismatch: "imageMimeMismatch",
  truncated: "imageTruncated",
  malformed: "imageMalformed",
  dimensions_missing: "imageDimensionsMissing",
  invalid_dimensions: "imageDimensionsInvalid",
  scan_limit: "imageScanLimit",
} as const

export type CaughtErrorKey =
  | (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS]
  | (typeof IMAGE_REASON_KEYS)[keyof typeof IMAGE_REASON_KEYS]

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined
}

/** Never display server/provider messages; unknown failures use the caller's translated fallback. */
export function caughtErrorMessage(
  error: unknown,
  translate: (key: CaughtErrorKey) => string,
  fallback: string
): string {
  const data: unknown = error instanceof ConvexError ? error.data : error
  const code = typeof data === "string" ? data : field(data, "code")
  if (code === "INVALID_IMAGE_DIMENSIONS") {
    const reason = field(data, "reason")
    if (
      typeof reason === "string" &&
      Object.hasOwn(IMAGE_REASON_KEYS, reason)
    ) {
      return translate(
        IMAGE_REASON_KEYS[reason as keyof typeof IMAGE_REASON_KEYS]
      )
    }
    return fallback
  }
  if (typeof code === "string" && Object.hasOwn(ERROR_KEYS, code)) {
    return translate(ERROR_KEYS[code as keyof typeof ERROR_KEYS])
  }
  return fallback
}
