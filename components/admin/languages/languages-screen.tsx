"use client"

import {
  OptionalContribution,
  useOptionalContributionRun,
} from "../optional-contribution"
import { useModuleGate } from "../admin-module-state-provider"
import { useState, useTransition } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowRight,
  Loader2,
  MoreHorizontal,
  Plus,
  Star,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SUPPORTED_LOCALES, getLocaleDisplayName } from "@/lib/i18n/config"
import { cn } from "@/lib/utils"
import { LanguageTransition } from "../language-transition"
import { useLanguageRun, languagesErrorMessage } from "./errors"
import { Working } from "./impact-review"
import { LanguagePicker } from "./language-picker"
import { MakeDefaultDialog } from "./make-default-dialog"
import { RemoveLanguageDialog } from "./remove-language-dialog"
import { commandTokenArgs, languageName, orderedLocales } from "./tokens"
import type {
  AddSiteLanguageResult,
  LanguagesScreenProps,
  LanguagesState,
} from "./types"

/**
 * How a dialog's preparation went. Choosing a menu item never writes: any
 * preparation a flow needs runs after the owner confirms inside its dialog.
 */
type Preparing =
  | { status: "working" }
  | { status: "failed"; notice: string }
  | { status: "ready"; tokens?: PreparedTokens }

/** The versions a prepare step returned, for the flow that follows it. */
type PreparedTokens = {
  authorityVersion: number
  moduleConfigurationVersion: number
}

const READY: Preparing = { status: "ready" }

type DialogState =
  | null
  | { kind: "remove"; locale: string; preparing: Preparing }
  // Only the legacy open default migration reopens here; a fresh "Make
  // default" never opens a dialog.
  | { kind: "default"; locale: string; preparing: Preparing }
  | { kind: "change"; preparing: Preparing }

/** The refused Add: which language and the addresses that are in the way. */
type AddConflict = {
  locale: string
  conflicts: NonNullable<
    Extract<
      AddSiteLanguageResult,
      { code: "LANGUAGE_ADDRESS_CONFLICT" }
    >["conflicts"]
  >
  more: boolean
}

/** Shown beside Add, with links to what has to change. No dialog, no toast. */
function AddConflictMessage({ conflict }: { conflict: AddConflict }) {
  const t = useTranslations("settings.multilingualLanguages")
  return (
    <p
      role="alert"
      data-testid="add-conflict"
      className="flex flex-wrap items-center gap-x-2 text-xs text-destructive"
    >
      <span>
        {t("add.conflict", {
          language: getLocaleDisplayName(conflict.locale),
          locale: conflict.locale,
        })}
      </span>
      {conflict.conflicts.map((item, index) => {
        const label =
          item.kind === "redirect"
            ? t("add.conflictRedirect", { path: item.publicPath })
            : item.kind === "page"
              ? t("add.conflictPage", { path: item.publicPath })
              : t("add.conflictFormerAddress", { path: item.publicPath })
        const href =
          item.kind === "redirect"
            ? "/admin/redirects"
            : `/admin/pages/${item.pageId}`
        return (
          <Link
            key={`${item.kind}:${item.publicPath}:${index}`}
            href={href}
            className="font-medium underline underline-offset-2"
          >
            {label}
          </Link>
        )
      })}
      {conflict.more && <span>{t("add.conflictMore")}</span>}
    </p>
  )
}

/** A language in its own name with its small code. */
function LanguageLabel({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-2", className)}>
      <span>{languageName(code)}</span>
      <span className="font-mono text-xs text-muted-foreground">{code}</span>
    </span>
  )
}

/**
 * Reopens a change that was started earlier and is not finished. Only an open
 * default change opens by itself on load. An open legacy language change never
 * auto-opens: the banner's Continue reopens it so it can be finished or
 * stopped (a site is never stranded).
 */
function initialDialog(state: LanguagesState): DialogState {
  if (state.defaultMigration) {
    return {
      kind: "default",
      locale: state.defaultMigration.toLocale,
      preparing: READY,
    }
  }
  return null
}

/** What the banner's Continue reopens. */
function resumeDialog(state: LanguagesState): DialogState {
  return (
    initialDialog(state) ??
    (state.openOperation?.kind === "language_transition"
      ? { kind: "change", preparing: READY }
      : null)
  )
}

/** A site with several languages that is not yet multilingual-ready. */
function needsAdoption(state: LanguagesState): boolean {
  return (
    state.lifecycleState === "S2" ||
    (state.lifecycleState === "S3" && state.enabledLocales.length > 1)
  )
}

