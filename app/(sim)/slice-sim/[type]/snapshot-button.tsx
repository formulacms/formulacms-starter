"use client"

import { useTransition } from "react"
import { Camera, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  SNAPSHOT_UPDATED_EVENT,
  type SnapshotUpdatedDetail,
} from "@/components/admin/slices/slice-sim-events"
import { captureSliceThumbnail } from "./actions"

export function SnapshotButton({
  type,
  iconOnly = false,
}: {
  type: string
  iconOnly?: boolean
}) {
  const [pending, startTransition] = useTransition()

  return (
    <Button
      type="button"
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon-sm" : "sm"}
      aria-label={pending ? "Capturing snapshot" : "Take snapshot"}
      title={
        iconOnly ? undefined : pending ? "Capturing snapshot" : "Take snapshot"
      }
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const result = await captureSliceThumbnail(type)
          if (result.ok) {
            toast.success("Desktop and mobile snapshots updated")
            window.dispatchEvent(
              new CustomEvent<SnapshotUpdatedDetail>(SNAPSHOT_UPDATED_EVENT, {
                detail: {
                  type,
                  before: result.before,
                  version: result.version,
                },
              })
            )
          } else {
            toast.error("Snapshot failed", { description: result.error })
          }
        })
      }}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Camera className="size-4" />
      )}
      {!iconOnly && (pending ? "Capturing…" : "Snapshot")}
    </Button>
  )
}
