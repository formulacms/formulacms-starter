"use client"

import { Component, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { CONTENT_TYPES, type ContentType } from "@/convex/lib/contentTypes"

export type ArchivedContentTypesState =
  | { status: "loading"; archived: null }
  | { status: "ready"; archived: ReadonlySet<ContentType> }

export function useArchivedContentTypes(): ArchivedContentTypesState {
  const values = useQuery(api.cms.contentTypes.getArchivedContentTypes, {})
  const archived =
    values === undefined
      ? null
      : new Set(
          values.filter((value): value is ContentType =>
            (CONTENT_TYPES as readonly string[]).includes(value)
          )
        )

  return archived === null
    ? { status: "loading", archived: null }
    : { status: "ready", archived }
}

function ArchivedContentTypesUnavailable() {
  const t = useTranslations("editor.contentTypeAvailability")

  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
    >
      <p className="font-medium">{t("title")}</p>
      <p className="mt-1 text-muted-foreground">{t("description")}</p>
    </div>
  )
}

export class ArchivedContentTypesErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    return this.state.hasError
      ? (this.props.fallback ?? <ArchivedContentTypesUnavailable />)
      : this.props.children
  }
}
