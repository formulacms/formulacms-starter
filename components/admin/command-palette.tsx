"use client"

import { useModuleGate } from "./admin-module-state-provider"
import { showsModuleEntry } from "./module-gate"

import {
  createContext,
  Suspense,
  use,
  useEffect,
  useId,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from "react"
import { usePathname, useRouter } from "next/navigation"
import { useForm, useWatch } from "react-hook-form"

import { useQuery } from "convex/react"
import {
  ArrowRight,
  FilePlus2,
  FileText,
  Loader2,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react"
import { api } from "@/convex/_generated/api"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ADMIN_NAVIGATION } from "./navigation"
import {
  adminContentTypeSingularMessageKey,
  adminContentTypes,
} from "@/lib/admin/content-types"
import {
  ArchivedContentTypesErrorBoundary,
  useArchivedContentTypes,
} from "./content-types/use-archived-content-types"
import {
  ADMIN_AI_HELP_BROWSER_BINDING,
  type AdminAiHelpHostResult,
} from "./contributions/ai-help"
import type { AdminContributionRouteData } from "./contributions/types"

export type AdminCommand = {
  id: string
  label: string
  section: string
  icon?: LucideIcon | ComponentType<{ className?: string }>
  description?: string
  keywords?: string[]
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  run: () => void | Promise<void>
}

type CommandRegistration = {
  id: string
  commandsRef: { current: AdminCommand[] }
  signature: string
}

const AdminCommandPaletteContext = createContext<{
  register: (registration: CommandRegistration) => void
  unregister: (id: string) => void
  openPalette: () => void
} | null>(null)

// `listSummaries` merges real content titles over the staged denormalized ones
// server-side, so the Deploy 2 PR B item 3 fallback (never-published drafts have
// empty content) is already applied by the time we get here — one resolved map
// instead of the full document.
function pageTitle(
  page: {
    localizedTitles: Record<string, string>
    slug: string
  },
  untitled: string
) {
  for (const value of Object.values(page.localizedTitles)) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return page.slug || untitled
}

function setRefs<T>(element: T | null, ...refs: Array<Ref<T> | undefined>) {
  for (const ref of refs) {
    if (!ref) continue
    if (typeof ref === "function") {
      ref(element)
    } else {
      ref.current = element
    }
  }
}

function isMacPlatform() {
  if (typeof navigator === "undefined") return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

function commandScore(command: AdminCommand, query: string) {
  if (!query) return 1
  const haystack = [
    command.label,
    command.section,
    command.description,
    ...(command.keywords ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  const q = query.toLowerCase()
  if (command.label.toLowerCase().startsWith(q)) return 4
  if (haystack.includes(q)) return 3
  return q.split(/\s+/).every((part) => haystack.includes(part)) ? 2 : 0
}

function groupCommands(commands: AdminCommand[]) {
  const groups = new Map<string, AdminCommand[]>()
  for (const command of commands) {
    const existing = groups.get(command.section) ?? []
    existing.push(command)
    groups.set(command.section, existing)
  }
  return [...groups.entries()]
}

function commandRegistrationSignature(commands: AdminCommand[]) {
  return commands
    .map((command) =>
      [
        command.id,
        command.label,
        command.section,
        command.description ?? "",
        command.shortcut ?? "",
        command.disabled ? "disabled" : "enabled",
        command.disabledReason ?? "",
        ...(command.keywords ?? []),
      ].join("\u001f")
    )
    .join("\u001e")
}

export function useRegisterAdminCommands(commands: AdminCommand[]) {
  const ctx = use(AdminCommandPaletteContext)
  const commandsRef = useRef(commands)
  const id = useId()
  const signature = commandRegistrationSignature(commands)

  useEffect(() => {
    commandsRef.current = commands
  }, [commands])

  useEffect(() => {
    if (!ctx) return
    if (commands.length === 0) {
      ctx.unregister(id)
      return
    }
    ctx.register({ id, commandsRef, signature })
    return () => {
      ctx.unregister(id)
    }
  }, [commands.length, id, signature, ctx])
}

function ContentTypeCreateCommands({
  ownerResolved,
}: {
  ownerResolved: boolean
}) {
  const router = useRouter()
  const t = useTranslations("commandPalette")
  const tContentType = useTranslations("sidebar.contentType")
  const archivedContentTypes = useArchivedContentTypes()
  const commands =
    !ownerResolved || archivedContentTypes.status !== "ready"
      ? []
      : adminContentTypes().flatMap((summary) => {
          if (archivedContentTypes.archived.has(summary.type)) {
            return []
          }
          const messageKey = adminContentTypeSingularMessageKey(summary.type)
          const singularLabel =
            messageKey && tContentType.has(messageKey)
              ? tContentType(messageKey)
              : summary.singular
          return [
            {
              id: `page:new:${summary.type}`,
              label: t("create.label", {
                type: singularLabel.toLowerCase(),
              }),
              section: t("sections.create"),
              description: t("create.description", {
                type: singularLabel.toLowerCase(),
              }),
              icon: FilePlus2,
              keywords: [
                "create",
                summary.singular,
                summary.plural,
                singularLabel,
              ],
              run: () =>
                router.push(
                  `/admin/pages/new?type=${encodeURIComponent(summary.type)}`
                ),
            } satisfies AdminCommand,
          ]
        })

  useRegisterAdminCommands(commands)
  return null
}

function ContentTypeCreateCommandsUnavailable({
  ownerResolved,
}: {
  ownerResolved: boolean
}) {
  const t = useTranslations("commandPalette")
  useRegisterAdminCommands(
    ownerResolved
      ? [
          {
            id: "page:new:unavailable",
            label: t("create.unavailableLabel"),
            section: t("sections.create"),
            description: t("create.unavailableDescription"),
            disabled: true,
            disabledReason: t("create.unavailableReason"),
            icon: FilePlus2,
            run: () => undefined,
          },
        ]
      : []
  )
  return null
}

export function AdminCommandPaletteProvider({
  children,
  aiHelpRouteData,
}: {
  children: React.ReactNode
  aiHelpRouteData?: AdminContributionRouteData
}) {
  const router = useRouter()
  const pathname = usePathname()
  const tSidebar = useTranslations("sidebar")
  const t = useTranslations("commandPalette")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [registrations, setRegistrations] = useState<CommandRegistration[]>([])
  const form = useForm<{
    query: string
  }>({
    defaultValues: {
      query: "",
    },
  })
  const { register: registerField, reset } = form
  const queryField = registerField("query", {
    onChange: () => setActiveIndex(0),
  })
  const queryRef = queryField.ref
  const mergeInputRefs = (element: HTMLInputElement | null) => {
    setRefs(element, inputRef, queryRef)
  }
  const query = useWatch({
    control: form.control,
    name: "query",
  }) as string | null
  const trimmedQuery = query?.trim() ?? ""
  // Don't query until the palette has actually been opened.
  //
  // The provider mounts in `admin-shell.tsx` on EVERY admin screen, so this ran
  // for every admin page view with the palette closed — and `pages.list`
  // returns full page documents (all slice bodies, all locales). Latching on
  // first open means users who never press Cmd-K cost nothing, and
  // `listSummaries` keeps the payload small for those who do.
  const [hasOpened, setHasOpened] = useState(false)
  const pagesQuery = useQuery(
    api.cms.pages.listSummaries,
    hasOpened ? { limit: 25 } : "skip"
  )
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const ownerResolved = owner !== undefined && owner !== null
  const isMac = isMacPlatform()
  const paletteShortcut = isMac ? "⌘K" : "Ctrl+K"

  const register = useCallback((registration: CommandRegistration) => {
    setRegistrations((current) => {
      const index = current.findIndex((item) => item.id === registration.id)
      if (index === -1) {
        return [...current, registration]
      }

      const existing = current[index]
      if (
        existing.commandsRef === registration.commandsRef &&
        existing.signature === registration.signature
      ) {
        return current
      }

      const next = [...current]
      next[index] = registration
      return next
    })
  }, [])

  const unregister = useCallback((id: string) => {
    setRegistrations((current) => {
      if (!current.some((item) => item.id === id)) return current
      return current.filter((item) => item.id !== id)
    })
  }, [])

  const openPalette = useCallback(() => {
    setOpen(true)
    setHasOpened(true)
    reset({ query: "" })
    setActiveIndex(0)
    setRunningId(null)
  }, [reset])

  const closePalette = useCallback(() => {
    setOpen(false)
    reset({ query: "" })
    setActiveIndex(0)
    setRunningId(null)
  }, [reset])

  const contextValue = useMemo(
    () => ({ register, unregister, openPalette }),
    [register, unregister, openPalette]
  )

  const redirectsGate = useModuleGate("redirects")
  const baseCommands: AdminCommand[] = (() => {
    const navigation: AdminCommand[] = []
    for (const item of ADMIN_NAVIGATION) {
      if (
        !ownerResolved ||
        (item.moduleId === "redirects" && !showsModuleEntry(redirectsGate))
      )
        continue
      const label = item.contentType
        ? tSidebar(
            `contentType.${item.contentType}.plural` as Parameters<
              typeof tSidebar
            >[0]
          )
        : tSidebar(
            `nav.${item.labelKey ?? item.name.toLowerCase()}` as Parameters<
              typeof tSidebar
            >[0]
          )
      navigation.push({
        id: `nav:${item.href}`,
        label,
        section: t("sections.goTo"),
        description: item.href,
        icon: item.icon,
        keywords: item.keywords,
        run: () => router.push(item.href),
      })
    }

    const pageCommands = (pagesQuery ?? []).slice(0, 25).map((page) => ({
      id: `page:${page._id}`,
      label: pageTitle(page, t("untitled")),
      section: t("sections.pages"),
      description: `/${page.slug || "untitled"} · ${t(`status.${page.status}`)}`,
      icon: FileText,
      keywords: [page.slug, page.status, page.pageType],
      run: () => router.push(`/admin/pages/${page._id}`),
    }))

    return [...navigation, ...pageCommands]
  })()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return
      }
      if (event.key.toLowerCase() !== "k") return

      event.preventDefault()
      openPalette()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [openPalette])

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => inputRef.current?.focus())
  }, [open])

  async function runCommand(command: AdminCommand | undefined) {
    if (!command || command.disabled || runningId) return
    setRunningId(command.id)
    await Promise.resolve()
      .then(() => command.run())
      .then(
        () => {
          closePalette()
          setRunningId(null)
        },
        (error: unknown) => {
          setRunningId(null)
          throw error
        }
      )
  }

  function renderPalette(help: AdminAiHelpHostResult | null) {
    const registeredCommands = registrations.flatMap(
      (item) => item.commandsRef.current
    )
    const allCommands = [
      ...registeredCommands,
      ...baseCommands,
      ...(help?.command ? [help.command] : []),
    ]
    const scored: { command: AdminCommand; score: number }[] = []
    for (const command of allCommands) {
      const score = commandScore(command, trimmedQuery)
      if (score > 0) scored.push({ command, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const filtered = scored.map(({ command }) => command)
    const boundedActiveIndex = Math.min(
      activeIndex,
      Math.max(0, filtered.length - 1)
    )
    const activeCommand = filtered[boundedActiveIndex] ?? filtered[0]

    return (
      <AdminCommandPaletteContext.Provider value={contextValue}>
        <ArchivedContentTypesErrorBoundary
          fallback={
            <ContentTypeCreateCommandsUnavailable
              ownerResolved={ownerResolved}
            />
          }
        >
          <ContentTypeCreateCommands ownerResolved={ownerResolved} />
        </ArchivedContentTypesErrorBoundary>
        {children}
        {help?.panel && <Suspense fallback={null}>{help.panel}</Suspense>}
        <Dialog
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closePalette()
          }}
        >
          <DialogContent
            className="top-[10vh] mt-0 w-[min(42rem,calc(100vw-2rem))] translate-y-0 p-0"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                closePalette()
              }
            }}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{t("title")}</DialogTitle>
            </DialogHeader>
            <div className="relative mx-auto w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
              <div className="flex items-center gap-2 border-b px-3">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  {...queryField}
                  ref={mergeInputRefs}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault()
                      setActiveIndex((index) =>
                        Math.min(Math.max(0, filtered.length - 1), index + 1)
                      )
                      return
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault()
                      setActiveIndex((index) => Math.max(0, index - 1))
                      return
                    }
                    if (event.key === "Enter") {
                      if (event.nativeEvent.isComposing) return
                      event.preventDefault()
                      void runCommand(activeCommand)
                    }
                  }}
                  placeholder={t("searchPlaceholder")}
                  aria-label={t("searchLabel")}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {paletteShortcut}
                </kbd>
              </div>
              <div className="max-h-[26rem] overflow-y-auto p-2">
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                    <Sparkles className="size-5 text-muted-foreground" />
                    <p className="text-sm font-medium">{t("emptyTitle")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("emptyDescription")}
                    </p>
                  </div>
                ) : (
                  groupCommands(filtered).map(([section, commands]) => (
                    <div key={section} className="pb-2">
                      <div className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {section}
                      </div>
                      <div className="space-y-0.5">
                        {commands.map((command) => {
                          const index = filtered.findIndex(
                            (item) => item.id === command.id
                          )
                          const Icon = command.icon ?? ArrowRight
                          const active = index === boundedActiveIndex
                          const running = runningId === command.id
                          return (
                            <button
                              key={command.id}
                              type="button"
                              disabled={command.disabled || runningId !== null}
                              title={
                                command.disabled
                                  ? command.disabledReason
                                  : command.description
                              }
                              onMouseEnter={() => setActiveIndex(index)}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void runCommand(command)}
                              className={cn(
                                "flex min-h-12 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm outline-none disabled:cursor-not-allowed disabled:opacity-45",
                                active && "bg-accent text-accent-foreground",
                                !active && "hover:bg-accent/50"
                              )}
                            >
                              {running ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" />
                              ) : (
                                <Icon className="size-4 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                  {command.label}
                                </span>
                                {command.description && (
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {command.disabled
                                      ? command.disabledReason
                                      : command.description}
                                  </span>
                                )}
                              </span>
                              {command.shortcut && (
                                <kbd className="rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                  {command.shortcut}
                                </kbd>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
        {!open && (
          <button type="button" onClick={openPalette} className="sr-only">
            {t("open")}
          </button>
        )}
      </AdminCommandPaletteContext.Provider>
    )
  }

  const HelpSlot = ADMIN_AI_HELP_BROWSER_BINDING
  return HelpSlot && aiHelpRouteData !== undefined ? (
    <HelpSlot routeData={aiHelpRouteData} query={trimmedQuery} route={pathname}>
      {renderPalette}
    </HelpSlot>
  ) : (
    renderPalette(null)
  )
}
