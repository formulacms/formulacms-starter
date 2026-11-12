"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { catchError } from "next/error"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { useModuleGate } from "./admin-module-state-provider"
import { moduleFailureState } from "./module-gate"

type Setup =
  | "render"
  | { label: string; href: string; text: string; description: string }
type RouteProps = {
  moduleId: string
  title: string
  offNotice: string
  errorText: string
  errorDescription: string
  retryLabel: string
  needsSetup: Setup
  loading?: ReactNode
  children: ReactNode
  /** Recovery seam: re-create the failed client subscription with a full load. */
  reloadPage?: () => void
}
let previousOffNotice: string | number | undefined

export function OptionalModuleOffRoute({ notice }: { notice: string }) {
  const router = useRouter()
  const notified = useRef(false)
  useEffect(() => {
    if (notified.current) return
    notified.current = true
    if (previousOffNotice !== undefined) toast.dismiss(previousOffNotice)
    // Sonner allocates a new id for every mount. Reusing one races dismissal (#791).
    previousOffNotice = toast.info(notice)
    router.replace("/admin/settings/modules")
  }, [notice, router])
  return null
}

function RouteError({
  moduleId,
  error,
  title,
  errorText,
  errorDescription,
  retryLabel,
  retry,
}: {
  moduleId: string
  error: unknown
  title: string
  errorText: string
  errorDescription: string
  retryLabel: string
  retry: () => void
}) {
  useEffect(() => {
    reportContainedModuleFailure(moduleId, "admin.route", error)
  }, [moduleId, error])
  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div
        role="alert"
        className="max-w-xl space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-6"
      >
        <p className="font-medium">{errorText}</p>
        <p className="text-sm text-muted-foreground">{errorDescription}</p>
        <Button type="button" variant="outline" onClick={retry}>
          {retryLabel}
        </Button>
      </div>
    </div>
  )
}

function RouteSetup({
  title,
  label,
  href,
  text,
  description,
}: Exclude<Setup, "render"> & { title: string }) {
  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="max-w-xl space-y-3 rounded-md border p-6">
        <p className="font-medium">{text}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button asChild variant="outline">
          <Link href={href}>{label}</Link>
        </Button>
      </div>
    </div>
  )
}

function reloadPage() {
  window.location.reload()
}

// A second failure while rendering a setup page remains local to this route.
const RouteRecovery = catchError<Omit<RouteProps, "children">>(
  (props, { error, retry }) => (
    <RouteError {...props} error={error} retry={retry} />
  )
)
const RouteBoundary = catchError<
  Omit<RouteProps, "children"> & { content: ReactNode }
>((props, { error, retry }) => {
  const state = moduleFailureState(error)
  if (state === "off") return <OptionalModuleOffRoute notice={props.offNotice} />
  if (state === "needs_setup")
    return props.needsSetup === "render" ? (
      props.content
    ) : (
      <RouteSetup title={props.title} {...props.needsSetup} />
    )
  return <RouteError {...props} error={error} retry={retry} />
})

/** No optional child mounts during loading, off, gate error or linked setup. */
export function OptionalModuleRoute({ children, ...props }: RouteProps) {
  const gate = useModuleGate(props.moduleId)
  if (gate.state === "loading")
    return props.loading ?? (
      <div
        aria-busy={true}
        className="h-20 animate-pulse rounded-md bg-muted"
      />
    )
  if (gate.state === "off") return <OptionalModuleOffRoute notice={props.offNotice} />
  if (gate.state === "error")
    return (
      <RouteError
        {...props}
        error={gate.errorCode ?? "CMS_MODULE_STATE_UNAVAILABLE"}
        retry={props.reloadPage ?? reloadPage}
      />
    )
  if (gate.state === "needs_setup" && props.needsSetup !== "render")
    return <RouteSetup title={props.title} {...props.needsSetup} />
  return (
    <RouteRecovery {...props}>
      <RouteBoundary {...props} content={children}>
        {children}
      </RouteBoundary>
    </RouteRecovery>
  )
}
