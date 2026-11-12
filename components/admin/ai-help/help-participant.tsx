"use client"

import { useEffect, useState } from "react"
import { useQueries } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { CircleHelp } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { useModuleGate } from "../admin-module-state-provider"
import type { AdminCommand } from "../command-palette"
import type {
  AdminAiHelpHostProps,
  AdminAiHelpHostResult,
} from "../contributions/ai-help"
import { HelpChat, type HelpReadiness } from "./help-chat"

type AiStatus = FunctionReturnType<typeof api.cms.aiSettings.status>

// useQueries memoizes its subscription on the request object's identity, so
// each request is created once (see `ai-writing/page-jobs.tsx`).
const STATUS_REQUEST = {
  status: { query: api.cms.aiSettings.status, args: {} },
}
const NO_REQUEST = {}

const NO_PARTICIPATION: AdminAiHelpHostResult = { command: null, panel: null }

/**
 * Help's command-palette participant: the "Ask AI Help" command and the
 * floating chat. Only this slot decides whether Help shows: with the AI module
 * off (or its state unknown) it returns nothing and opens no AI read.
 * Readiness is the Help assistant's own, never Writing's or the module's.
 */
export function HelpParticipant({ children, route }: AdminAiHelpHostProps) {
  const gate = useModuleGate("ai")
  const visible = gate.state === "on" || gate.state === "needs_setup"
  const { status } = useQueries(visible ? STATUS_REQUEST : NO_REQUEST) as {
    status?: AiStatus | Error
  }
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const t = useTranslations("help")
  const tNav = useTranslations("settings.nav")
  const tSetup = useTranslations("settings.modules.aiSetup")
  useEffect(() => {
    if (status instanceof Error)
      reportContainedModuleFailure("ai", "admin.contribution", status)
  }, [status])

  // Same tree position in both branches: the host's page never remounts.
  // A failed status read hides Help; the effect above reports the failure.
  if (!visible || status instanceof Error) return children(NO_PARTICIPATION)

  const loaded = status
  const help = loaded?.assistants.find((entry) => entry.id === "help")
  const connection = loaded?.connections.find(
    (entry) => entry.provider === help?.provider
  )
  const readiness: HelpReadiness = !loaded
    ? "loading"
    : help?.ready === true
      ? "ready"
      : connection?.state === "refused"
        ? "refused"
        : "missing"
  const notReady = readiness === "missing" || readiness === "refused"
  const command: AdminCommand = {
    id: "ai:help",
    label: t("command"),
    section: tNav("ai"),
    icon: CircleHelp,
    ...(notReady ? { description: tSetup("finish") } : {}),
    run: notReady
      ? () => router.push("/admin/settings/ai")
      : () => setOpen(true),
  }
  return children({
    command,
    panel: (
      <HelpChat
        open={open}
        onOpenChange={setOpen}
        readiness={readiness}
        connection={connection}
        route={route}
      />
    ),
  })
}
