"use client"

import Link from "next/link"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useModuleGate } from "./admin-module-state-provider"
import { showsModuleEntry } from "./module-gate"

/** "Add slice" on the Slices list. Hidden while the AI module is off; while
 *  the Slice creator's connection is not set up, the button is disabled and
 *  "Finish setup" opens Settings › AI. */
export function AiAddSliceEntry({ ready }: { ready: boolean }) {
  const gate = useModuleGate("ai")
  const t = useTranslations("slices.catalog")
  if (!showsModuleEntry(gate)) return null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3">
      {!ready && (
        <Link
          href="/admin/settings/ai"
          data-testid="add-slice-finish-setup"
          className="text-sm font-medium text-amber-700 underline underline-offset-4 dark:text-amber-300"
        >
          {t("finishSetup")}
        </Link>
      )}
      {ready ? (
        <Button asChild data-testid="add-slice">
          <Link href="/admin/slices/create">
            <Plus /> {t("addSlice")}
          </Link>
        </Button>
      ) : (
        <Button data-testid="add-slice" disabled>
          <Plus /> {t("addSlice")}
        </Button>
      )}
    </div>
  )
}
