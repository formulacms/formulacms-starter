"use client"

import Link from "next/link"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useModuleGate } from "./admin-module-state-provider"
import { showsModuleEntry } from "./module-gate"

/** "Add block" on the Blocks list. Hidden while the AI module is off; while
 *  the Block creator's connection is not set up, the button is disabled and
 *  "Finish setup" opens Settings › AI. */
export function AiAddBlockEntry({ ready }: { ready: boolean }) {
  const gate = useModuleGate("ai")
  const t = useTranslations("blocks.catalog")
  if (!showsModuleEntry(gate)) return null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3">
      {!ready && (
        <Link
          href="/admin/settings/ai"
          data-testid="add-block-finish-setup"
          className="text-sm font-medium text-amber-700 underline underline-offset-4 dark:text-amber-300"
        >
          {t("finishSetup")}
        </Link>
      )}
      {ready ? (
        <Button asChild data-testid="add-block">
          <Link href="/admin/blocks/create">
            <Plus /> {t("addBlock")}
          </Link>
        </Button>
      ) : (
        <Button data-testid="add-block" disabled>
          <Plus /> {t("addBlock")}
        </Button>
      )}
    </div>
  )
}
