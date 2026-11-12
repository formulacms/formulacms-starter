import {
  checkPageAddress,
  refusePageAddress,
} from "../lib/publishing/snapshots"
import { initializeEmptySliceOccurrenceCounts } from "../lib/publishing/staging"
import {
  occurrenceUsageWrites,
  occurrenceUsageMutation as mutation,
} from "../lib/publishing/staging"
import { ConvexError, v } from "convex/values"
import { recordPublicChange } from "../lib/language/freshness"
import { query } from "../_generated/server"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { requireOperationAccess } from "../lib/access/policy"
import type { OwnerPrincipal } from "../lib/access/owner"
import { assertBoundedPilotCanCreate } from "../lib/pilotEnvelope"
import { resolveEffectiveHomePageId } from "../lib/pages/home"
import {
  assertLegacyPublicationWriterBlocked,
  readPublicationAuthority,
} from "../lib/publishing/snapshots"
import {
  initializeEmptySnapshotAuthorityForOwner,
  initializeSuccessorPage,
} from "./publication"
import { siteSettingsDocValidator } from "../schema"
import {
  assertPublicLanguageVersion,
  readPublicSiteLanguageState,
  readSiteLanguageState,
} from "../lib/language/state"
import {
  mergeSiteDescriptions,
  readSiteDescription,
} from "../../lib/i18n/site-description"
import { insertInitialSiteLanguageAuthority } from "./language"

const FALLBACK_LOCALE = "en"

/** F03a adapter for existing settings call sites; no role data is resolved. */
export async function requirePermission(
  ctx: QueryCtx | MutationCtx,
  _operation: string,
  _scope?: { ownerId?: string | null; prospectiveOwner?: boolean }
): Promise<OwnerPrincipal> {
  return requireOperationAccess(ctx)
}

type SiteSettingsWithBrandingMedia = Doc<"siteSettings"> & {
  logoMediaId?: Id<"media">
  faviconMediaId?: Id<"media">
  defaultOgImageMediaId?: Id<"media">
}

