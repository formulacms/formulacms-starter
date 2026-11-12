"use client"

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react"
import { useConvexAuth, useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { api } from "@/convex/_generated/api"
import {
  AdminCommandPaletteProvider,
  useRegisterAdminCommands,
} from "./command-palette"
import { ADMIN_AUTHORING_TOOLS_BROWSER_BINDING } from "./contributions/authoring-tools"
import {
  useModuleStateFailure,
  AdminModuleStateProvider,
} from "./admin-module-state-provider"
import { AdminSidebar } from "./sidebar"
import { cn } from "@/lib/utils"
import type { AdminContributionRouteData } from "./contributions/types"

// Slice deletion progress belongs to the source-only slice library (D-6).
const DeletionOverlay =
  ADMIN_AUTHORING_TOOLS_BROWSER_BINDING?.DeletionOverlay ?? Fragment

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

function layoutShortcut() {
  if (typeof navigator === "undefined") return "Ctrl+\\"
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘\\" : "Ctrl+\\"
}

function LayoutCommands({
  sidebarOpen,
  setSidebarOpen,
}: {
  sidebarOpen: boolean
  setSidebarOpen: (updater: (open: boolean) => boolean) => void
}) {
  const t = useTranslations("shell")
  const shortcut = layoutShortcut()
  const label = t(sidebarOpen ? "sidebar.hide" : "sidebar.show")

  const commands = useMemo(
    () => [
      {
        id: "layout:toggle-sidebar",
        label,
        section: t("sidebar.section"),
        description: sidebarOpen
          ? t("sidebar.hideDescription")
          : t("sidebar.showDescription"),
        icon: sidebarOpen ? PanelLeftClose : PanelLeftOpen,
        shortcut,
        keywords: [
          t("sidebar.keywords.collapse"),
          t("sidebar.keywords.navigation"),
          t("sidebar.keywords.previewSpace"),
        ],
        run: () => setSidebarOpen((open) => !open),
      },
    ],
    [label, sidebarOpen, shortcut, setSidebarOpen, t]
  )

  useRegisterAdminCommands(commands)

  return null
}

function AdminAuthLoadingShell() {
  return (
    <>
      <div className="fixed top-0 left-0 h-screen w-60 border-r bg-background p-4">
        <div className="h-5 w-24 rounded bg-muted" />
        <div className="mt-5 space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-8 rounded-md bg-muted" />
          ))}
        </div>
      </div>
      <main className="min-h-screen min-w-0 flex-1 p-6 md:ml-60 lg:p-8">
        <div className="h-8 w-48 rounded bg-muted" />
        <div className="mt-6 h-40 rounded-md border bg-muted/30" />
      </main>
    </>
  )
}

export function AdminShell({
  children,
  aiHelpRouteData,
  moduleStateFailed,
}: {
  children: ReactNode
  aiHelpRouteData?: AdminContributionRouteData
  moduleStateFailed?: boolean
}) {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const t = useTranslations("shell")
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const router = useRouter()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const shortcut = layoutShortcut()
  const ToggleIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen
  const sidebarLabel = t(sidebarOpen ? "sidebar.hide" : "sidebar.show")

  useEffect(() => {
    if (!isLoading && (!isAuthenticated || owner === null)) {
      router.replace("/sign-in")
      router.refresh()
    }
  }, [isLoading, isAuthenticated, owner, router])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        isTypingTarget(event.target)
      ) {
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return
      }
      if (event.key !== "\\") return

      event.preventDefault()
      setSidebarOpen((open) => !open)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  if (isLoading || owner === undefined) {
    return <AdminAuthLoadingShell />
  }

  if (!isAuthenticated || !owner) {
    return null
  }

  return (
    <AdminModuleStateProvider serverReadFailed={moduleStateFailed}>
      <AdminCommandPaletteProvider
        {...(aiHelpRouteData === undefined ? {} : { aiHelpRouteData })}
      >
        <DeletionOverlay>
          <LayoutCommands
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
          />
          {sidebarOpen && <AdminSidebar />}
          <button
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            title={t("sidebar.title", { label: sidebarLabel, shortcut })}
            className={cn(
              "fixed top-3 z-40 inline-flex size-8 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground",
              sidebarOpen ? "left-[12.75rem]" : "left-3"
            )}
          >
            <ToggleIcon className="size-4" />
            <span className="sr-only">{sidebarLabel}</span>
          </button>
          <main
            data-admin-main=""
            className={cn(
              "min-h-screen min-w-0 flex-1 p-6 lg:p-8",
              sidebarOpen ? "ml-0 md:ml-60" : "ml-0"
            )}
          >
            <ModulesUnavailableNotice />
            {children}
          </main>
        </DeletionOverlay>
      </AdminCommandPaletteProvider>
    </AdminModuleStateProvider>
  )
}

function ModulesUnavailableNotice() {
  const failed = useModuleStateFailure()
  const t = useTranslations("shell")
  return failed ? (
    <div
      role="alert"
      data-testid="global-module-error"
      className="mb-6 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
    >
      {t("modulesUnavailable")}
    </div>
  ) : null
}
