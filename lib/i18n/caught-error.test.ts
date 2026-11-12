import { describe, expect, it } from "vitest"
import { ConvexError } from "convex/values"
import { createTranslator } from "next-intl"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { BOUNDED_PILOT_MAX_PAGE_COUNT } from "@/convex/lib/pilotEnvelope"
import { caughtErrorMessage } from "./caught-error"

const codeKeys = {
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
const reasons = {
  unsupported_mime: "imageUnsupported",
  mime_mismatch: "imageMimeMismatch",
  truncated: "imageTruncated",
  malformed: "imageMalformed",
  dimensions_missing: "imageDimensionsMissing",
  invalid_dimensions: "imageDimensionsInvalid",
  scan_limit: "imageScanLimit",
} as const

for (const [locale, messages] of [
  ["en", en],
  ["fr", fr],
] as const) {
  describe(`caught error translated display ${locale}`, () => {
    const t = createTranslator({ locale, messages, namespace: "caughtErrors" })
    const fallback =
      locale === "fr"
        ? "Impossible d’effectuer cette action."
        : "Could not complete this action."
    for (const [code, key] of Object.entries(codeKeys)) {
      it(`translates ${code} without diagnostic prose`, () => {
        expect(
          caughtErrorMessage(
            new ConvexError({ code, message: "PRIVATE SERVER DETAIL" }),
            t,
            fallback
          )
        ).toBe(t(key as keyof typeof messages.caughtErrors))
        expect(
          caughtErrorMessage(
            { code, message: "PRIVATE PROVIDER DETAIL" },
            t,
            fallback
          )
        ).toBe(t(key as keyof typeof messages.caughtErrors))
      })
    }
    for (const [reason, key] of Object.entries(reasons)) {
      it(`translates existing image reason ${reason}`, () => {
        expect(
          caughtErrorMessage(
            new ConvexError({
              code: "INVALID_IMAGE_DIMENSIONS",
              reason,
              message: "PNG diagnostic",
            }),
            t,
            fallback
          )
        ).toBe(t(key as keyof typeof messages.caughtErrors))
      })
    }
    it.each([
      new Error("Provider secret detail"),
      new ConvexError("Unknown server detail"),
      new ConvexError({ code: "UNKNOWN", message: "secret" }),
      { message: "secret" },
      null,
      undefined,
      { code: "constructor" },
      { code: "toString" },
      { code: "INVALID_IMAGE_DIMENSIONS", reason: "constructor" },
      { code: "INVALID_IMAGE_DIMENSIONS", reason: "unknown" },
      { code: "INVALID_IMAGE_DIMENSIONS" },
    ])("uses only operation fallback for unknown error %#", (error) => {
      expect(caughtErrorMessage(error, t, fallback)).toBe(fallback)
    })
    it("accepts a stable Convex string code without displaying other strings", () => {
      expect(
        caughtErrorMessage(new ConvexError("SLUG_TAKEN"), t, fallback)
      ).toBe(t("slugTaken"))
    })
    it("the page limit message names the server's limit", () => {
      expect(t("pilotPageLimit").match(/\d+/g)).toEqual([
        String(BOUNDED_PILOT_MAX_PAGE_COUNT),
      ])
    })
    it("does not match a code embedded in arbitrary prose", () => {
      expect(
        caughtErrorMessage(new Error("secret SLUG_TAKEN secret"), t, fallback)
      ).toBe(fallback)
    })
  })
}