function RowMenu({
  code,
  state,
  disabled,
  busy,
  choose,
  makeDefault,
}: {
  code: string
  state: LanguagesState
  disabled: boolean
  /** This row's change is running: the trigger shows a spinner. */
  busy?: boolean
  choose: (choice: { kind: "remove"; locale: string }) => void
  makeDefault: (
    locale: string,
    run: ReturnType<typeof useOptionalContributionRun>
  ) => void
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const multi = state.enabledLocales.length > 1
  const isDefault = code === state.defaultLocale
  const name = getLocaleDisplayName(code)
  // Multilingual is switched in Modules. While it is off this is a one-language
  // site and its row has no menu: Change language is not offered here (owner,
  // 2026-11-05; Site Language Change is a separate unit). While it is on, Set
  // default and Remove apply.
  const gate = useModuleGate("multilingual")
  const run = useLanguageRun()
  const showMulti = gate.state === "on" && multi
  if (!showMulti) return null
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("list.actionsFor", { language: name })}
              disabled={disabled}
            >
              {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {t("list.actionsFor", { language: name })}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {!isDefault && (
          <DropdownMenuItem
            disabled={disabled}
            onSelect={() => makeDefault(code, run)}
          >
            <Star /> {t("list.makeDefault")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          // The default language cannot be removed: a muted item with its
          // reason, never the red destructive style.
          variant={isDefault ? "default" : "destructive"}
          disabled={disabled || isDefault}
          className={
            isDefault
              ? "items-start text-muted-foreground data-[disabled]:opacity-100"
              : undefined
          }
          onSelect={() => choose({ kind: "remove", locale: code })}
        >
          <Trash2 className={isDefault ? "mt-0.5 opacity-60" : undefined} />
          {isDefault ? (
            <span className="flex flex-col gap-0.5">
              <span className="opacity-60">{t("list.remove")}</span>
              <span className="text-xs text-muted-foreground">
                {t("list.removeDefaultFirst")}
              </span>
            </span>
          ) : (
            t("list.remove")
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Settings > Languages (variant A, "Card list"): every language in its own
 * name, a Default badge, a row menu, and an Add picker. The same screen serves
 * one language and many; module states are never shown.
 */
export function LanguagesScreen({
  state,
  actions,
  queries,
}: LanguagesScreenProps) {
  const t = useTranslations("settings.multilingualLanguages")
  const tShell = useTranslations("shell")
  const tModules = useTranslations("settings.modules")
  const gate = useModuleGate("multilingual")
  const [dialog, setDialog] = useState<DialogState>(() => initialDialog(state))
  // React 19 transitions: adding and switching the default run unattended;
  // isPending locks the controls so two changes never overlap.
  const [addPending, startAdd] = useTransition()
  const [defaultPending, startDefault] = useTransition()
  const busyAny = addPending || defaultPending
  const [switching, setSwitching] = useState<string | null>(null)
  // An address conflict from the last Add: the language stays selected.
  const menuTextMissing = queries.useMenuTextMissing(
    state.enabledLocales.filter((code) => code !== state.defaultLocale)
  )

  if (state.lifecycleState === "IX") {
    return (
      <div className="max-w-4xl space-y-4">
        <ScreenHeading />
        <p
          role="alert"
          className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        >
          {t("invalid")}
        </p>
      </div>
    )
  }

  const locales = orderedLocales(state)
  const operationOpen = state.openOperation !== null
  const close = () => setDialog(null)
  if (gate.state !== "on" && dialog && dialog.kind !== "change") setDialog(null)
  // The legacy change was finished or stopped: its dialog must go, or its
  // workflow would fall through to a Start button.
  if (!operationOpen && dialog?.kind === "change") setDialog(null)

  /**
   * Opens the flow for a menu choice. Nothing is written here: a flow that
   * needs the site prepared (adopted) does that after the owner confirms in
   * its dialog.
   */
  function choose(choice: { kind: "remove"; locale: string }) {
    setDialog({ kind: "remove", locale: choice.locale, preparing: READY })
  }

  /** One click, no dialog: the server checks everything and refuses in words. */
  function makeDefaultNow(
    locale: string,
    run: ReturnType<typeof useOptionalContributionRun>
  ) {
    setSwitching(locale)
    startDefault(async () => {
      try {
        const tokens = needsAdoption(state)
          ? await run(() =>
              actions.prepareLanguageChange(commandTokenArgs(state))
            )
          : {
              authorityVersion: state.commandTokens.authorityVersion,
              moduleConfigurationVersion:
                state.commandTokens.moduleConfigurationVersion,
            }
        if (!tokens) return
        if (tokens.authorityVersion === null) {
          toast.error(t("errors.notReady"))
          return
        }
        const authorityVersion = tokens.authorityVersion
        const result = await run(() =>
          actions.setDefaultLanguage({
            toLocale: locale,
            expectedAuthorityVersion: authorityVersion,
            expectedModuleConfigurationVersion:
              tokens.moduleConfigurationVersion,
          })
        )
        if (!result) return
        // Expected refusals come back as results, not errors.
        if (result.ok === false) {
          toast.error(t("errors.stale"))
          return
        }
        toast.success(
          t("list.defaultNow", { language: getLocaleDisplayName(locale) })
        )
      } catch (caught) {
        toast.error(languagesErrorMessage(t, caught))
      } finally {
        setSwitching(null)
      }
    })
  }

  return (
    <div className="max-w-4xl space-y-4">
      <ScreenHeading />

      {operationOpen &&
        (state.openOperation?.kind === "language_transition" ||
          gate.state === "on") &&
        dialog === null && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
            <span className="flex-1">
              {state.defaultMigration
                ? t("resume.defaultChange", {
                    language: getLocaleDisplayName(
                      state.defaultMigration.toLocale
                    ),
                  })
                : t("resume.languageChange")}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog(resumeDialog(state))}
            >
              <ArrowRight /> {t("resume.continue")}
            </Button>
          </div>
        )}

      <Card>
        <CardContent className="grid gap-4">
          <ul className="divide-y rounded-md border">
            {locales.map((code) => (
              <li key={code} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <LanguageLabel code={code} className="text-sm font-medium" />
                  {code === state.defaultLocale && (
                    <Badge variant="secondary">{t("list.default")}</Badge>
                  )}
                  <div className="ml-auto">
                    <OptionalContribution
                      moduleId="multilingual"
                      slot="admin.language-add"
                      fallbackText={tShell("modulesUnavailable")}
                      finishSetup={{
                        href: "/admin/settings/modules",
                        label: tModules("title"),
                      }}
                    >
                      <RowMenu
                        code={code}
                        state={state}
                        disabled={operationOpen || busyAny}
                        busy={defaultPending && switching === code}
                        choose={choose}
                        makeDefault={makeDefaultNow}
                      />
                    </OptionalContribution>
                  </div>
                </div>
                {code !== state.defaultLocale &&
                  (menuTextMissing?.[code] ?? 0) > 0 && (
                    <p
                      data-testid="menu-status"
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {t("list.menuTextMissing", {
                        count: menuTextMissing?.[code] ?? 0,
                      })}
                    </p>
                  )}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            {gate.state === "off" ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="add-needs-module"
              >
                {t.rich("turnOnModule", {
                  modules: (chunks) => (
                    <Link
                      href="/admin/settings/modules"
                      className="font-medium underline underline-offset-4"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            ) : (
              <OptionalContribution
                moduleId="multilingual"
                slot="admin.language-add"
                fallbackText={tShell("modulesUnavailable")}
                finishSetup={{
                  href: "/admin/settings/modules",
                  label: tModules("title"),
                }}
              >
                <LanguageAdd
                  state={state}
                  actions={actions}
                  busy={busyAny}
                  addPending={addPending}
                  startAdd={startAdd}
                />
              </OptionalContribution>
            )}
          </div>
        </CardContent>
      </Card>

      {gate.state === "on" && dialog?.kind === "remove" && (
        <OptionalContribution
          moduleId="multilingual"
          slot="admin.language-add"
          fallbackText={tShell("modulesUnavailable")}
          finishSetup={{
            href: "/admin/settings/modules",
            label: tModules("title"),
          }}
        >
          {dialog.preparing.status === "ready" ? (
            <RemoveLanguageDialog
              key={dialog.locale}
              locale={dialog.locale}
              state={state}
              actions={actions}
              queries={queries}
              needsAdoption={needsAdoption(state)}
              onClose={close}
            />
          ) : (
            <PreparingDialog
              title={t("remove.title", {
                language: getLocaleDisplayName(dialog.locale),
              })}
              description={t("remove.description", {
                language: getLocaleDisplayName(dialog.locale),
                locale: dialog.locale,
              })}
              preparing={dialog.preparing}
              onClose={close}
            />
          )}
        </OptionalContribution>
      )}
      {gate.state === "on" && dialog?.kind === "default" && (
        <OptionalContribution
          moduleId="multilingual"
          slot="admin.language-add"
          fallbackText={tShell("modulesUnavailable")}
          finishSetup={{
            href: "/admin/settings/modules",
            label: tModules("title"),
          }}
        >
          {dialog.preparing.status === "ready" ? (
            <MakeDefaultDialog
              key={dialog.locale}
              locale={dialog.locale}
              state={state}
              actions={actions}
              queries={queries}
              prepared={dialog.preparing.tokens}
              onClose={close}
            />
          ) : (
            <PreparingDialog
              title={t("makeDefault.title", {
                language: getLocaleDisplayName(dialog.locale),
              })}
              description={t("makeDefault.description", {
                language: getLocaleDisplayName(dialog.locale),
              })}
              preparing={dialog.preparing}
              onClose={close}
            />
          )}
        </OptionalContribution>
      )}
      {operationOpen && dialog?.kind === "change" && (
        <ChangeLanguageDialog preparing={dialog.preparing} onClose={close} />
      )}
    </div>
  )
}

/** The dialog shown while a prepare step runs, or after it was refused. */
function PreparingDialog({
  title,
  description,
  preparing,
  onClose,
}: {
  title: string
  description: string
  preparing: Preparing
  onClose: () => void
}) {
  const t = useTranslations("settings.multilingualLanguages")
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {preparing.status === "failed" ? (
          <>
            <p role="alert" className="text-sm text-destructive">
              {preparing.notice}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t("cancel")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <Working label={t("change.preparing")} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Today's one-language workflow, unchanged. It never switches a module and
 * runs no command itself.
 */
function ChangeLanguageDialog({
  preparing,
  onClose,
}: {
  preparing: Preparing
  onClose: () => void
}) {
  const t = useTranslations("settings.multilingualLanguages")
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("change.title")}</DialogTitle>
          <DialogDescription>{t("change.description")}</DialogDescription>
        </DialogHeader>
        {preparing.status === "ready" ? (
          <LanguageTransition />
        ) : preparing.status === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            {preparing.notice}
          </p>
        ) : (
          <Working label={t("change.preparing")} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ScreenHeading() {
  const t = useTranslations("settings.multilingualLanguages")
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
    </div>
  )
}

function LanguageAdd({
  state,
  actions,
  busy,
  addPending,
  startAdd,
}: Pick<LanguagesScreenProps, "state" | "actions"> & {
  busy: boolean
  addPending: boolean
  startAdd: ReturnType<typeof useTransition>[1]
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const run = useLanguageRun()
  const [pick, setPick] = useState("")
  const [conflict, setConflict] = useState<AddConflict | null>(null)
  const available = SUPPORTED_LOCALES.filter(
    (code) => !state.enabledLocales.includes(code)
  )
  /** Adding is silent too: no review step, no dialog. */
  function addNow() {
    const locale = pick
    const language = getLocaleDisplayName(locale)
    setConflict(null)
    startAdd(async () => {
      try {
        const result = await run(() =>
          actions.addSiteLanguage({
            locale,
            ...commandTokenArgs(state),
          })
        )
        if (!result) return
        // Expected refusals come back as results, not errors.
        if (result.ok === false) {
          if (result.code === "LANGUAGE_ADDRESS_CONFLICT") {
            // The language stays selected so the owner can fix and retry.
            setConflict({
              locale,
              conflicts: result.conflicts ?? [],
              more: result.moreConflicts === true,
            })
          } else {
            toast.error(t("errors.stale"))
          }
          return
        }
        setPick("")
        toast.success(t("add.added", { language }))
      } catch (caught) {
        toast.error(languagesErrorMessage(t, caught))
      }
    })
  }

  return (
    <>
      {" "}
      {available.length > 0 ? (
        <>
          <LanguagePicker
            value={pick}
            options={available}
            onChange={(next) => {
              // The message names the language it was raised for.
              setConflict(null)
              setPick(next)
            }}
            disabled={busy || state.openOperation !== null}
          />
          <Button
            disabled={!pick || state.openOperation !== null || busy}
            onClick={addNow}
          >
            {addPending ? <Loader2 className="animate-spin" /> : <Plus />}{" "}
            {t("list.addButton")}
          </Button>
          {conflict && <AddConflictMessage conflict={conflict} />}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("list.allAdded")}</p>
      )}{" "}
    </>
  )
}
