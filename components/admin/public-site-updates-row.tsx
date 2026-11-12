"use client"

import { useState } from "react"
import Link from "next/link"
import { useMutation, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import {
  AlertTriangle,
  Check,
  CloudOff,
  Info,
  Loader2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { useCaughtError } from "@/lib/i18n/use-caught-error"

const MAX_RETRY_CALLS = 20

/** Where the Site address field lives; the link focuses it when it is on screen. */
export const SITE_ADDRESS_HREF = "/admin/settings#siteUrl"

export type PublicSiteUpdateState = FunctionReturnType<
  typeof api.cms.revalidate.getRevalidationHealth
>["updateState"]

export type PublicUpdatesRetry = { pushing: boolean; retry: () => void }

/**
 * Retry for a lasting failure: requeue the undelivered updates in bounded
 * batches. A missing site address comes back as a result (never an error), so
 * it is shown as a plain message.
 */
export function usePublicUpdatesRetry(): PublicUpdatesRetry {
  const t = useTranslations("settings.languageLifecycle")
  const tCaught = useTranslations("caughtErrors")
  const displayError = useCaughtError()
  const requeue = useMutation(
    api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents
  )
  const [pushing, setPushing] = useState(false)

  async function retry() {
    if (pushing) return
    setPushing(true)
    try {
      // One bounded batch per call; the cap is a safety net, far above the
      // supported few hundred intents.
      let queued = 0
      let moreRemain = true
      for (let call = 0; moreRemain && call < MAX_RETRY_CALLS; call += 1) {
        const result = await requeue({})
        if (result.ok === false) {
          toast.message(tCaught("revalidationUnconfigured"))
          return
        }
        if (result.requeued === undefined || result.moreRemain === undefined) {
          break
        }
        queued += result.requeued
        moreRemain = result.moreRemain
      }
      if (queued > 0) toast.success(t("pushStarted"))
      else toast.message(t("pushNothing"))
    } catch (error) {
      toast.error(displayError(error, t("pushFailed")))
    } finally {
      setPushing(false)
    }
  }

  return { pushing, retry: () => void retry() }
}

/** Opens the Site address field: focuses it in place when this page has it. */
function SiteAddressLink({ children }: { children: React.ReactNode }) {
  return (
    <Link
      href={SITE_ADDRESS_HREF}
      onClick={(event) => {
        const field = document.getElementById("siteUrl")
        if (!field) return
        event.preventDefault()
        field.focus()
      }}
      className="rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </Link>
  )
}

export function RetryButton({
  retry,
  className,
}: {
  retry: PublicUpdatesRetry
  className?: string
}) {
  const t = useTranslations("settings.languageLifecycle")
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      disabled={retry.pushing}
      onClick={retry.retry}
    >
      {retry.pushing ? t("retrying") : t("retry")}
    </Button>
  )
}

/**
 * One calm line for each of the six update states. Only a real failure is a
 * warning with Retry; a missing address or code is a neutral hint.
 */
export function PublicSiteUpdateStatus({
  state,
  retry,
}: {
  state: PublicSiteUpdateState
  retry: PublicUpdatesRetry
}) {
  const t = useTranslations("settings.languageLifecycle")
  switch (state) {
    case "no_address":
      return (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Info className="size-4 shrink-0" aria-hidden />
          <span>
            {t.rich("noAddress", {
              link: (chunks) => <SiteAddressLink>{chunks}</SiteAddressLink>,
            })}
          </span>
        </span>
      )
    case "incomplete":
      return (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Info className="size-4 shrink-0" aria-hidden />
          {t("incomplete")}
        </span>
      )
    case "updating":
      return (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("updating")}
        </span>
      )
    case "local_unreachable":
      return (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <CloudOff className="size-4" aria-hidden />
          {t("local")}
        </span>
      )
    case "failed":
      return (
        <>
          <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4" aria-hidden />
            {t("failing")}
          </span>
          <RetryButton retry={retry} />
        </>
      )
    case "ok":
      return (
        <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
          <Check className="size-4" aria-hidden />
          {t("upToDate")}
        </span>
      )
  }
}

/**
 * Settings › General: whether the last language or module change reached the
 * public site. The state comes from the backend's `updateState`; a lasting
 * failure is the only warning and the only state with Retry. A local site that
 * cannot be reached is quiet and never an alarm.
 */
export function PublicSiteUpdatesRow() {
  const t = useTranslations("settings.languageLifecycle")
  const health = useQuery(api.cms.revalidate.getRevalidationHealth, {})
  const retry = usePublicUpdatesRetry()

  if (health === undefined) return null

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border px-4 py-3"
      role="status"
    >
      <span className="text-sm font-medium">{t("title")}</span>
      <span className="ml-auto flex flex-wrap items-center gap-3 text-sm">
        <PublicSiteUpdateStatus state={health.updateState} retry={retry} />
      </span>
    </div>
  )
}
