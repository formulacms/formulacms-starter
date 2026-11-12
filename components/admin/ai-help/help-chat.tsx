"use client"

// The floating Help chat (approved prototype `help.prototype.tsx`, layout B).
// It answers and links to admin screens; it never changes anything. The
// conversation lives in this component only: a reload starts a new one.
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import Link from "next/link"
import { useAction } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import {
  ArrowLeftRight,
  ArrowRight,
  CircleAlert,
  CircleHelp,
  FileText,
  Image,
  Languages,
  Loader2,
  Mail,
  Menu,
  MessageCircle,
  Package,
  Send,
  Settings,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react"
import { api } from "@/convex/_generated/api"
import type { HelpIntentId } from "@/convex/lib/help/intents"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type adminMessages from "@/messages/admin/en.json"
import { helpErrorKind, type HelpErrorKind } from "./help-errors"

type AiStatus = FunctionReturnType<typeof api.cms.aiSettings.status>
export type HelpConnection = AiStatus["connections"][number]

/** "loading" until the status read answers; "missing"/"refused" replace the form. */
export type HelpReadiness = "loading" | "ready" | "missing" | "refused"

/** Matches the Help action's own limit. */
export const MAX_QUESTION_CHARS = 2_000

const SETTINGS_AI_HREF = "/admin/settings/ai"

type SidebarKey = Extract<keyof typeof adminMessages.sidebar.nav, string>
type SettingsKey = Extract<keyof typeof adminMessages.settings.nav, string>

/**
 * The admin's own name and icon of every screen Help may link to: the sidebar
 * label, then the settings or page label ("Settings › Languages").
 */
const HELP_LINKS: Record<
  HelpIntentId,
  Readonly<{ icon: LucideIcon; area: SidebarKey; screen?: SettingsKey | "newPage" }>
> = {
  "create-page": { icon: FileText, area: "content", screen: "newPage" },
  "open-pages": { icon: FileText, area: "content" },
  "open-media": { icon: Image, area: "media" },
  "open-menus": { icon: Menu, area: "menus" },
  "open-redirects": { icon: ArrowLeftRight, area: "redirects" },
  "open-trash": { icon: Trash2, area: "trash" },
  "open-settings": { icon: Settings, area: "settings", screen: "general" },
  "open-settings-modules": { icon: Package, area: "settings", screen: "modules" },
  "open-settings-ai": { icon: Sparkles, area: "settings", screen: "ai" },
  "open-settings-languages": {
    icon: Languages,
    area: "settings",
    screen: "languages",
  },
  "open-settings-email": { icon: Mail, area: "settings", screen: "email" },
}

const isHelpLinkId = (id: string): id is HelpIntentId =>
  Object.hasOwn(HELP_LINKS, id)

type HelpLink = Readonly<{ id: HelpIntentId; href: string }>

type Msg =
  | { id: number; role: "you"; text: string }
  | { id: number; role: "help"; state: "pending" }
  | { id: number; role: "help"; state: "done"; text: string; link?: HelpLink }
  | { id: number; role: "help"; state: "failed"; kind: HelpErrorKind }

type ChatProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  readiness: HelpReadiness
  connection: HelpConnection | undefined
  route: string
}

/** Answers are per language, so a language change starts a new conversation. */
export function HelpChat(props: ChatProps) {
  const locale = useLocale()
  return <HelpFloating key={locale} {...props} />
}

function HelpFloating({
  open,
  onOpenChange,
  readiness,
  connection,
  route,
}: ChatProps) {
  const t = useTranslations("help")
  const answer = useAction(api.agents.helpAssistant.answer)
  // Kept while the card is closed: closing it never drops an answer.
  const [msgs, setMsgs] = useState<Msg[]>([])
  const next = useRef(1)
  const asking = useRef(false)
  const streaming = msgs.some((m) => m.role === "help" && m.state === "pending")

  // One model call per question, from the submit or a suggested question.
  const send = async (question: string) => {
    const text = question.trim()
    if (
      !text ||
      text.length > MAX_QUESTION_CHARS ||
      asking.current ||
      readiness !== "ready"
    )
      return
    asking.current = true
    const idYou = next.current++
    const idHelp = next.current++
    setMsgs((m) => [
      ...m,
      { id: idYou, role: "you", text },
      { id: idHelp, role: "help", state: "pending" },
    ])
    let reply: Msg
    try {
      const result = await answer({ question: text, route })
      const action = result.suggestedAction
      reply = {
        id: idHelp,
        role: "help",
        state: "done",
        text: result.answer,
        ...(action && isHelpLinkId(action.id)
          ? { link: { id: action.id, href: action.href } }
          : {}),
      }
    } catch (error) {
      reply = { id: idHelp, role: "help", state: "failed", kind: helpErrorKind(error) }
    }
    asking.current = false
    setMsgs((m) => m.map((x) => (x.id === idHelp ? reply : x)))
  }

  return (
    // `data-help-launcher`: app/globals.css gives the admin <main> bottom
    // space while this is on screen, so a page's last control scrolls clear.
    <div
      data-help-launcher=""
      className="fixed right-6 bottom-6 z-30 flex flex-col items-end gap-3"
    >
      {open && (
        <section
          aria-label={t("title")}
          data-testid="help-floating"
          className="flex h-[30rem] w-[22rem] flex-col overflow-hidden rounded-xl border bg-background shadow-xl"
        >
          <PanelHeader onClose={() => onOpenChange(false)} />
          <div className="min-h-0 flex-1">
            <Conversation
              msgs={msgs}
              streaming={streaming}
              readiness={readiness}
              connection={connection}
              send={(question) => void send(question)}
            />
          </div>
        </section>
      )}
      <Button
        size="icon"
        className="size-12 rounded-full shadow-lg"
        aria-label={open ? t("close") : t("open")}
        onClick={() => onOpenChange(!open)}
      >
        {open ? <X /> : <MessageCircle />}
      </Button>
    </div>
  )
}

