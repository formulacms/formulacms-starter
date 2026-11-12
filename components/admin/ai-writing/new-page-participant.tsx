"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { Sparkles } from "lucide-react"
import { api } from "@/convex/_generated/api"
import type { ContentType } from "@/convex/lib/contentTypes"
import { Button } from "@/components/ui/button"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { useModuleGate } from "../admin-module-state-provider"
import type {
  AdminAiWritingNewPageHostProps,
  AdminAiWritingNewPageHostResult,
} from "../contributions/ai-writing"
import { OptionalContribution } from "../optional-contribution"
import {
  PageJobList,
  RunningJobNotice,
  focusPageJobCard,
  useWritingState,
} from "./page-jobs"
import { PageWizard, type WriteLocale } from "./page-wizard"

const NO_PARTICIPATION: AdminAiWritingNewPageHostResult = {
  busy: false,
  starterHeroControl: null,
  pageWizardControl: null,
}

const isWriteLocale = (code: string): code is WriteLocale =>
  code === "en" || code === "fr"

/**
 * Writing's New Page participant. The host only reads the AI module gate and
 * always renders the form at the same place; every AI read lives in the parts
 * below, mounted only while the module is on.
 */
export function NewPageWritingSlot({
  children,
  pageType,
  locale,
  isCreating,
  canCreateSelected,
}: AdminAiWritingNewPageHostProps) {
  const gate = useModuleGate("ai")
  const on = gate.state === "on" || gate.state === "needs_setup"
  // Set when the button was pressed while another page job runs.
  const [blocked, setBlocked] = useState(false)
  return (
    <>
      {on && <WritingJobs />}
      {children(
        on
          ? {
              ...NO_PARTICIPATION,
              pageWizardControl: (
                <WritingControl
                  pageType={pageType}
                  locale={locale}
                  isCreating={isCreating}
                  canCreateSelected={canCreateSelected}
                  onBlocked={setBlocked}
                />
              ),
            }
          : NO_PARTICIPATION
      )}
      {on && <WritingKeyNotice pageType={pageType} />}
      {on && blocked && (
        <WritingRunningNotice onFollowed={() => setBlocked(false)} />
      )}
    </>
  )
}

/** The job cards above the form, contained so a failure never breaks the form. */
function WritingJobs() {
  const t = useTranslations("pages.aiWrite")
  const tShell = useTranslations("shell")
  const { status, ready } = useWritingState()
  useEffect(() => {
    if (status instanceof Error)
      reportContainedModuleFailure("ai", "admin.contribution", status)
  }, [status])
  if (!ready) return null
  return (
    <OptionalContribution
      moduleId="ai"
      slot="admin.ai-writing"
      fallbackText={tShell("modulesUnavailable")}
      finishSetup={{ href: "/admin/settings/ai", label: t("settingsLink") }}
    >
      <PageJobList />
    </OptionalContribution>
  )
}

export function ApiKeyNotice({
  connection,
}: {
  connection: ReturnType<typeof useWritingState>["connection"]
}) {
  const t = useTranslations("pages.aiWrite")
  const tSetup = useTranslations("settings.modules.aiSetup")
  const tProviders = useTranslations("settings.aiScreen.providers")
  return (
    <div
      data-testid="api-key-notice"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <p>
        {connection?.state === "refused"
          ? t("keyRefused", {
              provider: tProviders(connection.provider),
              envVar: connection.envVar,
            })
          : tSetup("missing")}
      </p>
      <Button variant="link" data-testid="ai-settings-link" asChild>
        <Link href="/admin/settings/ai">{t("settingsLink")}</Link>
      </Button>
    </div>
  )
}

const writeLanguages = (enabledLocales: readonly string[] | undefined) =>
  (enabledLocales ?? []).filter(isWriteLocale)

/**
 * The missing or refused key notice, on its own line under the form (never in
 * its button row). It shows only where the button would show once Writing is
 * ready: a Page, on a site with English or French.
 */
function WritingKeyNotice({ pageType }: { pageType: ContentType }) {
  const { loaded, ready, connection } = useWritingState()
  const siteConfig = useQuery(api.cms.settings.getSiteConfig)
  if (!loaded || ready || pageType !== "page") return null
  if (writeLanguages(siteConfig?.enabledLocales).length === 0) return null
  return <ApiKeyNotice connection={connection} />
}

/** The "Write page with AI" button and its wizard, in the form's button row. */
function WritingControl({
  pageType,
  locale,
  isCreating,
  canCreateSelected,
  onBlocked,
}: {
  pageType: ContentType
  locale: string
  isCreating: boolean
  canCreateSelected: boolean
  onBlocked: (blocked: boolean) => void
}) {
  const t = useTranslations("pages.aiWrite")
  const { ready, active } = useWritingState()
  const siteConfig = useQuery(api.cms.settings.getSiteConfig)
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState(0)
  // The wizard closes when Writing stops being ready.
  if (open && !ready) setOpen(false)
  // Not ready: the key notice shows under the form instead.
  if (!ready) return null
  // The job writes only Pages, in English or French: no button where it cannot work.
  const languages = writeLanguages(siteConfig?.enabledLocales)
  if (pageType !== "page" || !siteConfig || languages.length === 0) return null
  const initialLocale =
    languages.find((code) => code === locale) ?? languages[0]!
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (active) {
              onBlocked(true)
              return
            }
            onBlocked(false)
            setSession((current) => current + 1)
            setOpen(true)
          }}
          disabled={isCreating || !canCreateSelected}
          className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Sparkles className="size-4" />
          {t("button")}
        </button>
      </span>
      <PageWizard
        key={session}
        open={open}
        onOpenChange={setOpen}
        languages={languages}
        initialLocale={initialLocale}
        defaultLocale={siteConfig.defaultLocale}
      />
    </>
  )
}

/** The running-job notice on its own line under the form. */
function WritingRunningNotice({ onFollowed }: { onFollowed: () => void }) {
  const { ready, active } = useWritingState()
  if (!ready || !active) return null
  return (
    <RunningJobNotice
      active={active}
      onFollow={(jobId) => {
        onFollowed()
        focusPageJobCard(jobId)
      }}
    />
  )
}
