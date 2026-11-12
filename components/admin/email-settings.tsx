"use client"

import { adminEmailProvider } from "@/lib/i18n/admin-metadata"

import { useState } from "react"
import { useAction, useMutation, useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react"
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

type SenderDraft = {
  address: string
  name: string
}

type ProviderReadiness = "unknown" | "needs_setup" | "ready"

export function EmailSettings() {
  const t = useTranslations("settings.email")
  const tMetadata = useTranslations("metadata")
  const tCommon = useTranslations("settings.common")

  const owner = useQuery(api.cms.owner.getOwnerSession)
  const canView = owner !== undefined && owner !== null
  const settings = useQuery(
    api.email.getEmailProviderSettings,
    canView ? {} : "skip"
  )
  const saveConfiguration = useMutation(
    api.email.saveEmailProviderConfiguration
  )
  const activateProvider = useMutation(api.email.activateEmailProvider)
  const deactivateProvider = useMutation(api.email.deactivateEmailProvider)
  const checkConfiguration = useAction(
    api.email.checkEmailProviderConfiguration
  )
  const sendTestEmail = useAction(api.email.sendTestEmail)
  const confirm = useConfirm()

  // undefined follows persisted selection; null is an explicit mobile "back".
  const [localSelection, setLocalSelection] = useState<
    string | null | undefined
  >(undefined)
  const [draft, setDraft] = useState<SenderDraft | null>(null)
  const [readinessOverride, setReadinessOverride] =
    useState<ProviderReadiness>("unknown")
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [testing, setTesting] = useState(false)
  const [activating, setActivating] = useState(false)
  const [deactivating, setDeactivating] = useState(false)

  if (owner === undefined) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tCommon("loading")}
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
  if (settings === undefined) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tCommon("loading")}
      </div>
    )
  }

  const catalogue = settings.catalogue.map((entry) =>
    adminEmailProvider(entry, tMetadata)
  )
  const configuredProvider = catalogue.find(
    (entry) => entry.id === settings.configuredProviderId
  )
  const selectedId =
    localSelection === undefined
      ? (settings.configuredProviderId ?? null)
      : localSelection
  const selected = catalogue.find((entry) => entry.id === selectedId)
  const loadedSender = {
    address: settings.sender?.address ?? "",
    name: settings.sender?.name ?? "",
  }
  const sender = draft ?? loadedSender
  const dirty = draft !== null
  const readiness: ProviderReadiness =
    readinessOverride !== "unknown"
      ? readinessOverride
      : settings.configuredProviderId === "resend"
        ? settings.readiness === "ready"
          ? "ready"
          : "needs_setup"
        : "unknown"
  const acceptedCurrentTest = settings.lastTest?.state === "provider_accepted"
  const canTest =
    settings.configuredProviderId === "resend" &&
    readiness === "ready" &&
    !dirty &&
    !saving &&
    !testing
  const canActivate =
    settings.configuredProviderId === "resend" &&
    settings.activeProviderId === null &&
    readiness === "ready" &&
    acceptedCurrentTest &&
    !dirty &&
    !activating

  function setSenderField(field: keyof SenderDraft, value: string) {
    setDraft({ ...sender, [field]: value })
  }

  async function saveResend() {
    setSaving(true)
    try {
      await saveConfiguration({
        providerId: "resend",
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

  async function checkResend() {
    setChecking(true)
    try {
      const result = await checkConfiguration({ providerId: "resend" })
      setReadinessOverride(result.readiness)
      toast.success(
        result.readiness === "ready"
          ? t("toast.configurationReady")
          : t("toast.configurationMissing")
      )
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
        toast.success(t("toast.testQueued"))
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

  async function activateResend() {
    setActivating(true)
    try {
      await activateProvider({ providerId: "resend" })
      toast.success(t("toast.activated"))
    } catch {
      toast.error(t("toast.failedActivate"))
    } finally {
      setActivating(false)
    }
  }

  async function turnOffResend(provider: string) {
    const ok = await confirm({
      title: t("activation.turnOffTitle", { provider }),
      description: t("activation.turnOffDescription"),
      confirmText: t("activation.turnOffConfirm"),
      destructive: true,
    })
    if (!ok) return
    setDeactivating(true)
    try {
      await deactivateProvider({ providerId: "resend" })
      toast.success(t("toast.deactivated", { provider }))
    } catch {
      toast.error(t("toast.failedDeactivate", { provider }))
    } finally {
      setDeactivating(false)
    }
  }

  function selectProvider(entry: CatalogueEntry) {
    setLocalSelection(entry.id)
    setReadinessOverride("unknown")
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">
            {settings.activeProviderId
              ? t("status.active", {
                  provider: configuredProvider?.label ?? "Resend",
                })
              : t("status.inactive")}
          </h2>
          {settings.activeProviderId ? (
            <Badge>{t("status.activeBadge")}</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {settings.activeProviderId
            ? t("status.activeDescription")
            : t("status.inactiveDescription")}
        </p>
      </section>

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
              <button
                key={entry.id}
                type="button"
                onClick={() => selectProvider(entry)}
                className={cn(
                  "w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-accent",
                  selected?.id === entry.id && "bg-accent"
                )}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="font-medium">{entry.label}</span>
                  {entry.bundled ? (
                    <Badge variant="secondary">{t("catalogue.included")}</Badge>
                  ) : null}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {entry.description}
                </span>
              </button>
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
                  {selected.bundled ? (
                    <Badge variant="secondary">{t("catalogue.included")}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selected.description}
                </p>
              </div>

              {selected.registered && selected.id === "resend" ? (
                <>
                  <section className="rounded-md border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-medium">
                          {t("readiness.heading")}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("readiness.description")}
                        </p>
                      </div>
                      <Badge
                        variant={readiness === "ready" ? "default" : "outline"}
                      >
                        {readiness === "ready"
                          ? t("readiness.detected")
                          : readiness === "needs_setup"
                            ? t("readiness.notDetected")
                            : t("readiness.notChecked")}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-4"
                      disabled={checking}
                      onClick={checkResend}
                    >
                      {checking ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      {t("readiness.check")}
                    </Button>
                  </section>

                  <section className="space-y-4 rounded-md border p-4">
                    <div>
                      <h3 className="text-sm font-medium">
                        {t("sender.heading")}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("sender.description")}
                      </p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="email-sender-address">
                          {t("sender.address")}
                        </Label>
                        <Input
                          id="email-sender-address"
                          type="email"
                          value={sender.address}
                          onChange={(event) =>
                            setSenderField("address", event.target.value)
                          }
                          placeholder={t("sender.addressPlaceholder")}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="email-sender-name">
                          {t("sender.name")}
                        </Label>
                        <Input
                          id="email-sender-name"
                          value={sender.name}
                          onChange={(event) =>
                            setSenderField("name", event.target.value)
                          }
                          placeholder={t("sender.namePlaceholder")}
                        />
                      </div>
                    </div>
                    <Button
                      type="button"
                      disabled={!dirty || saving}
                      onClick={saveResend}
                    >
                      {saving ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      {t("sender.save")}
                    </Button>
                  </section>

                  <section className="space-y-4 rounded-md border p-4">
                    <div>
                      <h3 className="text-sm font-medium">
                        {t("test.heading")}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("test.description", {
                          email: owner.email ?? t("test.ownerAccount"),
                        })}
                      </p>
                    </div>
                    {settings.lastTest ? (
                      <p className="text-sm" role="status">
                        {settings.lastTest.state === "queued"
                          ? t("test.state.queued")
                          : settings.lastTest.state === "provider_accepted"
                            ? t("test.state.provider_accepted")
                            : settings.lastTest.state === "failed"
                              ? t("test.state.failed")
                              : t("test.state.unknown")}
                      </p>
                    ) : null}
                    {settings.activeProviderId === selected.id ? (
                      <p className="text-sm">
                        {t("activation.status", { provider: selected.label })}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canTest}
                        onClick={runDeliveryTest}
                      >
                        {testing ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                        {t("test.send")}
                      </Button>
                      {settings.activeProviderId === selected.id ? (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={deactivating}
                          onClick={() => turnOffResend(selected.label)}
                        >
                          {deactivating ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          {t("activation.turnOff")}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          disabled={!canActivate}
                          onClick={activateResend}
                        >
                          {activating ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          {t("activation.activate")}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("activation.description")}
                    </p>
                  </section>
                </>
              ) : (
                <section className="rounded-md border p-4">
                  <p className="text-sm text-muted-foreground">
                    {t("catalogue.developerDescription")}
                  </p>
                  <Button asChild className="mt-4">
                    <a
                      href={selected.documentationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("catalogue.addProvider")}
                      <ExternalLink className="size-4" />
                    </a>
                  </Button>
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