function IconButton({
  label,
  children,
  variant = "ghost",
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size="icon" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function PanelHeader({ onClose }: { onClose: () => void }) {
  const t = useTranslations("help")
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <CircleHelp className="size-4" aria-hidden />
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <IconButton label={t("close")} className="ml-auto size-7" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  )
}

const QUESTION_KEYS = ["addFrench", "publish", "writeWithAi"] as const

function Conversation({
  msgs,
  streaming,
  readiness,
  connection,
  send,
}: {
  msgs: readonly Msg[]
  streaming: boolean
  readiness: HelpReadiness
  connection: HelpConnection | undefined
  send: (question: string) => void
}) {
  const t = useTranslations("help")
  const router = useRouter()
  const [draft, setDraft] = useState("")
  const end = useRef<HTMLDivElement>(null)
  const notReady = readiness !== "ready"
  const question = draft.trim()
  const blocked = !question || question.length > MAX_QUESTION_CHARS || streaming
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [msgs])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="help-conversation">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {msgs.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("intro")}</p>
            <div className="flex flex-col flex-wrap items-stretch gap-2">
              {QUESTION_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={notReady}
                  onClick={() => send(t(`questions.${key}`))}
                  className="rounded-full border px-3 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                >
                  {t(`questions.${key}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) =>
          m.role === "you" ? (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                {m.text}
              </p>
            </div>
          ) : (
            <div
              key={m.id}
              className="flex gap-2.5"
              data-testid="help-answer"
              data-done={m.state !== "pending"}
            >
              <span
                className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"
                aria-hidden
              >
                <Sparkles className="size-3.5" />
              </span>
              <div className="min-w-0 space-y-2">
                {m.state === "done" ? (
                  <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {m.text}
                  </p>
                ) : m.state === "failed" ? (
                  <AnswerFailure kind={m.kind} connection={connection} />
                ) : (
                  <p
                    role="status"
                    data-testid="help-loading"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {t("loading")}
                  </p>
                )}
                {m.state === "done" && m.link && (
                  <div className="flex flex-wrap gap-2">
                    <ScreenLink
                      link={m.link}
                      onOpen={(href) => router.push(href)}
                    />
                  </div>
                )}
              </div>
            </div>
          )
        )}
        <div ref={end} />
      </div>
      <div className="border-t p-3">
        {readiness === "missing" || readiness === "refused" ? (
          <SetupNotice
            testId="help-finish-setup"
            refused={readiness === "refused"}
            connection={connection}
          />
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (blocked || notReady) return
              send(question)
              setDraft("")
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("placeholder")}
              aria-label={t("questionLabel")}
            />
            <IconButton
              label={t("send")}
              variant="default"
              type="submit"
              disabled={blocked || notReady}
            >
              <Send />
            </IconButton>
          </form>
        )}
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          {t("footer")}
        </p>
      </div>
    </div>
  )
}

function ScreenLink({
  link,
  onOpen,
}: {
  link: HelpLink
  onOpen: (href: string) => void
}) {
  const t = useTranslations("help")
  const tSidebar = useTranslations("sidebar.nav")
  const tSettings = useTranslations("settings.nav")
  const tPages = useTranslations("pages")
  const { icon: Icon, area, screen } = HELP_LINKS[link.id]
  const section = tSidebar(area)
  const label =
    screen === undefined
      ? section
      : t("screenPath", {
          section,
          screen: screen === "newPage" ? tPages("newPage") : tSettings(screen),
        })
  return (
    <button
      type="button"
      onClick={() => onOpen(link.href)}
      className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent"
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
      <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
    </button>
  )
}

/** The amber "Finish setup" notice: missing or refused connection. */
function SetupNotice({
  testId,
  refused,
  connection,
}: {
  testId: string
  refused: boolean
  connection: HelpConnection | undefined
}) {
  const t = useTranslations("help")
  const tWrite = useTranslations("pages.aiWrite")
  const tSetup = useTranslations("settings.modules.aiSetup")
  const tProviders = useTranslations("settings.aiScreen.providers")
  return (
    <AmberNotice testId={testId}>
      {refused && connection
        ? tWrite("keyRefused", {
            provider: tProviders(connection.provider),
            envVar: connection.envVar,
          })
        : t("missing")}{" "}
      <Link
        href={SETTINGS_AI_HREF}
        className="font-medium underline underline-offset-4"
      >
        {tSetup("finish")}
      </Link>
    </AmberNotice>
  )
}

/** A failed answer: the notice takes the answer's place; the form stays usable. */
function AnswerFailure({
  kind,
  connection,
}: {
  kind: HelpErrorKind
  connection: HelpConnection | undefined
}) {
  const t = useTranslations("help")
  const tProviders = useTranslations("settings.aiScreen.providers")
  if (kind === "refused" || kind === "missing")
    return (
      <SetupNotice
        testId="help-error"
        refused={kind === "refused"}
        connection={connection}
      />
    )
  return (
    <AmberNotice testId="help-error">
      {kind === "unreachable" && connection
        ? t("errors.unreachable", { provider: tProviders(connection.provider) })
        : kind === "busy"
          ? t("errors.busy")
          : t("errors.other")}
    </AmberNotice>
  )
}

function AmberNotice({
  testId,
  children,
}: {
  testId: string
  children: ReactNode
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  )
}
