"use client"

import { useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { toast } from "sonner"
import { Copy, Globe, ImagePlus, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { readSiteDescription } from "@/lib/i18n/site-description"
import Image from "next/image"
import { MediaPicker } from "./media-picker"
import { PublicSiteUpdatesRow } from "./public-site-updates-row"
import { RevalidationDiagnostics } from "./revalidation-diagnostics"
import { useModuleGate } from "./admin-module-state-provider"

/**
 * The existing Tooltip around the tab: hover and keyboard focus show the text
 * (WAI tooltip pattern). No text, no tooltip. The trigger is a wrapper span,
 * never the tab itself: Radix Tooltip passes its own `data-state`
 * (closed/delayed-open) down, and Radix Tabs spreads trigger props after its
 * `data-state` (active/inactive), so the tooltip's value would overwrite the
 * tab's selected state. Focus and hover bubble to the span.
 */
function MissingTip({
  text,
  children,
}: {
  text: string | null
  children: React.ReactElement
}) {
  if (!text) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-full flex-1">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

type Draft = {
  siteName: string
  siteUrl: string
  /** Site description per enabled language (M05 A5); "" means none. */
  siteDescriptions: Record<string, string>
  contactEmail: string
  contactPhone: string
  contactAddress: string
  socialFacebook: string
  socialInstagram: string
  socialX: string
  socialLinkedin: string
  brandVoice: string
}

const BRAND_VOICE_MAX = 400

type BrandingSlot = "logo" | "favicon" | "og"

/** Language name written in its own language, first letter capitalised. */
function languageName(code: string): string {
  const name = getLocaleDisplayName(code)
  try {
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
  } catch {
    return name
  }
}

export function GeneralSettings() {
  const displayError = useCaughtError()
  const t = useTranslations("settings.general")
  const tCommon = useTranslations("settings.common")
  const settings = useQuery(api.cms.settings.getSettings)
  const brandingUrls = useQuery(api.cms.settings.getBrandingUrls)
  const updateSettings = useMutation(api.cms.settings.updateSettings)
  const setBrandingImage = useMutation(api.cms.settings.setBrandingImage)
  // Same rule as Write page with AI. A hidden field keeps its stored value:
  // the draft below still carries settings.brandVoice into every save.
  const aiGate = useModuleGate("ai")
  const aiOn = aiGate.state === "on" || aiGate.state === "needs_setup"

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [descriptionTab, setDescriptionTab] = useState<string | null>(null)

  if (settings === undefined) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tCommon("loading")}
      </div>
    )
  }
  if (settings === null) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tCommon("notInitialized")}
      </div>
    )
  }

  // Default language first, then the others in their saved order.
  const languages = [
    settings.defaultLocale,
    ...settings.enabledLocales.filter((code) => code !== settings.defaultLocale),
  ]
  const multi = languages.length > 1
  const activeLanguage =
    descriptionTab !== null && languages.includes(descriptionTab)
      ? descriptionTab
      : settings.defaultLocale

  const value: Draft = draft ?? {
    siteName: settings.siteName ?? "",
    siteUrl: settings.siteUrl ?? "",
    siteDescriptions: Object.fromEntries(
      languages.map((code) => [code, readSiteDescription(settings, code) ?? ""])
    ),
    contactEmail: settings.contactEmail ?? "",
    contactPhone: settings.contactPhone ?? "",
    contactAddress: settings.contactAddress ?? "",
    socialFacebook: settings.socialFacebook ?? "",
    socialInstagram: settings.socialInstagram ?? "",
    socialX: settings.socialX ?? "",
    socialLinkedin: settings.socialLinkedin ?? "",
    brandVoice: settings.brandVoice ?? "",
  }

  const dirty = draft !== null

  function field<K extends Exclude<keyof Draft, "siteDescriptions">>(
    key: K,
    next: string
  ) {
    setDraft({ ...value, [key]: next })
  }

  function setDescription(code: string, next: string) {
    setDraft({
      ...value,
      siteDescriptions: { ...value.siteDescriptions, [code]: next },
    })
  }

  async function save() {
    setSaving(true)
    // No `finally`: catch swallows the error; an unconditional cleanup after
    // the try/catch is equivalent and React-Compiler-friendly.
    try {
      await updateSettings(value)
      setDraft(null)
      toast.success(t("toast.saved"))
    } catch (err) {
      toast.error(displayError(err, tCommon("failedSave")))
    }
    setSaving(false)
  }

  async function selectBranding(slot: BrandingSlot, mediaId: Id<"media">) {
    try {
      await setBrandingImage({ slot, mediaId })
      toast.success(t("toast.imageUpdated"))
    } catch (err) {
      toast.error(
        displayError(err, t("toast.failedUpdateImage"))
      )
    }
  }

  async function clearBranding(slot: BrandingSlot) {
    try {
      await setBrandingImage({ slot })
      toast.success(t("toast.imageRemoved"))
    } catch (err) {
      toast.error(
        displayError(err, t("toast.failedRemoveImage"))
      )
    }
  }

  return (
    <div className="space-y-6">
      {/* Site identity */}
      <section className="divide-y rounded-lg border bg-card">
        <div className="p-4">
          <h2 className="text-sm font-medium">{t("identity.heading")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("identity.description")}
          </p>
        </div>
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="siteName">{t("identity.siteName")}</Label>
              {multi && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("identity.siteNameShared")}
                      className="inline-flex text-muted-foreground"
                    >
                      <Globe className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("identity.siteNameShared")}</TooltipContent>
                </Tooltip>
              )}
            </div>
            <Input
              id="siteName"
              value={value.siteName}
              onChange={(e) => field("siteName", e.target.value)}
              placeholder={t("identity.siteNamePlaceholder")}
            />
          </div>
          <div className="space-y-2">
            {multi ? (
              <Tabs value={activeLanguage} onValueChange={setDescriptionTab}>
                <div className="flex items-center justify-between gap-2">
                  <Label>{t("identity.siteDescription")}</Label>
                  <TabsList aria-label={t("identity.descriptionLanguages")}>
                    {languages.map((code) => {
                      // Written means saved: the marker clears after Save, not
                      // while the text is being typed.
                      const written =
                        (readSiteDescription(settings, code) ?? "").trim()
                          .length > 0
                      return (
                        <MissingTip
                          key={code}
                          text={written ? null : t("identity.descriptionNotWritten")}
                        >
                          <TabsTrigger
                            value={code}
                            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                          >
                            {/* Amber dot only on a tab whose description is not written. */}
                            {!written && (
                              <span
                                aria-hidden={true}
                                className="inline-block size-2 shrink-0 rounded-full bg-amber-500"
                              />
                            )}
                            {languageName(code)}
                            <span className="sr-only">
                              {written
                                ? t("identity.descriptionPresent")
                                : t("identity.descriptionMissing")}
                            </span>
                          </TabsTrigger>
                        </MissingTip>
                      )
                    })}
                  </TabsList>
                </div>
                {languages.map((code) => {
                  const language = languageName(code)
                  return (
                    <TabsContent key={code} value={code} className="space-y-2">
                      <Textarea
                        aria-label={t("identity.descriptionIn", { language })}
                        rows={3}
                        value={value.siteDescriptions[code] ?? ""}
                        onChange={(e) => setDescription(code, e.target.value)}
                        placeholder={t("identity.descriptionPlaceholderIn", {
                          language,
                        })}
                      />
                      {!value.siteDescriptions[code] &&
                        code !== settings.defaultLocale && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setDescription(
                                code,
                                value.siteDescriptions[
                                  settings.defaultLocale
                                ] ?? ""
                              )
                            }
                          >
                            <Copy className="size-3.5" />
                            {t("identity.copyDescriptionFrom", {
                              language: languageName(settings.defaultLocale),
                            })}
                          </Button>
                        )}
                    </TabsContent>
                  )
                })}
              </Tabs>
            ) : (
              <>
                <Label htmlFor="siteDescription">
                  {t("identity.siteDescription")}
                </Label>
                <Textarea
                  id="siteDescription"
                  rows={3}
                  value={value.siteDescriptions[settings.defaultLocale] ?? ""}
                  onChange={(e) =>
                    setDescription(settings.defaultLocale, e.target.value)
                  }
                  placeholder={t("identity.siteDescriptionPlaceholder")}
                />
              </>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="siteUrl">{t("identity.siteUrl")}</Label>
            <Input
              id="siteUrl"
              type="url"
              value={value.siteUrl}
              onChange={(e) => field("siteUrl", e.target.value)}
              placeholder={t("identity.siteUrlPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">
              {t("identity.siteUrlHelp")}
            </p>
          </div>
          <PublicSiteUpdatesRow />
        </div>
      </section>

      {/* Contact */}
      <section className="divide-y rounded-lg border bg-card">
        <div className="p-4">
          <h2 className="text-sm font-medium">{t("contact.heading")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("contact.description")}
          </p>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="contactEmail">{t("contact.email")}</Label>
              <Input
                id="contactEmail"
                type="email"
                value={value.contactEmail}
                onChange={(e) => field("contactEmail", e.target.value)}
                placeholder={t("contact.emailPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contactPhone">{t("contact.phone")}</Label>
              <Input
                id="contactPhone"
                type="tel"
                value={value.contactPhone}
                onChange={(e) => field("contactPhone", e.target.value)}
                placeholder={t("contact.phonePlaceholder")}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactAddress">{t("contact.address")}</Label>
            <Textarea
              id="contactAddress"
              rows={2}
              value={value.contactAddress}
              onChange={(e) => field("contactAddress", e.target.value)}
              placeholder={t("contact.addressPlaceholder")}
            />
          </div>
        </div>
      </section>

      {/* Social */}
      <section className="divide-y rounded-lg border bg-card">
        <div className="p-4">
          <h2 className="text-sm font-medium">{t("social.heading")}</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="socialFacebook">{t("social.facebook")}</Label>
            <Input
              id="socialFacebook"
              type="url"
              value={value.socialFacebook}
              onChange={(e) => field("socialFacebook", e.target.value)}
              placeholder={t("social.facebookPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="socialInstagram">{t("social.instagram")}</Label>
            <Input
              id="socialInstagram"
              type="url"
              value={value.socialInstagram}
              onChange={(e) => field("socialInstagram", e.target.value)}
              placeholder={t("social.instagramPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="socialX">{t("social.x")}</Label>
            <Input
              id="socialX"
              type="url"
              value={value.socialX}
              onChange={(e) => field("socialX", e.target.value)}
              placeholder={t("social.xPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="socialLinkedin">{t("social.linkedin")}</Label>
            <Input
              id="socialLinkedin"
              type="url"
              value={value.socialLinkedin}
              onChange={(e) => field("socialLinkedin", e.target.value)}
              placeholder={t("social.linkedinPlaceholder")}
            />
          </div>
        </div>
      </section>

      {/* Brand voice: the writing assistant follows it, so it shows while AI is on. */}
      {aiOn && (
        <section className="divide-y rounded-lg border bg-card">
          <div className="p-4">
            <h2 className="text-sm font-medium">{t("brandVoice.heading")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("brandVoice.description")}
            </p>
          </div>
          <div className="space-y-2 p-4">
            <Label htmlFor="brandVoice">{t("brandVoice.label")}</Label>
            <Textarea
              id="brandVoice"
              rows={3}
              value={value.brandVoice}
              maxLength={BRAND_VOICE_MAX}
              onChange={(e) => field("brandVoice", e.target.value)}
              placeholder={t("brandVoice.placeholder")}
            />
            <p className="text-xs text-muted-foreground">
              {value.brandVoice.length}/{BRAND_VOICE_MAX}
            </p>
          </div>
        </section>
      )}

      {/* Branding */}
      <section className="divide-y rounded-lg border bg-card">
        <div className="p-4">
          <h2 className="text-sm font-medium">{t("branding.heading")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("branding.description")}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <BrandingField
            label={t("branding.logo")}
            url={brandingUrls?.logo ?? null}
            onSelect={(mediaId) => selectBranding("logo", mediaId)}
            onClear={() => clearBranding("logo")}
          />
          <BrandingField
            label={t("branding.favicon")}
            url={brandingUrls?.favicon ?? null}
            onSelect={(mediaId) => selectBranding("favicon", mediaId)}
            onClear={() => clearBranding("favicon")}
          />
          <BrandingField
            label={t("branding.og")}
            url={brandingUrls?.og ?? null}
            onSelect={(mediaId) => selectBranding("og", mediaId)}
            onClear={() => clearBranding("og")}
          />
        </div>
      </section>

      <RevalidationDiagnostics />

      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? tCommon("saving") : tCommon("save")}
        </Button>
      </div>
    </div>
  )
}

function BrandingField({
  label,
  url,
  onSelect,
  onClear,
}: {
  label: string
  url: string | null
  onSelect: (mediaId: Id<"media">) => void
  onClear: () => void
}) {
  const t = useTranslations("settings.general.branding")
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md border bg-background">
        {url ? (
          <Image
            src={url}
            alt={t("previewAlt", { label })}
            fill
            sizes="(max-width: 768px) 100vw, 480px"
            className="object-contain"
          />
        ) : (
          <span className="text-xs text-muted-foreground">{t("noImage")}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
        >
          <ImagePlus className="size-3.5" />
          {url ? t("replace") : t("choose")}
        </Button>
        {url && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="text-muted-foreground hover:text-destructive"
          >
            <X className="size-3.5" />
            {t("remove")}
          </Button>
        )}
      </div>
      <MediaPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(_, media) => onSelect(media._id)}
      />
    </div>
  )
}
