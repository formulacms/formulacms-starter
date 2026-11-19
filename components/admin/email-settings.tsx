"use client"

import { adminEmailProvider } from "@/lib/i18n/admin-metadata"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useAction, useMutation, useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { ArrowLeft, Check, ExternalLink, Loader2, Minus, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/components/providers/confirm-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type EmailProviderSettings =
  (typeof api.email.getEmailProviderSettings)["_returnType"]
type CatalogueEntry = EmailProviderSettings["catalogue"][number]
type ProviderId = NonNullable<EmailProviderSettings["enabledProviderId"]>
/** A registered provider: it can be enabled, checked and tested. */
type ProviderEntry = CatalogueEntry & { id: ProviderId }
type LastTest = NonNullable<EmailProviderSettings["lastTest"]>
type CheckResult =
  (typeof api.email.checkEmailProviderConfiguration)["_returnType"]

type SenderDraft = {
  address: string
  name: string
}

type ProviderReadiness = "unknown" | "needs_setup" | "ready"

// The server lists only registered providers as registered, so their ids are
// the server's provider ids.
function isProviderEntry(entry: CatalogueEntry): entry is ProviderEntry {
  return entry.registered
}

// Services of @opencoredev/email-sdk 3.0.1 shown under "More providers".
const MORE_PROVIDERS = [
  "Postmark",
  "SendGrid",
  "Cloudflare Email Sending",
  "Unosend",
  "Amazon SES",
  "Mailgun",
  "MailerSend",
  "Brevo",
  "Mailchimp Transactional",
  "SparkPost",
  "Iterable",
  "Loops",
  "Sequenzy",
  "JetEmail",
  "Lettermint",
  "Lettr",
  "SendHeron",
  "Helo",
  "Primitive",
  "Plunk",
  "Mailtrap",
  "Scaleway",
  "ZeptoMail",
  "MailPace",
  "Microsoft Graph",
]

// Status colours. The theme has no success or warning token, so these use the
// emerald and amber palette with a lighter shade in dark theme. Failures use
// the theme's destructive token.
const SUCCESS_BADGE =
  "bg-emerald-600/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400"
const PENDING_BADGE =
  "bg-amber-600/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400"
const SUCCESS_TEXT = "text-emerald-600 dark:text-emerald-400"
const PENDING_TEXT = "text-amber-600 dark:text-amber-400"

/**
 * The owner's notification email (ADR-0056 rule 5), with its own Save. Save
 * turns on only when the field differs from the saved value.
 */
function NotificationsCard({ saved }: { saved: string }) {
  const t = useTranslations("settings.email.notifications")
  const tErrors = useTranslations("caughtErrors")
  const tCommon = useTranslations("common")
  const setNotificationEmail = useMutation(api.cms.owner.setNotificationEmail)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const value = draft ?? saved
  const dirty = draft !== null && draft !== saved

  async function save() {
    setSaving(true)
    try {
      const trimmed = value.trim()
      const result = await setNotificationEmail({ email: trimmed || null })
      if (result.status === "saved") {
        setDraft(null)
        toast.success(t("saved"))
      } else {
        toast.error(tErrors("invalidEmail"))
      }
    } catch {
      toast.error(tCommon("error"))
    }
    setSaving(false)
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5">
      <h2 className="text-base font-semibold">{t("heading")}</h2>
      <div className="space-y-2">
        <Label htmlFor="notification-email">{t("label")}</Label>
        <Input
          id="notification-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          className="max-w-md"
          value={value}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </div>
      <Button
        type="button"
        disabled={!dirty || saving}
        onClick={() => void save()}
      >
        {saving && <Loader2 className="animate-spin" />}
        {t("save")}
      </Button>
    </section>
  )
}

/**
 * One badge per provider: "Active" when the server says so, otherwise
 * "Inactive", amber while enabled and an outline while disabled.
 */
function ProviderStatusBadge({
  providerId,
  settings,
}: {
  providerId: ProviderId
  settings: EmailProviderSettings
}) {
  const t = useTranslations("settings.email")
  const tModules = useTranslations("settings.modules")
  if (settings.activeProviderId === providerId) {
    return <Badge className={SUCCESS_BADGE}>{t("status.activeBadge")}</Badge>
  }
  if (settings.enabledProviderId === providerId) {
    return <Badge className={PENDING_BADGE}>{tModules("inactive")}</Badge>
  }
  return <Badge variant="outline">{tModules("inactive")}</Badge>
}

/**
 * The Modules screen's enable control (components/admin/modules/
 * modules-settings.tsx): a native checkbox, then "Enabled" or "Disabled".
 */
function EnableControl({
  entry,
  enabled,
  disabled,
  onToggle,
}: {
  entry: ProviderEntry
  enabled: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
}) {
  const tModules = useTranslations("settings.modules")
  return (
    <label className="relative z-10 flex shrink-0 items-center gap-2 text-sm">
      <input
        type="checkbox"
        aria-label={tModules("toggle", { name: entry.label })}
        checked={enabled}
        disabled={disabled}
        onChange={() => onToggle(!enabled)}
        className="size-4 accent-primary"
      />
      <span>{enabled ? tModules("enabled") : tModules("disabled")}</span>
    </label>
  )
}

export function EmailSettings() {
  const t = useTranslations("settings.email")
  const tMetadata = useTranslations("metadata")
  const tSettings = useTranslations("settings.common")
  const tCommon = useTranslations("common")

  const owner = useQuery(api.cms.owner.getOwnerSession)
  const canView = owner !== undefined && owner !== null
  const settings = useQuery(
    api.email.getEmailProviderSettings,
    canView ? {} : "skip"
  )
  const notificationEmail = useQuery(
    api.cms.owner.getNotificationEmail,
    canView ? {} : "skip"
  )
  const saveConfiguration = useMutation(
    api.email.saveEmailProviderConfiguration
  )
  const enableProvider = useMutation(api.email.enableEmailProvider)
  const disableProvider = useMutation(api.email.disableEmailProvider)
  const checkConfiguration = useAction(
    api.email.checkEmailProviderConfiguration
  )
  const sendTestEmail = useAction(api.email.sendTestEmail)
  const confirm = useConfirm()

  // undefined follows the server's preselection; null is an explicit mobile
  // "back".
  const [localSelection, setLocalSelection] = useState<
    string | null | undefined
  >(undefined)
  const [draft, setDraft] = useState<SenderDraft | null>(null)
  // The last check of each provider (badge and rows), kept while the screen
  // is open. The Server setup badge comes only from a check made here.
  const [checkResults, setCheckResults] = useState<
    Partial<Record<string, CheckResult>>
  >({})
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [testing, setTesting] = useState(false)
  const [toggling, setToggling] = useState(false)

  // An accepted test makes the enabled provider active on the server. Say so
  // once, when this screen sees it change to active.
  const activeProviderId = settings?.activeProviderId
  const activeLabel = settings?.catalogue.find(
    (entry) => entry.id === activeProviderId
  )?.label
  const seenActiveProviderId = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (activeProviderId === undefined) return
    const previous = seenActiveProviderId.current
    seenActiveProviderId.current = activeProviderId
    if (
      previous === undefined ||
      activeProviderId === null ||
      previous === activeProviderId
    ) {
      return
    }
    toast.success(
      t("toast.activated", { provider: activeLabel ?? activeProviderId })
    )
  }, [activeProviderId, activeLabel, t])

  if (owner === undefined) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tSettings("loading")}
      </div>
    )
  }
  if (!canView) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t("accessDenied")}
      </div>
    )
  }
  if (settings === undefined || notificationEmail === undefined) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tSettings("loading")}
      </div>
    )
  }

  const catalogue = settings.catalogue.map((entry) =>
    adminEmailProvider(entry, tMetadata)
  )
  const labelOf = (providerId: string) =>
    catalogue.find((entry) => entry.id === providerId)?.label ?? providerId
  const selectedId =
    localSelection === undefined
      ? (settings.preselectedProviderId ?? null)
      : localSelection
  const selected = catalogue.find((entry) => entry.id === selectedId)
  const selectedProvider =
    selected && isProviderEntry(selected) ? selected : null
  const loadedSender = {
    address: settings.sender?.address ?? "",
    name: settings.sender?.name ?? "",
  }
  const sender = draft ?? loadedSender
  const dirty = draft !== null
  const isEnabled =
    selectedProvider !== null &&
    settings.enabledProviderId === selectedProvider.id
  const checkResult = selectedProvider
    ? (checkResults[selectedProvider.id] ?? null)
    : null
  const readiness: ProviderReadiness = checkResult
    ? checkResult.readiness
    : "unknown"
  // A provider's Delivery test card shows only its own last result.
  const lastTest =
    selectedProvider && settings.lastTest?.providerId === selectedProvider.id
      ? settings.lastTest
      : null
  // Enabled, server setup detected here, and a sender saved.
  const canTest =
    isEnabled &&
    readiness === "ready" &&
    settings.sender !== undefined &&
    !dirty &&
    !saving &&
    !testing

  function setSenderField(field: keyof SenderDraft, value: string) {
    setDraft({ ...sender, [field]: value })
  }

  async function saveSender() {
    setSaving(true)
    try {
      await saveConfiguration({
        senderAddress: sender.address,
        senderName: sender.name || undefined,
      })
      setDraft(null)
      toast.success(t("toast.saved"))
    } catch {
      toast.error(t("toast.failedSave"))
    } finally {
      setSaving(false)
    }
  }

  async function setEnabled(entry: ProviderEntry, on: boolean) {
    const provider = entry.label
    if (on) {
      // Enabling while another provider is enabled switches, so ask first.
      const other = settings?.enabledProviderId ?? null
      if (other !== null && other !== entry.id) {
        const ok = await confirm({
          title: t("switch.title", { provider }),
          description: t("switch.description", {
            active: labelOf(other),
            provider,
          }),
          confirmText: t("switch.confirm", { provider }),
          destructive: true,
          filled: true,
        })
        if (!ok) return
      }
      setToggling(true)
      try {
        await enableProvider({ providerId: entry.id })
      } catch {
        toast.error(tCommon("error"))
      } finally {
        setToggling(false)
      }
      return
    }
    // Disabling the active provider stops delivery, so ask first. Disabling
    // one that is not active asks nothing.
    const wasActive = settings?.activeProviderId === entry.id
    if (wasActive) {
      const ok = await confirm({
        title: t("activation.turnOffTitle", { provider }),
        description: t("activation.turnOffDescription"),
        confirmText: t("activation.turnOffConfirm"),
        destructive: true,
      })
      if (!ok) return
    }
    setToggling(true)
    try {
      await disableProvider({ providerId: entry.id })
      if (wasActive) toast.success(t("toast.deactivated", { provider }))
    } catch {
      toast.error(t("toast.failedDeactivate", { provider }))
    } finally {
      setToggling(false)
    }
  }

  async function checkProvider(entry: ProviderEntry) {
    setChecking(true)
    try {
      const result = await checkConfiguration({ providerId: entry.id })
      setCheckResults((results) => ({ ...results, [entry.id]: result }))
      if (result.readiness === "ready") {
        toast.success(t("toast.configurationReady", { provider: entry.label }))
      } else {
        toast.error(t("toast.configurationMissing", { provider: entry.label }))
      }
    } catch {
      toast.error(t("toast.failedCheck"))
    } finally {
      setChecking(false)
    }
  }

  async function runDeliveryTest() {
    setTesting(true)
    try {
      const result = await sendTestEmail({})
      if (result.status === "queued") {
        // Still pending: a neutral notification, not a success.
        toast(t("toast.testQueued"))
      } else {
        toast.error(
          result.reason === "not_configured"
            ? t("test.blocked.not_configured")
            : result.reason === "needs_setup"
              ? t("test.blocked.needs_setup")
              : result.reason === "owner_email_missing"
                ? t("test.blocked.owner_email_missing")
                : t("test.blocked.rate_limited")
        )
      }
    } catch {
      toast.error(t("toast.failedTest"))
    } finally {
      setTesting(false)
    }
  }

  function selectProvider(entry: CatalogueEntry) {
    setLocalSelection(entry.id)
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">
            {settings.activeProviderId
              ? t("status.active", {
                  provider: labelOf(settings.activeProviderId),
                })
              : t("status.inactive")}
          </h2>
          {settings.activeProviderId ? (
            <Badge className={SUCCESS_BADGE}>{t("status.activeBadge")}</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {settings.activeProviderId
            ? t("status.activeDescription")
            : t("status.inactiveDescription")}
        </p>
      </section>

      <NotificationsCard saved={notificationEmail ?? ""} />

      <div className="grid overflow-hidden rounded-lg border bg-card lg:grid-cols-[minmax(15rem,0.75fr)_minmax(0,1.6fr)]">
        <section
          aria-label={t("catalogue.heading")}
          className={cn(
            "border-border lg:block lg:border-r",
            selected ? "hidden" : "block"
          )}
        >
          <div className="border-b p-4">
            <h2 className="font-medium">{t("catalogue.heading")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("catalogue.description")}
            </p>
          </div>
          <div className="space-y-1 p-2">
            {catalogue.map((entry) => (
              // Name and badge on line 1, the enable control on line 2 at the
              // right, then the description. The row button covers the whole
              // row; the control sits above it.
              <div
                key={entry.id}
                data-provider={entry.id}
                className={cn(
                  "relative rounded-md px-3 py-3 transition-colors hover:bg-accent",
                  selected?.id === entry.id && "bg-accent"
                )}
              >
                <button
                  type="button"
                  onClick={() => selectProvider(entry)}
                  className="flex w-full items-center gap-2 text-left after:absolute after:inset-0 after:rounded-md"
                >
                  <span className="font-medium">{entry.label}</span>
                  {isProviderEntry(entry) ? (
                    <ProviderStatusBadge
                      providerId={entry.id}
                      settings={settings}
                    />
                  ) : null}
                </button>
                {isProviderEntry(entry) ? (
                  <div className="mt-1 flex justify-end">
                    <EnableControl
                      entry={entry}
                      enabled={settings.enabledProviderId === entry.id}
                      disabled={toggling}
                      onToggle={(on) => {
                        // A click on the list control also opens the provider.
                        selectProvider(entry)
                        void setEnabled(entry, on)
                      }}
                    />
                  </div>
                ) : null}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {entry.description}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section
          aria-label={selected?.label ?? t("detail.emptyHeading")}
          className={cn("min-w-0", selected ? "block" : "hidden lg:block")}
        >
          {selected ? (
            <div className="space-y-6 p-4 sm:p-6">
              <Button
                type="button"
                variant="ghost"
                className="-ml-3 lg:hidden"
                onClick={() => setLocalSelection(null)}
              >
                <ArrowLeft className="size-4" />
                {t("catalogue.back")}
              </Button>

              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{selected.label}</h2>
                  {selectedProvider ? (
                    <>
                      <ProviderStatusBadge
                        providerId={selectedProvider.id}
                        settings={settings}
                      />
                      <span className="ml-auto">
                        <EnableControl
                          entry={selectedProvider}
                          enabled={isEnabled}
                          disabled={toggling}
                          onToggle={(on) =>
                            void setEnabled(selectedProvider, on)
                          }
                        />
                      </span>
                    </>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selected.registered
                    ? selected.description
                    : t("more.description")}
                </p>
                {selectedProvider === null ? null : !isEnabled ? (
                  <p
                    className="mt-2 text-sm text-muted-foreground"
                    data-testid="provider-state-line"
                  >
                    {t("panel.disabled", { provider: selectedProvider.label })}
                  </p>
                ) : settings.activeProviderId !== selectedProvider.id ? (
                  <p
                    className={cn("mt-2 text-sm", PENDING_TEXT)}
                    data-testid="provider-state-line"
                  >
                    {t("panel.inactive", { provider: selectedProvider.label })}
                  </p>
                ) : null}
              </div>

              {selectedProvider ? (
                <ProviderPanel
                  entry={selectedProvider}
                  readiness={readiness}
                  checkResult={checkResult}
                  checking={checking}
                  onCheck={checkProvider}
                  sender={sender}
                  onSenderField={setSenderField}
                  canSave={dirty && !saving}
                  saving={saving}
                  onSave={saveSender}
                  notificationEmail={notificationEmail}
                  lastTest={lastTest}
                  active={settings.activeProviderId === selectedProvider.id}
                  enabled={isEnabled}
                  canTest={canTest}
                  testing={testing}
                  onTest={runDeliveryTest}
                />
              ) : (
                <section className="space-y-4 rounded-md border p-4">
                  <div className="flex flex-wrap gap-2">
                    {MORE_PROVIDERS.map((name) => (
                      <Badge key={name} variant="outline">
                        {name}
                      </Badge>
                    ))}
                  </div>
                  <div>
                    <Button asChild>
                      <a
                        href={selected.documentationUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("more.guide")}
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("more.smtpNote")}
                  </p>
                </section>
              )}
            </div>
          ) : (
            <div className="flex min-h-72 items-center justify-center p-8 text-center">
              <div>
                <h2 className="font-medium">{t("detail.emptyHeading")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("detail.emptyDescription")}
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ProviderPanel({
  entry,
  readiness,
  checkResult,
  checking,
  onCheck,
  sender,
  onSenderField,
  canSave,
  saving,
  onSave,
  notificationEmail,
  lastTest,
  active,
  enabled,
  canTest,
  testing,
  onTest,
}: {
  entry: ProviderEntry
  readiness: ProviderReadiness
  checkResult: CheckResult | null
  checking: boolean
  onCheck: (entry: ProviderEntry) => void
  sender: SenderDraft
  onSenderField: (field: keyof SenderDraft, value: string) => void
  canSave: boolean
  saving: boolean
  onSave: () => void
  notificationEmail: string | null
  lastTest: LastTest | null
  active: boolean
  enabled: boolean
  canTest: boolean
  testing: boolean
  onTest: () => void
}) {
  const t = useTranslations("settings.email")
  // Required settings first, then the optional ones (the SMTP port).
  const settingNames = [
    ...(entry.environment ?? []).filter((setting) => setting.required),
    ...(entry.environment ?? []).filter((setting) => !setting.required),
  ]
  const many = settingNames.length > 1
  // While the provider is disabled, the whole Server setup card is greyed out
  // and nothing in it can be used.
  const muted = !enabled
  const code = (chunks: ReactNode) => (
    <code className="font-mono text-xs">{chunks}</code>
  )

  return (
    <>
      <section className="rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{t("readiness.heading")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {many
                ? t("readiness.descriptionMany")
                : t("readiness.descriptionOne")}
            </p>
          </div>
          {muted ? (
            <Badge variant="outline" className="text-muted-foreground">
              {readiness === "ready"
                ? t("readiness.detected")
                : readiness === "needs_setup"
                  ? t("readiness.notDetected")
                  : t("readiness.notChecked")}
            </Badge>
          ) : readiness === "ready" ? (
            <Badge className={SUCCESS_BADGE}>{t("readiness.detected")}</Badge>
          ) : readiness === "needs_setup" ? (
            <Badge variant="destructive">{t("readiness.notDetected")}</Badge>
          ) : (
            <Badge variant="outline">{t("readiness.notChecked")}</Badge>
          )}
        </div>
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="setting-names">
          {settingNames.map((setting) => {
            const present = checkResult?.environment.find(
              (variable) => variable.name === setting.name
            )?.present
            return (
              <li key={setting.name} className="flex items-center gap-2">
                <code
                  className={cn(
                    "font-mono text-xs",
                    muted && "text-muted-foreground"
                  )}
                >
                  {setting.name}
                </code>
                {!setting.required ? (
                  <span className="text-xs text-muted-foreground">
                    {t("readiness.optionalPort")}
                  </span>
                ) : null}
                {checkResult === null ? null : present ? (
                  <span
                    className={cn(
                      "ml-auto inline-flex items-center gap-1 text-xs font-medium",
                      muted ? "text-muted-foreground" : SUCCESS_TEXT
                    )}
                  >
                    <Check className="size-3.5" />
                    {t("readiness.detected")}
                  </span>
                ) : !setting.required ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Minus className="size-3.5" />
                    {t("readiness.portDefault")}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "ml-auto inline-flex items-center gap-1 text-xs font-medium",
                      muted ? "text-muted-foreground" : "text-destructive"
                    )}
                  >
                    <X className="size-3.5" />
                    {t("readiness.notDetected")}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        <div className="mt-3">
          {muted ? (
            <span
              data-testid="how-to-set"
              className="text-sm font-medium text-muted-foreground underline underline-offset-4"
            >
              {many ? t("readiness.howToMany") : t("readiness.howToOne")}
            </span>
          ) : (
            <a
              href={entry.documentationUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="how-to-set"
              className="text-sm font-medium underline underline-offset-4"
            >
              {many ? t("readiness.howToMany") : t("readiness.howToOne")}
            </a>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          disabled={checking || !enabled}
          onClick={() => onCheck(entry)}
        >
          {checking ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("readiness.check")}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <div>
          <h3 className="text-sm font-medium">{t("sender.heading")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("sender.description")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="email-sender-address">{t("sender.address")}</Label>
            <Input
              id="email-sender-address"
              type="email"
              value={sender.address}
              onChange={(event) => onSenderField("address", event.target.value)}
              placeholder={t("sender.addressPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email-sender-name">{t("sender.name")}</Label>
            <Input
              id="email-sender-name"
              value={sender.name}
              onChange={(event) => onSenderField("name", event.target.value)}
              placeholder={t("sender.namePlaceholder")}
            />
          </div>
        </div>
        <Button type="button" disabled={!canSave} onClick={onSave}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("sender.save")}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <div>
          <h3 className="text-sm font-medium">{t("test.heading")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("test.description", {
              email: notificationEmail || t("test.ownerAccount"),
            })}
          </p>
        </div>
        {lastTest?.state === "failed" ? (
          <div
            className="text-sm text-destructive"
            role="status"
            data-testid="test-state"
          >
            <p>{t("test.state.failed")}</p>
            {lastTest.category ? (
              <p className="mt-1">
                {t.rich(`test.reason.${lastTest.category}`, { code })}
              </p>
            ) : null}
          </div>
        ) : lastTest ? (
          <p
            className={cn(
              "text-sm",
              lastTest.state === "unknown" && PENDING_TEXT
            )}
            role="status"
            data-testid="test-state"
          >
            {lastTest.state === "queued"
              ? t("test.state.queued")
              : t("test.state.unknown")}
          </p>
        ) : active ? (
          // The server keeps no accepted result: an active provider is one
          // whose test of the current setup was accepted.
          <p
            className={cn("text-sm", SUCCESS_TEXT)}
            role="status"
            data-testid="test-state"
          >
            {t("test.state.provider_accepted", { provider: entry.label })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!canTest}
            onClick={onTest}
          >
            {testing ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("test.send")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("activation.description")}
        </p>
      </section>
    </>
  )
}
