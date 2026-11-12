import Link from "next/link"
import { CircleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function DevAiReadinessNotice({
  ready,
  compact = false,
}: {
  ready: boolean
  compact?: boolean
}) {
  const t = useTranslations("slices.create")
  if (ready) return null

  return (
    <div
      role="status"
      className={cn(
        "flex items-start justify-between gap-4 rounded-lg border p-4 text-sm",
        compact && "mb-3 flex-col gap-3 p-3"
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-foreground">{t("readiness.title")}</p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-200">
            <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
            {t("readiness.status")}
          </span>
        </div>
      </div>
      <Button
        asChild
        variant="outline"
        size="sm"
        className={cn("shrink-0", compact && "w-full")}
      >
        <Link href="/admin/settings/ai">{t("readiness.action")}</Link>
      </Button>
    </div>
  )
}