// Single-tenant: exactly one siteSettings row.
export async function getSingleSettings(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"siteSettings"> | null> {
  return ctx.db.query("siteSettings").first()
}

function validateLocales(defaultLocale: string, enabledLocales: string[]) {
  if (enabledLocales.length === 0) {
    throw new ConvexError("At least one locale must be enabled.")
  }
  if (!enabledLocales.includes(defaultLocale)) {
    // Stable code prefix so the admin UI can branch on it ("change the
    // default locale first") without string-matching the human message.
    throw new ConvexError(
      "DEFAULT_LOCALE_MUST_BE_ENABLED: The default locale must remain in the enabled set. Change the default locale before removing it."
    )
  }
}

// Public, no-auth: read by middleware on every request (kept tiny + cached).
export const getSiteConfig = query({
  args: {},
  returns: v.object({
    onboardingCompletedAt: v.union(v.number(), v.null()),
    defaultLocale: v.string(),
    enabledLocales: v.array(v.string()),
    homePageId: v.union(v.id("pages"), v.null()),
    siteUrl: v.string(),
    timezone: v.string(),
    languageVersion: v.number(),
  }),
  handler: async (ctx) => {
    const languageState = await readPublicSiteLanguageState(ctx)
    const settings =
      languageState.kind === "unconfigured" ? null : languageState.settings
    const authority = await readPublicationAuthority(ctx)
    // During snapshot authority, do not derive a public home from the legacy
    // mutable Page status/content fields. An explicitly configured home is
    // still only renderable once its locale snapshot is selected by readers.
    const homePageId =
      authority === "snapshot_active"
        ? (settings?.homePageId ?? null)
        : authority === "legacy"
          ? await resolveEffectiveHomePageId(ctx, settings?.homePageId)
          : null
    return {
      onboardingCompletedAt: settings?.onboardingCompletedAt ?? null,
      defaultLocale: settings?.defaultLocale ?? FALLBACK_LOCALE,
      enabledLocales:
        authority !== "invalid" &&
        settings?.enabledLocales &&
        settings.enabledLocales.length > 0
          ? settings.enabledLocales
          : authority === "invalid"
            ? []
            : [FALLBACK_LOCALE],
      homePageId,
      // Absolute site origin for metadataBase / canonical / hreflang. Empty
      // until onboarding sets it; the public layer falls back to env then host.
      siteUrl: settings?.siteUrl ?? "",
      timezone: settings?.timezone ?? "UTC",
      languageVersion: languageState.version,
    }
  },
})

export const getSettings = query({
  args: {},
  returns: v.union(siteSettingsDocValidator, v.null()),
  handler: async (ctx) => {
    // Return null silently when auth hasn't propagated yet (Convex auth is async
    // on the client; the Next.js route is already guarded by AuthGuard).
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return null
    await requirePermission(ctx, "settings:view")
    return getSingleSettings(ctx)
  },
})

// ─── Phase 11 — onboarding step bookmarks ────────────────────────────────────

type OnboardingStep = "account" | "identity" | "locales" | "ai"

const STEP_FIELD: Record<OnboardingStep, keyof Doc<"siteSettings">> = {
  account: "onboardingAccountAt",
  identity: "onboardingIdentityAt",
  locales: "onboardingLocalesAt",
  ai: "onboardingAiAt",
}

/** Wizard reads this on mount to land on the first incomplete step. Public
 *  query — anonymous callers get all-false (pre-account). No role gate: the
 *  wizard predates the user's role being established. */
export const getOnboardingProgress = query({
  args: {},
  returns: v.object({
    account: v.boolean(),
    identity: v.boolean(),
    locales: v.boolean(),
    ai: v.boolean(),
    finished: v.boolean(),
  }),
  handler: async (ctx) => {
    const settings = await getSingleSettings(ctx)
    return {
      account: settings?.onboardingAccountAt != null,
      identity: settings?.onboardingIdentityAt != null,
      locales: settings?.onboardingLocalesAt != null,
      ai: settings?.onboardingAiAt != null,
      finished: settings?.onboardingCompletedAt != null,
    }
  },
})

/** Stamp a completion bookmark for one wizard step.
 *  The owner claim has already persisted admin before this is called, so the
 *  normal settings permission remains the authority boundary. Idempotent:
 *  re-marking the same step is a no-op success. */
export const markOnboardingStep = mutation({
  args: {
    step: v.union(
      v.literal("account"),
      v.literal("identity"),
      v.literal("locales"),
      v.literal("ai")
    ),
  },
  returns: v.null(),
  handler: async (ctx, { step }) => {
    await requirePermission(ctx, "settings:update")
    const publicationAuthority = await readPublicationAuthority(ctx)
    if (publicationAuthority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    if (publicationAuthority === "snapshot_active") {
      throw new ConvexError("SNAPSHOT_ONBOARDING_WIZARD_DEFERRED")
    }
    await assertLegacyPublicationWriterBlocked(
      ctx,
      "settings.markOnboardingStep"
    )
    const now = Date.now()
    const field = STEP_FIELD[step]
    const existing = await getSingleSettings(ctx)
    if (existing) {
      // Idempotent — keep the original timestamp if already set.
      if (existing[field] != null) return null
      await ctx.db.patch(existing._id, {
        [field]: now,
        updatedAt: now,
      })
      return null
    }
    // No settings row exists yet (first wizard step before identity persisted
    // it). Insert a minimal placeholder row so the bookmark can land. The
    // identity/locales steps will fill the real fields via updateSettings.
    await ctx.db.insert("siteSettings", {
      siteName: "",
      siteUrl: "",
      defaultLocale: FALLBACK_LOCALE,
      enabledLocales: [FALLBACK_LOCALE],
      [field]: now,
      updatedAt: now,
    })
    return null
  },
})

/**
 * Minimal clean-install contract used while the full onboarding wizard is
 * deferred. One owner transaction establishes snapshot authority, commits the
 * single bootstrap locale, and marks the installation ready. Optional setup
 * (additional locales, email, AI and starter content) is deliberately outside
 * this command.
 */
export const bootstrapInstallation = mutation({
  args: {
    siteName: v.string(),
    siteUrl: v.optional(v.string()),
    siteDescription: v.optional(v.string()),
    timezone: v.string(),
    defaultLocale: v.string(),
  },
  returns: v.object({
    phase: v.literal("snapshot_active"),
    revision: v.number(),
    onboardingCompletedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const auth = await requirePermission(ctx, "settings:update")
    const siteName = args.siteName.trim()
    const siteUrl = (args.siteUrl ?? "").replace(/\/$/, "")
    const defaultLocale = args.defaultLocale.trim()
    if (!siteName) throw new ConvexError("SITE_NAME_REQUIRED")
    validateLocales(defaultLocale, [defaultLocale])

    const settingsRows = await ctx.db.query("siteSettings").take(2)
    if (settingsRows.length > 1) {
      throw new ConvexError("INSTALLATION_BOOTSTRAP_STATE_INVALID")
    }
    const existing = settingsRows[0] ?? null
    const authority = await readPublicationAuthority(ctx)
    if (existing?.onboardingCompletedAt !== undefined) {
      if (
        authority === "snapshot_active" &&
        existing.siteName === siteName &&
        existing.siteUrl === siteUrl &&
        (readSiteDescription(existing, defaultLocale) ?? "") ===
          (args.siteDescription?.trim() ?? "") &&
        existing.timezone === args.timezone &&
        existing.defaultLocale === defaultLocale &&
        existing.enabledLocales.length === 1 &&
        existing.enabledLocales[0] === defaultLocale &&
        existing.homePageId !== undefined
      ) {
        const [home, pageStates, sharedDrafts, localeStates, localeDrafts] =
          await Promise.all([
            ctx.db.get(existing.homePageId),
            ctx.db
              .query("pagePublicationPageStates")
              .withIndex("by_pageId", (q) =>
                q.eq("pageId", existing.homePageId!)
              )
              .take(2),
            ctx.db
              .query("pageSharedDrafts")
              .withIndex("by_pageId", (q) =>
                q.eq("pageId", existing.homePageId!)
              )
              .take(2),
            ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", existing.homePageId!).eq("locale", defaultLocale)
              )
              .take(2),
            ctx.db
              .query("pageLocaleDrafts")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", existing.homePageId!).eq("locale", defaultLocale)
              )
              .take(2),
          ])
        if (
          !home ||
          pageStates.length !== 1 ||
          pageStates[0]!.lifecycleState !== "active" ||
          sharedDrafts.length !== 1 ||
          localeStates.length !== 1 ||
          localeDrafts.length !== 1 ||
          localeDrafts[0]!.generation !== localeStates[0]!.draftGeneration
        ) {
          throw new ConvexError("INSTALLATION_BOOTSTRAP_STATE_INVALID")
        }
        const cutover = await initializeEmptySnapshotAuthorityForOwner(ctx)
        await initializeEmptySliceOccurrenceCounts(ctx)
        // A resumed bootstrap ends with the same language authority as a fresh
        // one: version 1 for the one bootstrap locale.
        const languageState = await readSiteLanguageState(ctx)
        if (languageState.kind === "uninitialized") {
          await insertInitialSiteLanguageAuthority(ctx, defaultLocale)
        } else if (
          languageState.kind !== "current" ||
          languageState.locale !== defaultLocale
        ) {
          throw new ConvexError("INSTALLATION_BOOTSTRAP_STATE_INVALID")
        }
        return {
          ...cutover,
          onboardingCompletedAt: existing.onboardingCompletedAt,
        }
      }
      throw new ConvexError("INSTALLATION_ALREADY_BOOTSTRAPPED")
    }

    // A locale-bearing menu or menu reference means this is no longer a clean
    // installation, even when the publication cutover has a zero-count
    // closure. Never relabel those retained artifacts with a new locale.
    const retainedSetupArtifacts = await Promise.all([
      ctx.db.query("menus").take(1),
      ctx.db.query("menuReferences").take(1),
    ])
    if (retainedSetupArtifacts.some((rows) => rows.length > 0)) {
      throw new ConvexError("INSTALLATION_BOOTSTRAP_REQUIRES_EMPTY_SETUP")
    }

    // Even an existing active epoch must be the exact empty install; a Page or
    // publication row created after initialization is never relabeled here.
    const cutover = await initializeEmptySnapshotAuthorityForOwner(ctx, {
      requireEmptyInstall: true,
    })
    const now = Date.now()
    await assertBoundedPilotCanCreate(ctx, false)
    const homePageId = await occurrenceUsageWrites(ctx).insert("pages", {
      slug: "home",
      pageType: "landing-page",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      createdBy: auth.tokenIdentifier,
      content: {},
    })
    const home = await ctx.db.get(homePageId)
    if (!home) throw new ConvexError("INSTALLATION_BOOTSTRAP_STATE_INVALID")
    await initializeSuccessorPage(ctx, home, auth, {
      [defaultLocale]: { title: siteName, slices: [] },
    })
    refusePageAddress(
      await checkPageAddress(ctx, {
        pageId: homePageId,
        pageType: home.pageType,
        locale: defaultLocale,
        slug: "home",
        homePageId,
      }),
      "migration"
    )
    const fields = {
      siteName,
      siteUrl,
      // M05 A5: the description is stored per language, under the language
      // chosen here. Any legacy single value moves under the outgoing default.
      ...mergeSiteDescriptions(
        existing,
        existing?.defaultLocale ?? defaultLocale,
        {
          [defaultLocale]: args.siteDescription,
        }
      ),
      timezone: args.timezone,
      dateFormat: existing?.dateFormat ?? "PP",
      defaultLocale,
      enabledLocales: [defaultLocale],
      homePageId,
      onboardingCompletedAt: now,
      updatedAt: now,
    }
    if (existing) await ctx.db.patch(existing._id, fields)
    else await ctx.db.insert("siteSettings", fields)
    // F09: the site language is chosen here, before any public content exists.
    await insertInitialSiteLanguageAuthority(ctx, defaultLocale)
    await initializeEmptySliceOccurrenceCounts(ctx)

    return { ...cutover, onboardingCompletedAt: now }
  },
})

export const completeOnboarding = mutation({
  args: {
    siteName: v.string(),
    siteUrl: v.optional(v.string()),
    siteDescription: v.optional(v.string()),
    timezone: v.string(),
    dateFormat: v.optional(v.string()),
    defaultLocale: v.string(),
    enabledLocales: v.array(v.string()),
  },
  returns: v.object({ onboardingCompletedAt: v.number() }),
  handler: async (ctx, args) => {
    const auth = await requirePermission(ctx, "settings:update")
    const publicationAuthority = await readPublicationAuthority(ctx)
    if (publicationAuthority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    if (publicationAuthority === "snapshot_active") {
      throw new ConvexError("SNAPSHOT_ONBOARDING_WIZARD_DEFERRED")
    }
    await assertLegacyPublicationWriterBlocked(
      ctx,
      "settings.completeOnboarding"
    )

    const existing = await getSingleSettings(ctx)
    if (existing?.onboardingCompletedAt) {
      throw new ConvexError("Onboarding has already been completed.")
    }

    // Phase 11 — when the new step-driven wizard has stamped any bookmark, all
    // required steps (account, identity, locales and AI — AI counts as done on
    // skip) must be stamped before Finish. Email is configured after setup.
    // When no bookmark exists
    // (pure legacy single-call path used by older tests), skip this gate so
    // those callers still pass.
    if (existing) {
      const stamps: Array<[OnboardingStep, number | undefined]> = [
        ["account", existing.onboardingAccountAt],
        ["identity", existing.onboardingIdentityAt],
        ["locales", existing.onboardingLocalesAt],
        ["ai", existing.onboardingAiAt],
      ]
      const anyStamped = stamps.some(([, at]) => at != null)
      if (anyStamped) {
        const missing = stamps.filter(([, at]) => at == null).map(([s]) => s)
        if (missing.length > 0) {
          throw new ConvexError(
            `ONBOARDING_INCOMPLETE: missing steps ${missing.join(", ")}`
          )
        }
      }
    }

    validateLocales(args.defaultLocale, args.enabledLocales)

    const now = Date.now()

    const settingsFields = {
      siteName: args.siteName,
      siteUrl: (args.siteUrl ?? "").replace(/\/$/, ""),
      // M05 A5: stored per language under the chosen default language.
      ...mergeSiteDescriptions(
        existing,
        existing?.defaultLocale ?? args.defaultLocale,
        { [args.defaultLocale]: args.siteDescription }
      ),
      defaultLocale: args.defaultLocale,
      enabledLocales: args.enabledLocales,
      timezone: args.timezone,
      dateFormat: args.dateFormat ?? "PP",
      onboardingCompletedAt: now,
      updatedAt: now,
    }

    const settingsId = existing
      ? (await ctx.db.patch(existing._id, settingsFields), existing._id)
      : await ctx.db.insert("siteSettings", settingsFields)

    // Designate an existing configured home when present. Otherwise create a
    // blank fallback so "/" resolves.
    let homePageId = await resolveEffectiveHomePageId(ctx, existing?.homePageId)
    if (!homePageId) {
      await assertBoundedPilotCanCreate(ctx, true)
      homePageId = await occurrenceUsageWrites(ctx).insert("pages", {
        slug: "home",
        pageType: "landing-page",
        status: "published",
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
        createdBy: auth.tokenIdentifier,
        content: {
          [args.defaultLocale]: {
            title: args.siteName,
            slices: [],
          },
        },
      })
    }

    await ctx.db.patch(settingsId, { homePageId })

    return { onboardingCompletedAt: now }
  },
})

export const updateSettings = mutation({
  args: {
    siteName: v.optional(v.string()),
    siteUrl: v.optional(v.string()),
    // The default language's description (single-language callers). An empty
    // text clears it.
    siteDescription: v.optional(v.string()),
    // Per-language descriptions to set, keyed by an enabled locale code (M05
    // A5). Languages not named keep their stored text; an empty text clears.
    siteDescriptions: v.optional(v.record(v.string(), v.string())),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    contactAddress: v.optional(v.string()),
    socialFacebook: v.optional(v.string()),
    socialInstagram: v.optional(v.string()),
    socialX: v.optional(v.string()),
    socialLinkedin: v.optional(v.string()),
    brandVoice: v.optional(v.string()),
    timezone: v.optional(v.string()),
    dateFormat: v.optional(v.string()),
    defaultLocale: v.optional(v.string()),
    enabledLocales: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "settings:update")

    const publicationAuthority = await readPublicationAuthority(ctx)
    if (publicationAuthority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    if (publicationAuthority !== "snapshot_active") {
      await assertLegacyPublicationWriterBlocked(ctx, "settings.updateSettings")
    }

    const existing = await getSingleSettings(ctx)
    if (!existing) {
      throw new ConvexError("Site settings not initialized yet.")
    }

    const nextDefault = args.defaultLocale ?? existing.defaultLocale
    const nextEnabled = args.enabledLocales ?? existing.enabledLocales
    validateLocales(nextDefault, nextEnabled)
    if (
      publicationAuthority === "snapshot_active" &&
      (args.defaultLocale !== undefined || args.enabledLocales !== undefined)
    ) {
      throw new ConvexError(
        "SNAPSHOT_LOCALE_SETTINGS_REQUIRE_PUBLICATION_TRANSITION"
      )
    }

    for (const locale of Object.keys(args.siteDescriptions ?? {})) {
      if (!nextEnabled.includes(locale)) {
        throw new ConvexError({ code: "SITE_DESCRIPTION_LOCALE_NOT_ENABLED" })
      }
    }
    // M05 A5: the legacy single value is stored under the OUTGOING default
    // language before anything else changes — at the first per-language write
    // or when this call itself changes the default.
    const descriptionEdits = {
      ...(args.siteDescriptions ?? {}),
      ...(args.siteDescription !== undefined
        ? { [existing.defaultLocale]: args.siteDescription }
        : {}),
    }
    const descriptionChanged = Object.keys(descriptionEdits).length > 0
    const descriptionFields =
      descriptionChanged || nextDefault !== existing.defaultLocale
        ? mergeSiteDescriptions(
            existing,
            existing.defaultLocale,
            descriptionEdits
          )
        : {}

    await ctx.db.patch(existing._id, {
      ...(args.siteName !== undefined && { siteName: args.siteName }),
      ...(args.siteUrl !== undefined && {
        siteUrl: args.siteUrl.replace(/\/$/, ""),
      }),
      ...descriptionFields,
      ...(args.contactEmail !== undefined && {
        contactEmail: args.contactEmail,
      }),
      ...(args.contactPhone !== undefined && {
        contactPhone: args.contactPhone,
      }),
      ...(args.contactAddress !== undefined && {
        contactAddress: args.contactAddress,
      }),
      ...(args.socialFacebook !== undefined && {
        socialFacebook: args.socialFacebook,
      }),
      ...(args.socialInstagram !== undefined && {
        socialInstagram: args.socialInstagram,
      }),
      ...(args.socialX !== undefined && { socialX: args.socialX }),
      ...(args.socialLinkedin !== undefined && {
        socialLinkedin: args.socialLinkedin,
      }),
      ...(args.brandVoice !== undefined && {
        // "" clears the override; trim runaway whitespace; cap so a runaway
        // paste can't bloat every AI prompt.
        brandVoice: args.brandVoice.trim().slice(0, 400),
      }),
      ...(args.timezone !== undefined && { timezone: args.timezone }),
      ...(args.dateFormat !== undefined && { dateFormat: args.dateFormat }),
      ...(args.defaultLocale !== undefined && { defaultLocale: nextDefault }),
      ...(args.enabledLocales !== undefined && { enabledLocales: nextEnabled }),
      updatedAt: Date.now(),
    })
    await recordPublicChange(ctx, { scopes: [] })

    // Only locale/homepage/URL settings change public URLs. Purge the CMS cache
    // exclusively when one of those routing-relevant fields actually changed —
    // identity/contact/social/AI edits don't warrant a full revalidate.
    // The description is public metadata now (M05 A5), so it purges too.
    const routingChanged =
      args.siteUrl !== undefined ||
      args.defaultLocale !== undefined ||
      args.enabledLocales !== undefined ||
      descriptionChanged
    if (routingChanged) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.revalidate.revalidateSettings,
        {}
      )
    }

    return null
  },
})

