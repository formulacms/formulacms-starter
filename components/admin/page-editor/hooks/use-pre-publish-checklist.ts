"use client"

import { useEffect, useState } from "react"
import { useQueries } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { PrePublishChecklist } from "../lib/types"

type PrePublishChecklistResult = PrePublishChecklist | Error | undefined
type ChecklistQuerySet = Record<
  string,
  {
    query: typeof api.cms.pages.getPrePublishChecklist
    args: { pageId: Id<"pages">; locale: string }
  }
>
const EMPTY_QUERY_SET: ChecklistQuerySet = {}

function checklistRequestKey(
  pageId: Id<"pages">,
  locale: string,
  enabled: boolean,
  temporarilySkipped: boolean
): string {
  return JSON.stringify([pageId, locale, enabled, temporarilySkipped])
}

export function usePrePublishChecklist(
  pageId: Id<"pages">,
  locale: string,
  enabled: boolean
): { result: PrePublishChecklistResult; retry(): void } {
  const [temporarilySkipped, setTemporarilySkipped] = useState(false)
  const requestKey = checklistRequestKey(
    pageId,
    locale,
    enabled,
    temporarilySkipped
  )
  const [activeRequest, setActiveRequest] = useState<{
    key: string
    queries: ChecklistQuerySet
  }>(() => ({
    key: requestKey,
    queries:
      enabled && !temporarilySkipped
        ? {
            checklist: {
              query: api.cms.pages.getPrePublishChecklist,
              args: { pageId, locale },
            },
          }
        : EMPTY_QUERY_SET,
  }))

  useEffect(() => {
    if (activeRequest.key === requestKey) return
    const timer = window.setTimeout(() => {
      setActiveRequest({
        key: requestKey,
        queries:
          enabled && !temporarilySkipped
            ? {
                checklist: {
                  query: api.cms.pages.getPrePublishChecklist,
                  args: { pageId, locale },
                },
              }
            : EMPTY_QUERY_SET,
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    activeRequest.key,
    enabled,
    locale,
    pageId,
    requestKey,
    temporarilySkipped,
  ])

  useEffect(() => {
    if (!temporarilySkipped) return
    const timer = window.setTimeout(() => setTemporarilySkipped(false), 0)
    return () => window.clearTimeout(timer)
  }, [temporarilySkipped])

  // Drop the old observer before installing a request for a changed locale or
  // after Retry; the next state commit adds the keyed request back.
  const queries =
    activeRequest.key === requestKey ? activeRequest.queries : EMPTY_QUERY_SET
  const results = useQueries(queries)
  const result = results.checklist

  return {
    result:
      result instanceof Error
        ? result
        : (result as PrePublishChecklist | undefined),
    retry: () => setTemporarilySkipped(true),
  }
}
