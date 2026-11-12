"use client"

import { useTranslations } from "next-intl"

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations("inventory.adminError")
  console.error("[admin] unhandled error", error)

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-12 text-center">
      <p className="text-lg font-medium">{t("title")}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {error.digest
          ? t("errorId", { digest: error.digest })
          : t("description")}
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {t("retry")}
      </button>
    </div>
  )
}