/** Set or clear a branding image slot (logo / favicon / OG). Pass no `mediaId`
 *  to clear the slot. Branding images must come from the media library. The
 *  legacy storage id is kept in sync as a fallback for existing consumers. */
export const setBrandingImage = mutation({
  args: {
    slot: v.union(v.literal("logo"), v.literal("favicon"), v.literal("og")),
    mediaId: v.optional(v.id("media")),
  },
  returns: v.null(),
  handler: async (ctx, { slot, mediaId }) => {
    await requirePermission(ctx, "settings:update")
    const existing = await getSingleSettings(ctx)
    if (!existing) {
      throw new ConvexError("Site settings not initialized yet.")
    }
    let storageId: Id<"_storage"> | undefined
    if (mediaId) {
      const media = await ctx.db.get(mediaId)
      if (!media || media.deletedAt !== undefined) {
        throw new ConvexError("Media not found.")
      }
      storageId = media.storageId
    }
    const field =
      slot === "logo"
        ? "logoStorageId"
        : slot === "favicon"
          ? "faviconStorageId"
          : "defaultOgImageStorageId"
    const mediaField =
      slot === "logo"
        ? "logoMediaId"
        : slot === "favicon"
          ? "faviconMediaId"
          : "defaultOgImageMediaId"
    await ctx.db.patch(existing._id, {
      [mediaField]: mediaId,
      [field]: storageId,
      updatedAt: Date.now(),
    })
    await recordPublicChange(ctx, { scopes: [] })
    return null
  },
})

