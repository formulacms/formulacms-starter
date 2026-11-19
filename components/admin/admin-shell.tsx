"use client"

import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useConvexAuth, useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { VisuallyHidden } from "@radix-ui/react-visually-hidden"
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
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet"
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

// Tailwind's `md` breakpoint (48rem). Below it the sidebar is a Sheet that
// starts closed; from it up the sidebar is today's fixed rail, open at load.
// What shows at load is decided by CSS breakpoints, so the server render and
// the first client render agree; the width is read only to route a toggle.
const WIDE_QUERY = "(min-width: 48rem)"

function isWideViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return true
  return window.matchMedia(WIDE_QUERY).matches
}

function subscribeWideViewport(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => {}
  const query = window.matchMedia(WIDE_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function useWideViewport() {
  return useSyncExternalStore(subscribeWideViewport, isWideViewport, () => true)
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
  setSidebarOpen: () => void
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
        run: setSidebarOpen,
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
      <div className="fixed top-0 left-0 hidden h-screen w-60 border-r bg-background p-4 md:block">
        <div className="h-5 w-24 rounded bg-muted" />
        <div className="mt-5 space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-8 rounded-md bg-muted" />
          ))}
        </div>
      </div>
      <main className="min-h-screen min-w-0 flex-1 p-6 pt-14 md:ml-60 md:pt-6 lg:p-8">
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
  const tSidebar = useTranslations("sidebar")
  const wide = useWideViewport()
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const router = useRouter()
  // From md up the fixed sidebar starts open; below md the Sheet starts closed.
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [phoneSidebarOpen, setPhoneSidebarOpen] = useState(false)
  // Widening past md (a phone turned sideways) closes the phone Sheet for good.
  if (wide && phoneSidebarOpen) setPhoneSidebarOpen(false)
  const shortcut = layoutShortcut()
  const ToggleIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen
  const sidebarLabel = t(sidebarOpen ? "sidebar.hide" : "sidebar.show")
  const toggleClassName =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"

  // The shortcut and the command toggle the sidebar used at this width.
  function toggleSidebar() {
    if (isWideViewport()) setSidebarOpen((open) => !open)
    else setPhoneSidebarOpen((open) => !open)
  }

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
      if (isWideViewport()) setSidebarOpen((open) => !open)
      else setPhoneSidebarOpen((open) => !open)
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
            sidebarOpen={wide ? sidebarOpen : phoneSidebarOpen}
            setSidebarOpen={toggleSidebar}
          />
          {sidebarOpen && <AdminSidebar />}
          {/* Below md: the sidebar opens content-fit in a Sheet over the page. */}
          <Sheet
            open={phoneSidebarOpen && !wide}
            onOpenChange={setPhoneSidebarOpen}
          >
            <SheetContent
              side="left"
              showCloseButton={false}
              aria-describedby={undefined}
              className="gap-0 bg-background data-[side=left]:w-fit"
            >
              <VisuallyHidden>
                <SheetTitle>{tSidebar("brand")}</SheetTitle>
              </VisuallyHidden>
              <AdminSidebar
                variant="sheet"
                onNavigate={() => setPhoneSidebarOpen(false)}
                headerAction={
                  <SheetClose
                    title={t("sidebar.title", {
                      label: t("sidebar.hide"),
                      shortcut,
                    })}
                    className={toggleClassName}
                  >
                    <PanelLeftClose className="size-4" />
                    <span className="sr-only">{t("sidebar.hide")}</span>
                  </SheetClose>
                }
              />
            </SheetContent>
          </Sheet>
          <button
            type="button"
            onClick={() => setPhoneSidebarOpen(true)}
            title={t("sidebar.title", { label: t("sidebar.show"), shortcut })}
            className={cn(toggleClassName, "fixed top-3 left-3 z-40 md:hidden")}
          >
            <PanelLeftOpen className="size-4" />
            <span className="sr-only">{t("sidebar.show")}</span>
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            title={t("sidebar.title", { label: sidebarLabel, shortcut })}
            className={cn(
              toggleClassName,
              "fixed top-3 z-40 hidden md:inline-flex",
              sidebarOpen ? "left-[12.75rem]" : "left-3"
            )}
          >
            <ToggleIcon className="size-4" />
            <span className="sr-only">{sidebarLabel}</span>
          </button>
          <main
            data-admin-main=""
            className={cn(
              "min-h-screen min-w-0 flex-1 p-6 pt-14 md:pt-6 lg:p-8",
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
