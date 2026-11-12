/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest"
import { ConvexError } from "convex/values"
import { createTranslator } from "next-intl"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import schema from "./schema"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import {
  caughtErrorMessage,
  type CaughtErrorKey,
} from "@/lib/i18n/caught-error"

const modules = import.meta.glob("./**/*.ts")
const owner = {
  subject: "error-owner",
  tokenIdentifier: "https://convex.test|error-owner",
  email: "owner@example.com",
}
function app() {
  const t = convexTest({ schema, modules, ownerIdentity: owner })
  rateLimiterTest.register(t)
  return t.withIdentity(owner)
}
async function assertTranslated(
  promise: Promise<unknown>,
  code: string,
  key: CaughtErrorKey,
  reason?: string
) {
  const error = await promise.then(
    () => {
      throw new Error("expected refusal")
    },
    (error) => error
  )
  expect(error).toBeInstanceOf(ConvexError)
  expect(error.data).toMatchObject({ code, ...(reason ? { reason } : {}) })
  for (const [locale, messages] of [
    ["en", en],
    ["fr", fr],
  ] as const) {
    const t = createTranslator({ locale, messages, namespace: "caughtErrors" })
    expect(caughtErrorMessage(error, t, "fallback")).toBe(t(key))
  }
}

describe("registered media errors preserve stable codes through translated consumers", () => {
  it.each([
    ["not a URL", "invalid_url", "invalidUrl"],
    ["ftp://cdn.example.com/image.png", "forbidden_scheme", "urlScheme"],
    [
      "https://user:pass@cdn.example.com/image.png",
      "credentials",
      "urlCredentials",
    ],
    ["http://localhost/image.png", "local_hostname", "urlLocal"],
    ["http://127.0.0.1/image.png", "non_global_ip", "urlIp"],
  ] as const)("refuses %s without outbound IO", async (url, code, key) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
      await assertTranslated(
        app().action(api.cms.media.importFromUrl, { url }),
        code,
        key
      )
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it.each([
    [400, "image/png", "0", "MEDIA_FETCH_FAILED", "mediaFetchFailed"],
    [200, "text/plain", "0", "MEDIA_NOT_IMAGE", "mediaNotImage"],
    [200, "image/png", "10485761", "MEDIA_TOO_LARGE", "mediaTooLarge"],
  ] as const)(
    "translates remote validation %s %s",
    async (status, type, length, code, key) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(null, {
              status,
              headers: { "content-type": type, "content-length": length },
            })
        )
      )
      try {
        await assertTranslated(
          app().action(api.cms.media.importFromUrl, {
            url: "https://cdn.example.com/image.png",
          }),
          code,
          key
        )
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )
  it("translates the unchanged parser reason from the registered action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(), {
            headers: { "content-type": "image/png" },
          })
      )
    )
    try {
      await assertTranslated(
        app().action(api.cms.media.importFromUrl, {
          url: "https://cdn.example.com/image.png",
        }),
        "INVALID_IMAGE_DIMENSIONS",
        "imageTruncated",
        "truncated"
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("translates empty folder validation", async () => {
    await assertTranslated(
      app().mutation(api.cms.media.createFolder, { name: " " }),
      "FOLDER_NAME_REQUIRED",
      "folderNameRequired"
    )
  })
  it("translates duplicate folder validation without changing the existing folder", async () => {
    const caller = app()
    await caller.mutation(api.cms.media.createFolder, { name: "images" })
    await assertTranslated(
      caller.mutation(api.cms.media.createFolder, { name: "images" }),
      "FOLDER_EXISTS",
      "folderExists"
    )
  })
})

describe("registered redirect owner validation", () => {
  it("translates missing destination", async () => {
    const caller = app()
    await enableRedirectsForTest(caller)
    await assertTranslated(
      caller.mutation(api.cms.redirects.create, {
        fromPath: "/old",
        statusCode: 301,
      }),
      "REDIRECT_DESTINATION_REQUIRED",
      "redirectDestinationRequired"
    )
  })
  it("translates same source and destination", async () => {
    const caller = app()
    await enableRedirectsForTest(caller)
    await assertTranslated(
      caller.mutation(api.cms.redirects.create, {
        fromPath: "/same",
        toPath: "/same",
        statusCode: 301,
      }),
      "REDIRECT_SAME_PATH",
      "redirectSamePath"
    )
  })
  it("translates duplicate refusal without overwriting a redirect", async () => {
    const caller = app()
    await enableRedirectsForTest(caller)
    await caller.mutation(api.cms.redirects.create, {
      fromPath: "/old",
      toPath: "/new",
      statusCode: 301,
    })
    await assertTranslated(
      caller.mutation(api.cms.redirects.create, {
        fromPath: "/old",
        toPath: "/other",
        statusCode: 301,
      }),
      "REDIRECT_EXISTS",
      "redirectExists"
    )
  })
})

describe("registered site description validation", () => {
  it("translates a description for a language that is not enabled", async () => {
    const caller = app()
    await caller.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Test site",
        siteUrl: "https://example.test",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    )
    await assertTranslated(
      caller.mutation(api.cms.settings.updateSettings, {
        siteDescriptions: { fr: "Bonjour" },
      }),
      "SITE_DESCRIPTION_LOCALE_NOT_ENABLED",
      "siteDescriptionLocaleNotEnabled"
    )
  })
})