/** Resolve the three branding storageIds to served URLs for admin previews. */
export const getBrandingUrls = query({
  args: {},
  returns: v.object({
    logo: v.union(v.string(), v.null()),
    favicon: v.union(v.string(), v.null()),
    og: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    const settings = (await getSingleSettings(
      ctx
    )) as SiteSettingsWithBrandingMedia | null
    return {
      logo:
        (await getMediaUrl(ctx, settings?.logoMediaId)) ??
        (settings?.logoStorageId
          ? await ctx.storage.getUrl(settings.logoStorageId)
          : null),
      favicon:
        (await getMediaUrl(ctx, settings?.faviconMediaId)) ??
        (settings?.faviconStorageId
          ? await ctx.storage.getUrl(settings.faviconStorageId)
          : null),
      og:
        (await getMediaUrl(ctx, settings?.defaultOgImageMediaId)) ??
        (settings?.defaultOgImageStorageId
          ? await ctx.storage.getUrl(settings.defaultOgImageStorageId)
          : null),
    }
  },
})

/** Public chrome data — contact info + social links rendered in the footer.
 *  No permission gate: these fields are intentionally public (they appear on
 *  every page footer for anonymous visitors).
 *
 *  With both `locale` and `languageVersion` it also returns that one
 *  language's site description (M05 A5), pinned to the caller's language
 *  version and read from the same single settings document. Only an enabled
 *  language answers, the legacy single value stands in for the default
 *  language alone, and another language's text is never returned. */
export const getPublicChrome = query({
  args: {
    locale: v.optional(v.string()),
    languageVersion: v.optional(v.number()),
  },
  returns: v.object({
    siteName: v.optional(v.string()),
    siteDescription: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    contactAddress: v.optional(v.string()),
    socialFacebook: v.optional(v.string()),
    socialInstagram: v.optional(v.string()),
    socialX: v.optional(v.string()),
    socialLinkedin: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const settings = await getSingleSettings(ctx)
    let siteDescription: string | undefined
    if (args.locale !== undefined && args.languageVersion !== undefined) {
      const state = await assertPublicLanguageVersion(ctx, args.languageVersion)
      if (
        state.kind !== "unconfigured" &&
        state.settings.enabledLocales.includes(args.locale)
      ) {
        siteDescription = readSiteDescription(state.settings, args.locale)
      }
    }
    return {
      siteName: settings?.siteName,
      siteDescription,
      contactEmail: settings?.contactEmail,
      contactPhone: settings?.contactPhone,
      contactAddress: settings?.contactAddress,
      socialFacebook: settings?.socialFacebook,
      socialInstagram: settings?.socialInstagram,
      socialX: settings?.socialX,
      socialLinkedin: settings?.socialLinkedin,
    }
  },
})

async function getMediaUrl(
  ctx: QueryCtx,
  mediaId: Id<"media"> | undefined
): Promise<string | null> {
  if (!mediaId) return null
  const media = await ctx.db.get(mediaId)
  if (!media || media.deletedAt !== undefined) return null
  return media.url
}
