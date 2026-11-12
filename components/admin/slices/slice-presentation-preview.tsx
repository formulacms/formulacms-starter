"use client"

import { ImageIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

/** The approved schematic illustrates layout, never a live renderer or content. */
export function SlicePresentationPreview({
  presentationId,
  label,
  compact = false,
}: {
  presentationId: string
  label: string
  compact?: boolean
}) {
  const t = useTranslations("editor.sliceEditor.presentation")
  const centered = presentationId === "centered"
  return (
    <div
      role="img"
      aria-label={t("schematic", { label })}
      className={cn(
        "flex h-31 items-center gap-3 overflow-hidden bg-muted/50 p-6",
        centered && "flex-col gap-2 text-center",
        compact && "h-26 p-4 max-[760px]:p-3"
      )}
    >
      <div className={cn("min-w-0 flex-1", centered && "flex-none")}>
        <b
          className={cn(
            "block max-w-42.5 text-[15px] leading-tight font-semibold",
            centered && "max-w-none"
          )}
        >
          {t("previewTitle")}
        </b>
        <p className="mt-1 text-xs text-muted-foreground">{t("previewBody")}</p>
      </div>
      <div
        className={cn(
          "grid h-18 w-[95px] shrink-0 place-items-center rounded bg-muted text-muted-foreground",
          centered && "h-[26px] w-[155px]",
          compact && "max-[760px]:hidden"
        )}
      >
        <ImageIcon className="size-4" aria-hidden={true} />
      </div>
    </div>
  )
}
