"use client"

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Check, Info, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { DefaultMigrationPanel } from "./default-migration-panel"
import { useLanguageRun, languagesErrorMessage } from "./errors"
import type {
  LanguagesActions,
  LanguagesQueries,
  LanguagesState,
} from "./types"

type RowStatus = "ok" | "todo" | "advice"

function statusOf(value: boolean | null | undefined): RowStatus {
  return value === true ? "ok" : value === false ? "todo" : "advice"
}

function CheckRow({
  status,
  label,
  children,
}: {
  status: RowStatus
  label: string
  children?: React.ReactNode
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const Icon = status === "ok" ? Check : status === "todo" ? X : Info
  return (
    <li className="flex items-center gap-3 rounded-md border px-3 py-2">
      <span
        role="img"
        aria-label={t(`makeDefault.status.${status}`)}
        className={
          status === "ok"
            ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : status === "todo"
              ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
              : "flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="flex-1 text-sm">{label}</span>
      {children}
    </li>
  )
}

/**
 * Make a language the default: a short checklist first, then today's address
 * and page review for the change, then the switch itself.
 */
export function MakeDefaultDialog({
  locale,
  state,
  actions,
  queries,
  prepared,
  onClose,
}: {
  locale: string
  state: LanguagesState
  actions: LanguagesActions
  queries: LanguagesQueries
  /** The versions a prepare step just returned, when the site needed one. */
  prepared?: { authorityVersion: number; moduleConfigurationVersion: number }
  onClose: () => void
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const language = getLocaleDisplayName(locale)
  const fromLocale = state.defaultLocale ?? locale
  const from = getLocaleDisplayName(fromLocale)
  const run = useLanguageRun()
  const readiness = queries.useDefaultReadiness(locale)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const migration = state.defaultMigration
  const blocked =
    readiness?.homePublished === false || readiness?.menuText === false

  const authorityVersion = prepared?.authorityVersion ?? state.version
  const moduleConfigurationVersion =
    prepared?.moduleConfigurationVersion ?? state.moduleConfigurationVersion

  async function start() {
    if (busy || authorityVersion === null) return
    setBusy(true)
    setError(null)
    try {
      await run(() => actions.startDefaultLanguageMigration({
        toLocale: locale,
        expectedAuthorityVersion: authorityVersion,
        expectedModuleConfigurationVersion: moduleConfigurationVersion,
      }))
    } catch (caught) {
      setError(languagesErrorMessage(t, caught))
    } finally {
      setBusy(false)
    }
  }

  async function copyDescription() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await run(() => actions.copySiteDescription({
        fromLocale,
        toLocale: locale,
      }))
      if (!result) return
      if (result.copied) toast.success(t("makeDefault.copied"))
      else setError(t("makeDefault.nothingToCopy", { language: from }))
    } catch (caught) {
      setError(languagesErrorMessage(t, caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("makeDefault.title", { language })}</DialogTitle>
          <DialogDescription>
            {migration
              ? t("makeDefault.reviewDescription", { language })
              : t("makeDefault.description", { language })}
          </DialogDescription>
        </DialogHeader>

        {migration ? (
          <DefaultMigrationPanel
            migration={migration}
            authorityVersion={state.version}
            queries={queries}
            actions={actions}
            onFinished={onClose}
          />
        ) : (
          <>
            <ul className="grid gap-2" aria-label={t("makeDefault.checklist")}>
              <CheckRow
                status={statusOf(readiness?.homePublished)}
                label={t("makeDefault.home", { language })}
              >
                {readiness?.homePublished === false && (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admin/pages">{t("makeDefault.openPages")}</Link>
                  </Button>
                )}
              </CheckRow>
              <CheckRow
                status={statusOf(readiness?.menuText)}
                label={t("makeDefault.menu", { language })}
              >
                {readiness?.menuText === false && (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admin/menus">{t("makeDefault.openMenus")}</Link>
                  </Button>
                )}
              </CheckRow>
              <CheckRow
                status={statusOf(readiness?.siteDescription)}
                label={t("makeDefault.descriptionRow", { language })}
              >
                {readiness?.siteDescription === false && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void copyDescription()}
                  >
                    {t("makeDefault.copyFrom", { language: from })}
                  </Button>
                )}
              </CheckRow>
            </ul>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {t("makeDefault.addressNote", { old: fromLocale, new: locale })}
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {t("cancel")}
              </Button>
              <Button
                disabled={busy || blocked || authorityVersion === null}
                onClick={() => void start()}
              >
                {t("makeDefault.start")}
              </Button>
            </DialogFooter>
          </>
        )}
        {migration && error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
