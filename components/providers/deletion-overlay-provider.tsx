"use client"

import { createContext, use, useEffect, useState } from "react"
import Link from "next/link"
import { Check, CircleAlert, Loader2 } from "lucide-react"
import {
  deleteSliceAction,
  retrySliceDeletionCleanupAction,
  type DeleteSliceResult,
} from "@/app/(core)/admin/(authenticated)/slices/actions"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

type DeleteBlocker = Extract<DeleteSliceResult, { status: "blocked" }>

type DeletionState =
  | { status: "idle" }
  | { status: "deleting"; label: string }
  | { status: "blocked"; label: string; blocker: DeleteBlocker }
  | {
      status: "cleanup_pending"
      type: string
      label: string
      message: string
    }
  | { status: "done"; label: string }
  | { status: "error"; label: string; message: string }

const DeletionContext = createContext<{
  startDeletion: (params: { type: string; label: string }) => void
} | null>(null)

export function DeletionOverlayProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [state, setState] = useState<DeletionState>({ status: "idle" })

  useEffect(() => {
    if (state.status !== "deleting") return
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [state.status])

  const doneLabel = state.status === "done" ? state.label : null

  useEffect(() => {
    if (!doneLabel) return
    const timeout = setTimeout(() => {
      // Hard navigation so the browser waits for the dev server to finish
      // recompiling after file deletions instead of serving stale RSC cache.
      window.location.replace("/admin/slices")
    }, 800)
    return () => clearTimeout(timeout)
  }, [doneLabel])

  async function startDeletion({
    type,
    label,
  }: {
    type: string
    label: string
  }) {
    setState({ status: "deleting", label })

    try {
      const result = await deleteSliceAction({ type })
      if (result.status === "blocked") {
        setState({ status: "blocked", label, blocker: result })
        return
      }
      if (result.status === "cleanup_pending") {
        setState({
          status: "cleanup_pending",
          type,
          label,
          message: result.message,
        })
        return
      }
      setState({ status: "done", label })
    } catch (error) {
      setState({
        status: "error",
        label,
        message: error instanceof Error ? error.message : "Deletion failed",
      })
    }
  }

  async function retryCleanup(type: string, label: string) {
    setState({ status: "deleting", label })
    try {
      await retrySliceDeletionCleanupAction({ type })
      setState({ status: "done", label })
    } catch (error) {
      setState({
        status: "cleanup_pending",
        type,
        label,
        message:
          error instanceof Error
            ? error.message
            : "Curation cleanup is still unavailable.",
      })
    }
  }

  const isOpen = state.status !== "idle"
  const isError = state.status === "error"
  const canDismiss = isError || state.status === "blocked"

  return (
    <DeletionContext.Provider value={{ startDeletion }}>
      {children}
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open && canDismiss) setState({ status: "idle" })
        }}
      >
        {isOpen && (
          <DialogContent
            showCloseButton={false}
            className="sm:max-w-sm"
            onEscapeKeyDown={(e) => {
              if (!canDismiss) e.preventDefault()
            }}
            onInteractOutside={(e) => {
              if (!canDismiss) e.preventDefault()
            }}
            onPointerDownOutside={(e) => {
              if (!canDismiss) e.preventDefault()
            }}
          >
            {state.status === "deleting" && (
              <DeletingContent label={state.label} />
            )}
            {state.status === "blocked" && (
              <BlockedContent
                label={state.label}
                blocker={state.blocker}
                onClose={() => setState({ status: "idle" })}
              />
            )}
            {state.status === "cleanup_pending" && (
              <CleanupPendingContent
                label={state.label}
                message={state.message}
                onRetry={() => retryCleanup(state.type, state.label)}
              />
            )}
            {state.status === "done" && <DoneContent label={state.label} />}
            {state.status === "error" && (
              <ErrorContent
                label={state.label}
                message={state.message}
                onClose={() => setState({ status: "idle" })}
              />
            )}
          </DialogContent>
        )}
      </Dialog>
    </DeletionContext.Provider>
  )
}

function DeletingContent({ label }: { label: string }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Deleting {label}</DialogTitle>
        <DialogDescription>
          This may take a minute. Please don&apos;t close this tab.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2.5 text-sm font-medium">
        <Loader2 className="size-4 animate-spin" />
        Checking lifecycle and cleaning up local files…
      </div>
    </>
  )
}

function BlockedContent({
  label,
  blocker,
  onClose,
}: {
  label: string
  blocker: DeleteBlocker
  onClose: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Can&apos;t delete {label}</DialogTitle>
        <DialogDescription>{blocker.message}</DialogDescription>
      </DialogHeader>
      {blocker.reason === "in_use" && (
        <div className="space-y-3 text-sm">
          <ul className="space-y-2">
            {blocker.pages.slice(0, 5).map((page) => (
              <li key={page.pageId}>
                <Link
                  href={`/admin/pages/${page.pageId}`}
                  className="block rounded-md border p-2.5 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <div className="font-medium">
                    {page.title}
                    {page.deleted ? " · Trash" : ""}
                  </div>
                  <div className="text-muted-foreground">
                    {page.savedCount} saved · {page.stagedCount} staged ·{" "}
                    {page.locales
                      .map((locale) => locale.toUpperCase())
                      .join(", ")}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {blocker.pageCount > blocker.pages.slice(0, 5).length && (
            <p className="text-muted-foreground">
              + {blocker.pageCount - blocker.pages.slice(0, 5).length} more
            </p>
          )}
          <p>
            Remove these Block instances from each Page&apos;s Working Draft,
            including Pages in Trash, then try again.
          </p>
        </div>
      )}
      {blocker.reason === "active" && (
        <p className="text-sm">
          Archive it from the Block catalog, then retry.
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  )
}

function CleanupPendingContent({
  label,
  message,
  onRetry,
}: {
  label: string
  message: string
  onRetry: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Finish deleting {label}</DialogTitle>
        <DialogDescription>{message}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button onClick={onRetry}>Retry cleanup</Button>
      </DialogFooter>
    </>
  )
}

function DoneContent({ label }: { label: string }) {
  return (
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2">
        <Check className="size-5 text-green-600" />
        Deleted {label}
      </DialogTitle>
      <DialogDescription>Redirecting to block catalog...</DialogDescription>
    </DialogHeader>
  )
}

function ErrorContent({
  label,
  message,
  onClose,
}: {
  label: string
  message: string
  onClose: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CircleAlert className="size-5 text-destructive" />
          Failed to delete {label}
        </DialogTitle>
        <DialogDescription>{message}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  )
}

export function useSliceDeletion() {
  const ctx = use(DeletionContext)
  if (!ctx)
    throw new Error(
      "useSliceDeletion must be used within DeletionOverlayProvider"
    )
  return ctx
}
