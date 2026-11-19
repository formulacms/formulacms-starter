"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useMutation, useQuery } from "convex/react"
import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { Check, ChevronsUpDown, KeyRound, Laptop, Sparkles, type LucideIcon } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useModuleGate } from "./admin-module-state-provider"
import { OptionalModuleRoute } from "./optional-module-route"
import { AiSettingsModelPicker, updatedSinceRefresh, type ListsUpdated, type ModelChoice } from "./ai-settings-model-picker"
import type { LocalProviderKeyPresence } from "@/lib/local-api-keys"
import { localToolModelName } from "@/lib/local-model-names"
import { resolveSliceCreatorSelection } from "@/lib/slices/authoring/creator-selection"

// Settings › AI (approved prototype `prototype/ai-install-setup` 96be6727,
// owner 2026-11-18): a rail with Assistants and Your AI providers. Your AI
// providers lists each provider with one status word and no actions (the
// assistants' keys live on the Convex deployment, the Block creator's in
// .env.local). Each assistant card is provider → model → effort with one badge. The tab lives in `?tab=` and changes in the browser only
// (`history.pushState`): each server render runs the local tools' status
// commands. Drafts live above the tabs, so unsaved edits survive a tab change.

type Status = NonNullable<FunctionReturnType<typeof api.cms.aiSettings.status>>
type Assistant = Status["assistants"][number]
type Provider = Assistant["provider"]
type Tuple = Assistant["effective"]
type Draft = { tuple: Tuple; instructions?: string }
type Choice = ModelChoice
type Effort = Choice["efforts"][number]
type CreatorData = FunctionReturnType<typeof api.cms.aiSettings.sliceCreator>
type SliceCreatorProps = { data: CreatorData; keys: LocalProviderKeyPresence }

// Local tools (ADR-0057 step 1): offered to every assistant, in a browser on
// this computer only. The choice is saved in the local file by a server
// action, never in Convex; Convex keeps the API service choice.
export type LocalToolEngine = "claude" | "codex"
/** The sign-in method only; never the tool's own output. */
export type LocalToolStatus = "plan" | "api-key" | "unknown" | "signed-out" | "not-installed"
export type LocalAssistant = "help" | "sliceCreator" | "writing" | "translation"
export type LocalToolChoice = { engine: LocalToolEngine; model: string; effort: string }
export type LocalToolChoices = Partial<Record<LocalAssistant, LocalToolChoice>>
/** A Claude plan Settings names; anything else is "plan not detected". */
export type ClaudePlan = "pro" | "max" | "ultra" | "team" | "enterprise"
export type LocalToolsData = {
  tools: { tool: LocalToolEngine; status: LocalToolStatus }[]
  /** Server action (owner-only, this computer only): saves the changes, returns the saved choices. */
  save: (changes: Partial<Record<LocalAssistant, LocalToolChoice | null>>) => Promise<LocalToolChoices>
  choices: LocalToolChoices
  menus: Record<LocalToolEngine, {
    /** `defaultEffort`: the tool's own default for the model (Codex lists one).
     *  `unavailable`: listed but cannot be chosen (Fable without a Max or Ultra plan). */
    models: readonly { model: string; name: string; efforts: readonly string[]; defaultEffort?: string; unavailable?: "needsMaxOrUltra" }[]
    defaults: Record<LocalAssistant, { model: string; effort: string }>
  }>
  /** The Claude Code plan read with its model list, when current and named. */
  claudePlan?: ClaudePlan
}
/** A local tool route shown in the same fields as an API tuple. */
type LocalTuple = { mode: "local"; provider: LocalToolEngine; model: string; reasoning: { kind: "effort"; effort: Effort } }
type RowTuple = Tuple | LocalTuple
type RowProvider = Provider | LocalToolEngine
type Tab = "assistants" | "providers"
type T = ReturnType<typeof useTranslations<"settings.aiScreen">>

const TOOLS: LocalToolEngine[] = ["claude", "codex"]
const APIS: Provider[] = ["anthropic", "openai", "openrouter"]
const isTool = (provider: RowProvider): provider is LocalToolEngine => provider === "claude" || provider === "codex"
const toolUsable = (status: LocalToolStatus | undefined) => status === "plan" || status === "api-key" || status === "unknown"
type ToolFacts = Pick<LocalToolsData, "tools"> | undefined
const toolStatus = (local: ToolFacts, tool: LocalToolEngine) => local?.tools.find((t) => t.tool === tool)?.status
const toolReady = (local: ToolFacts, tool: LocalToolEngine) => toolUsable(toolStatus(local, tool))
const localTuple = (choice: LocalToolChoice): LocalTuple =>
  ({ mode: "local", provider: choice.engine, model: choice.model, reasoning: { kind: "effort", effort: choice.effort as Effort } })
/** A tool's menu as picker rows. A greyed Claude Fable row says "plan not detected" when no plan is named. */
const localChoices = (local: LocalToolsData, tool: LocalToolEngine): Choice[] =>
  local.menus[tool].models.map((m) => ({
    model: m.model, name: m.name, efforts: [...m.efforts] as Effort[], providerDefault: (m.defaultEffort as Effort | undefined) ?? null,
    ...(m.unavailable ? { unavailable: tool === "claude" && !local.claudePlan ? "needsMaxOrUltraPlanUnknown" as const : m.unavailable } : {}),
  }))
/** Brand names, the same in every language. */
const nameOf = (t: T, provider: RowProvider) => (isTool(provider) ? t(`local.tools.${provider}`) : t(`providers.${provider}`))
const effortOf = (tuple: RowTuple) => ("reasoning" in tuple ? tuple.reasoning?.effort : undefined)

// ---- Status words -----------------------------------------------------------------------

/** One meaning each (GLOSSARY.md "Status words"). */
export type StatusWord = "ready" | "signedOut" | "notSetUp" | "invalidKey"

/**
 * The one status word map. A subscription (a local tool) is Ready while
 * signed in, else Signed out, installed or not. An API key: missing → Not set
 * up, refused → Invalid key, connected or unreachable → Ready. "Invalid key"
 * is only for an API key, "Signed out" only for a subscription, and a provider
 * is never "Active".
 */
export function statusWord(provider: RowProvider, connections: Status["connections"], local: ToolFacts): StatusWord {
  if (isTool(provider)) return toolReady(local, provider) ? "ready" : "signedOut"
  const state = connections.find((c) => c.provider === provider)?.state ?? "missing"
  return state === "missing" ? "notSetUp" : state === "refused" ? "invalidKey" : "ready"
}

/** A provider is set up when any API key, or any subscription on this computer, is Ready. */
export function anyProviderSetUp(connections: Status["connections"], local: ToolFacts) {
  return [...(local ? TOOLS : []), ...APIS].some((provider) => statusWord(provider, connections, local) === "ready")
}

// ---- Shared parts -----------------------------------------------------------------------

const selectCls = "h-9 w-full rounded-md border bg-background px-3 text-sm focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
const linkCls = "font-medium text-foreground underline underline-offset-4"

type Tone = "off" | "ok" | "warn" | "bad"
const TONE: Record<Tone, string> = {
  off: "border-border bg-muted text-muted-foreground",
  ok: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  warn: "border-amber-500/50 bg-amber-500/15 text-amber-900 dark:text-amber-200",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
}
const rowTone = (word: StatusWord): Tone => (word === "ready" ? "ok" : word === "invalidKey" ? "bad" : "off")

function StatusBadge({ tone, text, testId, word }: { tone: Tone; text: string; testId?: string; word?: string }) {
  return (
    <span data-testid={testId} data-tone={tone} data-word={word}
      className={cn("inline-flex max-w-full shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", TONE[tone])}>
      {text}
    </span>
  )
}

/** A `?tab=` link. Browser only: Next.js syncs `useSearchParams` with pushState, without a server render. */
function TabLink({ to, current, className, testId, children }: { to: Tab; current?: boolean; className?: string; testId?: string; children: ReactNode }) {
  const params = new URLSearchParams(useSearchParams().toString())
  params.set("tab", to)
  const href = `?${params.toString()}`
  return (
    <a href={href} data-testid={testId} aria-current={current ? "page" : undefined} className={className}
      onClick={(event) => { event.preventDefault(); window.history.pushState(null, "", href) }}>{children}</a>
  )
}

function withModel(provider: RowProvider, choice: Choice, effort: Effort | undefined): RowTuple {
  // A local tool's model starts at the tool's own default effort (design §3).
  const toolDefault = isTool(provider) && choice.providerDefault && choice.efforts.includes(choice.providerDefault) ? choice.providerDefault : undefined
  const nextEffort = toolDefault ? toolDefault
    : effort && choice.efforts.includes(effort) ? effort
    : choice.efforts.includes("medium") ? "medium"
    : choice.providerDefault && choice.efforts.includes(choice.providerDefault) ? choice.providerDefault
    : choice.efforts[0]
  return { mode: isTool(provider) ? "local" : "catalog", provider, model: choice.model, ...(choice.efforts.length > 0 && nextEffort ? { reasoning: { kind: "effort", effort: nextEffort } } : {}) } as RowTuple
}

/** The model's choice when the owner can run it: listed and not greyed (a Fable
 *  row without a Max or Ultra plan). The card's fields and its badge both use it. */
function offeredChoice(models: readonly Choice[], model: string) {
  const listed = models.find((choice) => choice.model === model)
  return listed && !listed.unavailable ? listed : undefined
}

/** The Slice creator's tuple before any edit: saved, else the default of the
 *  provider it would run with on this computer, else the first offered default. */
function creatorBaseTuple({ data, keys }: SliceCreatorProps): Tuple | undefined {
  if (data.tuple) return data.tuple
  const provider = resolveSliceCreatorSelection(undefined, keys).provider
  return (provider ? data.defaults[provider] : null) ?? APIS.map((p) => data.defaults[p]).find((tuple) => tuple !== null) ?? undefined
}

const isRateLimited = (error: unknown) =>
  error instanceof ConvexError && typeof error.data === "object" && error.data !== null && (error.data as { kind?: unknown }).kind === "RateLimited"

// ---- Assistant card ---------------------------------------------------------------------

/** Grouped provider menu: the closed field shows the name only; an option carries a word only for a problem. */
function ProviderMenu({ id, label, value, providers, problem, optionDisabled, disabled, onChange }: {
  id: LocalAssistant
  label: string
  value: RowProvider
  providers: RowProvider[]
  problem: (provider: RowProvider) => StatusWord | undefined
  optionDisabled: (provider: RowProvider) => boolean
  disabled: boolean
  onChange: (provider: RowProvider) => void
}) {
  const t = useTranslations("settings.aiScreen")
  const [open, setOpen] = useState(false)
  const groups = ([[t("subscriptions"), TOOLS], [t("rail.apiKeys"), APIS]] as [string, RowProvider[]][])
    .map(([heading, group]) => [heading, providers.filter((p) => group.includes(p))] as const)
    .filter(([, group]) => group.length > 0)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid={`provider-${id}`} aria-label={`${label} ${t("provider")}`} disabled={disabled}
          className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50">
          <span className="min-w-0 truncate">{nameOf(t, value)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1" data-testid={`provider-menu-${id}`}>
        {groups.map(([heading, group]) => (
          <div key={heading} role="group" aria-label={heading}>
            <p className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{heading}</p>
            <ul>
              {group.map((p) => {
                const word = problem(p)
                return (
                  <li key={p}>
                    <button type="button" data-testid={`option-${p}`} disabled={p !== value && optionDisabled(p)}
                      onClick={() => { if (p !== value) onChange(p); setOpen(false) }}
                      className={cn("grid w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50", p === value && "bg-muted font-medium")}>
                      <Check className={cn("size-3.5", p !== value && "invisible")} />
                      <span>{nameOf(t, p)}{word ? ` · ${t(`words.${word}`)}` : ""}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

type CardProps = {
  id: LocalAssistant
  title: string
  summary: string
  /** The route the fields show (draft, else saved). */
  route: RowTuple
  choices: Partial<Record<RowProvider, Choice[]>>
  /** The providers this card offers, in rail order. */
  providers: RowProvider[]
  /** The provider's problem word; undefined while it is Ready. */
  problem: (provider: RowProvider) => StatusWord | undefined
  /** No provider is set up: the page's one line replaces every card's problem badge. */
  noProvider: boolean
  /** An option that cannot be chosen (main's rule, AI-LOCAL-2). */
  optionDisabled: (provider: RowProvider) => boolean
  selectDisabled: boolean
  onProvider: (provider: RowProvider) => void
  onRoute: (route: RowTuple) => void
  effortLocked: boolean
  lists: (provider: Provider) => ListsUpdated
  instructions: ReactNode
}

function AssistantCard(props: CardProps) {
  const t = useTranslations("settings.aiScreen")
  const { id, title, route, choices } = props
  const provider = route.provider
  const models = choices[provider] ?? []
  const listed = models.find((choice) => choice.model === route.model)
  const selected = offeredChoice(models, route.model)
  // Display only: a saved local-tool model the tool no longer lists keeps its readable name.
  const modelName = listed?.name ?? (isTool(provider) ? localToolModelName(provider, route.model) : undefined) ?? route.model
  const effort = effortOf(route)
  // Model and effort wait until the card's provider is Ready.
  const problem = props.problem(provider)
  const disabled = problem !== undefined
  // A saved explicit tuple remains visible even if the active catalog now refuses it.
  // While the model shown is not offered (unlisted or greyed), Save refuses any
  // change to it, so the Effort select is locked and only shows the saved effort.
  const offeredEfforts = selected?.efforts ?? []
  const efforts = effort && !offeredEfforts.includes(effort) ? [effort, ...offeredEfforts] : offeredEfforts
  const fableNeedsPlan = provider === "claude" && listed?.unavailable !== undefined
  const badge = problem ? (props.noProvider ? null : (
    <span className="flex items-center gap-2">
      <StatusBadge tone="warn" text={t(`words.${problem}`)} testId={`assistant-status-${id}`} word={problem} />
      <TabLink to="providers" testId={`providers-link-${id}`} className={cn("text-xs", linkCls)}>{t("yourProviders")}</TabLink>
    </span>
  )) : selected
    ? <StatusBadge tone="ok" text={t("words.ready")} testId={`assistant-status-${id}`} word="ready" />
    : <StatusBadge tone="warn" text={t("chooseAnotherModel")} testId={`assistant-status-${id}`} word="chooseAnotherModel" />
  return (
    <Card data-testid={`assistant-${id}`} className="overflow-visible">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h3 className="font-heading text-base leading-normal font-medium">{title}</h3>
          {badge}
        </div>
        <p className="text-sm text-muted-foreground">{props.summary}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{t("provider")}</span>
            <ProviderMenu id={id} label={title} value={provider} providers={props.providers} problem={props.problem}
              optionDisabled={props.optionDisabled} disabled={props.selectDisabled} onChange={props.onProvider} />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{t("model")}</span>
            {/* The picker has no disabled look of its own: grey it like the selects. */}
            <div className={cn("min-w-0", disabled && "cursor-not-allowed opacity-50")}>
              <AiSettingsModelPicker taskLabel={title} models={models} value={route.model} valueName={modelName} disabled={disabled}
                updated={isTool(provider) ? undefined : props.lists(provider)}
                onChange={(model) => props.onRoute(withModel(provider, models.find((c) => c.model === model)!, effort))} />
            </div>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{t("effort")}</span>
            <select data-testid={`effort-${id}`} className={selectCls} value={effort ?? ""} disabled={disabled || props.effortLocked || !selected || efforts.length === 0}
              onChange={(event) => props.onRoute({ mode: route.mode === "local" ? "local" : "catalog", provider, model: route.model, reasoning: { kind: "effort", effort: event.target.value } } as RowTuple)}>
              {effort === undefined && offeredEfforts.length > 0 && <option value="" disabled>{t("effortNotSet")}</option>}
              {efforts.length === 0 ? <option value="">{t("noEffort")}</option> : efforts.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {fableNeedsPlan && <p data-testid="fable-plan" className="text-sm text-amber-800 dark:text-amber-200">{t("fableNeedsPlan")}</p>}
        {props.instructions}
      </CardContent>
    </Card>
  )
}

function Instructions({ id, value, placeholder, onChange, onReset }: { id: string; value: string; placeholder?: string; onChange: (value: string) => void; onReset?: () => void }) {
  const t = useTranslations("settings.aiScreen")
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`prompt-${id}`}>{t("instructions")}</Label>
      <Textarea id={`prompt-${id}`} rows={2} maxLength={4000} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {onReset && <p className="text-xs"><button type="button" className={linkCls} onClick={onReset}>{t("reset")}</button></p>}
    </div>
  )
}

// ---- Rail -------------------------------------------------------------------------------

function Rail({ tab }: { tab: Tab }) {
  const t = useTranslations("settings.aiScreen")
  const item = (to: Tab, Icon: LucideIcon, label: string) => (
    <TabLink key={to} to={to} current={tab === to} testId={`rail-${to}`}
      className={cn("flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        tab === to ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="lg:flex-1">{label}</span>
    </TabLink>
  )
  return (
    <aside className="w-full min-w-0 border-b border-border pb-3 lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0 lg:pr-3 lg:pb-0">
      <nav aria-label={t("rail.label")} data-testid="ai-rail" className="flex gap-0.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {item("assistants", Sparkles, t("rail.assistants"))}
        {item("providers", KeyRound, t("yourProviders"))}
      </nav>
    </aside>
  )
}

// ---- Your AI providers ------------------------------------------------------------------

function Providers({ tools, word, plan, keysNote }: {
  tools: LocalToolEngine[]
  word: (provider: RowProvider) => StatusWord
  /** A subscription's plan name, known only while it is Ready. */
  plan: (tool: LocalToolEngine) => string | undefined
  keysNote: boolean
}) {
  const t = useTranslations("settings.aiScreen")
  const row = (provider: RowProvider) => {
    const status = word(provider)
    const Icon = isTool(provider) ? Laptop : KeyRound
    const planName = isTool(provider) && status === "ready" ? plan(provider) : undefined
    return (
      <li key={provider} data-testid={`row-${provider}`} data-word={status} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">{nameOf(t, provider)}</span>
        {planName && <span data-testid={`plan-${provider}`} className="text-muted-foreground">{planName}</span>}
        <span className="flex-1" />
        <StatusBadge tone={rowTone(status)} text={t(`words.${status}`)} testId={`row-status-${provider}`} word={status} />
      </li>
    )
  }
  return (
    <div className="space-y-6" data-testid="providers">
      {tools.length > 0 && (
        <section className="space-y-2" data-testid="group-subscriptions">
          <h2 className="text-sm font-medium">{t("subscriptions")}</h2>
          <p className="text-xs text-muted-foreground">{t("subscriptionsNote")}</p>
          <ul className="divide-y rounded-md border bg-background">{tools.map(row)}</ul>
        </section>
      )}
      <section className="space-y-2" data-testid="group-api-keys">
        <h2 className="text-sm font-medium">{t("rail.apiKeys")}</h2>
        {keysNote && <p data-testid="keys-note" className="text-xs text-muted-foreground">{t("keysNote")}</p>}
        <ul className="divide-y rounded-md border bg-background">{APIS.map(row)}</ul>
      </section>
    </div>
  )
}

// ---- Screen -----------------------------------------------------------------------------

export function SettingsAiScreen({ isLocal, localKeys, localTools: offeredTools }: { isLocal: boolean; localKeys?: LocalProviderKeyPresence; localTools?: LocalToolsData }) {
  const t = useTranslations("settings.aiScreen")
  const common = useTranslations("settings.common")
  const errors = useTranslations("common")
  const searchParams = useSearchParams()
  const localTools = isLocal ? offeredTools : undefined
  const status = useQuery(api.cms.aiSettings.status, {})
  // The Slice creator exists only in local development, where the server passes key presence.
  const keys = isLocal ? localKeys : undefined
  const creatorData = useQuery(api.cms.aiSettings.sliceCreator, keys ? {} : "skip")
  const saveAssistant = useMutation(api.cms.aiSettings.setAssistant)
  const saveCreator = useMutation(api.cms.aiSettings.setSliceCreator)
  const refreshCatalogs = useMutation(api.cms.vendorModelCatalog.refreshModelCatalogs)
  // Drafts sit above the tabs: an edit survives switching tabs and coming back.
  const [drafts, setDrafts] = useState<Partial<Record<Assistant["id"], Draft>>>({})
  const [creatorDraft, setCreatorDraft] = useState<CreatorDraft>()
  const [localDrafts, setLocalDrafts] = useState<LocalDrafts>({})
  const [savedLocal, setSavedLocal] = useState<LocalToolChoices>(() => localTools?.choices ?? {})
  const [saving, setSaving] = useState(false)
  // Each list's own time when the owner last pressed Refresh (null: never
  // read), and whether that call is in flight.
  const [listsBefore, setListsBefore] = useState<Partial<Record<Provider, number | null>>>()
  const [refreshing, setRefreshing] = useState(false)
  // null: the AI module is off; the route shows its own AI-off state.
  if (status === undefined || status === null || (keys && creatorData === undefined)) return null

  const tools = localTools ? TOOLS : []
  const tab: Tab = searchParams.get("tab") === "providers" ? "providers" : "assistants"

  const creator = keys && creatorData ? { data: creatorData, keys } : undefined
  const assistants = status.assistants.filter((assistant) => assistant.available)
  const word = (provider: RowProvider) => statusWord(provider, status.connections, localTools)
  const problem = (provider: RowProvider) => {
    const value = word(provider)
    return value === "ready" ? undefined : value
  }
  const usable = (provider: RowProvider) => problem(provider) === undefined
  const creatorBase = creator && creatorBaseTuple(creator)
  // The Block creator card reads its own .env.local key, so a file key is a set-up provider there.
  const noProvider = !anyProviderSetUp(status.connections, localTools) && !(creator && creatorBase && APIS.some((p) => creator.keys[p]))
  const localRoute = (id: LocalAssistant) => (localTools ? (Object.hasOwn(localDrafts, id) ? localDrafts[id] : savedLocal[id]) : undefined)
  const setLocal = (id: LocalAssistant, choice: LocalToolChoice | null) => setLocalDrafts((current) => ({ ...current, [id]: choice }))
  const clearLocal = (id: LocalAssistant) => setLocalDrafts((current) => {
    const next = { ...current }
    delete next[id]
    return next
  })
  /** Choosing a local tool restores its saved choice for this card, else the tool's default for it. */
  const chooseTool = (id: LocalAssistant, tool: LocalToolEngine) => {
    if (savedLocal[id]?.engine === tool) clearLocal(id)
    else setLocal(id, { engine: tool, ...localTools!.menus[tool].defaults[id] })
  }
  /** Leaving a local tool for an API service removes the saved local choice. */
  const leaveTool = (id: LocalAssistant) => (savedLocal[id] ? setLocal(id, null) : clearLocal(id))
  const lists = (provider: Provider): ListsUpdated => {
    const at = status.catalogSync?.[provider].lastSuccessAt
    return { at, justUpdated: updatedSinceRefresh(at, listsBefore?.[provider]), refreshing, onRefresh: refreshLists }
  }
  const toolChoices = (assistant: LocalAssistant, apiChoices: Record<Provider, Choice[]>) => {
    const all: Partial<Record<RowProvider, Choice[]>> = { ...apiChoices }
    if (localTools) for (const tool of TOOLS) all[tool] = localChoices(localTools, tool)
    return { all, providers: [...tools, ...APIS] as RowProvider[], hasDefault: (p: LocalToolEngine) => Boolean(localTools?.menus[p].defaults[assistant]) }
  }
  const shared = { problem, noProvider, lists }

  // The call only schedules the reads: each list says "Updated" once its own
  // read succeeds (its lastSuccessAt moves past the one seen at the click),
  // else Refresh stays.
  async function refreshLists() {
    setListsBefore(Object.fromEntries(APIS.map((p) => [p, status?.catalogSync?.[p].lastSuccessAt ?? null])))
    setRefreshing(true)
    try {
      await refreshCatalogs({})
    } catch (error) {
      toast.error(isRateLimited(error) ? t("picker.refreshTooSoon") : errors("error"))
    } finally {
      setRefreshing(false)
    }
  }

  async function save() {
    const pending = Object.entries(drafts) as [Assistant["id"], Draft][]
    const pendingCreator = creatorDraft
    const pendingLocal = localDrafts
    const saveLocal = localTools?.save
    setSaving(true)
    try {
      for (const [id, draft] of pending) {
        const args: FunctionArgs<typeof api.cms.aiSettings.setAssistant> = { id }
        if (draft.tuple.mode === "catalog") args.tuple = draft.tuple
        if (draft.instructions !== undefined) args.instructions = draft.instructions
        await saveAssistant(args)
        setDrafts((current) => {
          if (current[id] !== draft) return current
          const next = { ...current }
          delete next[id]
          return next
        })
      }
      if (pendingCreator) {
        // setSliceCreator replaces the stored entry, so both values travel together.
        const args: FunctionArgs<typeof api.cms.aiSettings.setSliceCreator> = {}
        if (pendingCreator.tuple.mode === "catalog") args.tuple = pendingCreator.tuple
        if (pendingCreator.instructions.trim() !== "") args.instructions = pendingCreator.instructions
        await saveCreator(args)
        setCreatorDraft((current) => (current === pendingCreator ? undefined : current))
      }
      if (saveLocal && Object.keys(pendingLocal).length > 0) {
        // The local file on this computer: never Convex.
        setSavedLocal(await saveLocal(pendingLocal))
        setLocalDrafts((current) => (current === pendingLocal ? {} : current))
      }
      toast.success(t("saved"))
    } catch {
      toast.error(common("failedSave"))
    } finally {
      setSaving(false)
    }
  }

  // ---- The cards' data
  const cards = assistants.map((assistant) => {
    const { id } = assistant
    const draft = drafts[id] ?? { tuple: assistant.effective, instructions: assistant.instructions }
    const local = localRoute(id)
    const route: RowTuple = local ? localTuple(local) : draft.tuple
    const set = (patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? draft), ...patch } }))
    const { all, providers, hasDefault } = toolChoices(id, assistant.choices)
    return (
      <AssistantCard key={id} id={id} title={t(`tasks.${id}.title`)} summary={t(`tasks.${id}.summary`)} route={route} choices={all} providers={providers} {...shared}
        // With the local tools (this computer), an API service stays selectable without a key, so the owner can leave a tool.
        optionDisabled={(p) => isTool(p) ? !usable(p) || !hasDefault(p) : tools.length > 0 ? !assistant.defaults[p] : !usable(p) || !assistant.defaults[p]}
        selectDisabled={tools.length === 0 && !APIS.some(usable)}
        onProvider={(p) => {
          if (isTool(p)) return chooseTool(id, p)
          leaveTool(id)
          // The saved choice for this service, else the assistant's default for it.
          if (p === assistant.effective.provider) {
            if (drafts[id]) set({ tuple: assistant.effective })
          } else set({ tuple: assistant.defaults[p]! })
        }}
        onRoute={(next) => next.mode === "local" ? setLocal(id, { engine: next.provider, model: next.model, effort: next.reasoning.effort }) : set({ tuple: next })}
        effortLocked={id === "translation"}
        instructions={<Instructions id={id} value={draft.instructions ?? t(`tasks.${id}.prompt`)} onChange={(instructions) => set({ instructions })}
          onReset={draft.instructions !== undefined ? () => set({ instructions: undefined }) : undefined} />} />
    )
  })

  if (creator && creatorBase) {
    const { data, keys: fileKeys } = creator
    const local = localRoute("sliceCreator")
    const instructions = creatorDraft ? creatorDraft.instructions : data.instructions ?? ""
    const apiTuple = creatorDraft?.tuple ?? creatorBase
    const route: RowTuple = local ? localTuple(local) : apiTuple
    const set = (patch: Partial<CreatorDraft>) => setCreatorDraft((current) => ({ tuple: apiTuple, instructions, ...current, ...patch }))
    const { all, providers, hasDefault } = toolChoices("sliceCreator", data.choices)
    cards.push(
      <AssistantCard key="sliceCreator" id="sliceCreator" title={t("sliceCreator.title")} summary={t("sliceCreator.summary")} route={route} choices={all} providers={providers} {...shared}
        // The Block creator runs on its own .env.local key, not the Convex one: an API key's word follows that file.
        // Nothing records a refused file key, so it has no Invalid key.
        problem={(p) => isTool(p) ? problem(p) : fileKeys[p] ? undefined : "notSetUp"}
        optionDisabled={(p) => isTool(p) ? !toolReady(localTools, p) || !hasDefault(p) : data.defaults[p] === null}
        selectDisabled={false}
        onProvider={(p) => {
          if (isTool(p)) return chooseTool("sliceCreator", p)
          leaveTool("sliceCreator")
          if (p === creatorBase.provider) {
            if (creatorDraft) set({ tuple: creatorBase })
          } else set({ tuple: data.defaults[p]! })
        }}
        onRoute={(next) => next.mode === "local" ? setLocal("sliceCreator", { engine: next.provider, model: next.model, effort: next.reasoning.effort }) : set({ tuple: next })}
        effortLocked={false}
        instructions={<Instructions id="sliceCreator" value={instructions} placeholder={t("sliceCreator.prompt")} onChange={(value) => set({ instructions: value })}
          onReset={instructions !== "" ? () => set({ instructions: "" }) : undefined} />} />
    )
  }

  const dirty = assistants.some((assistant) => drafts[assistant.id] !== undefined) || creatorDraft !== undefined || Object.keys(localDrafts).length > 0
  /** The plan name of a subscription signed in with a plan, when known. */
  const plan = (tool: LocalToolEngine) => {
    if (toolStatus(localTools, tool) !== "plan") return undefined
    const name = tool === "codex" ? "chatgpt" : localTools?.claudePlan
    return name ? t("plan", { plan: name }) : undefined
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-0">
        <Rail tab={tab} />
        <div className="min-w-0 flex-1 lg:pl-6" data-testid="ai-pane">
          {tab === "providers" ? (
            // Where each key is read (Convex for the assistants, .env.local for the Block creator):
            // only in local development, while a key has a problem.
            <Providers tools={tools} word={word} plan={plan} keysNote={isLocal && APIS.some((p) => !usable(p))} />
          ) : (
            <div className="space-y-4" data-testid="assistants">
              {noProvider && (
                <p data-testid="no-provider" className="text-sm">
                  {t("noProvider")}{" "}
                  <TabLink to="providers" testId="no-provider-link" className={linkCls}>{t("yourProviders")}</TabLink>
                </p>
              )}
              {cards}
              <div className="flex justify-end border-t pt-4"><Button disabled={!dirty || saving} onClick={save}><Check /> {t("save")}</Button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** "" means no instructions: the default text is only a placeholder and is never sent. */
type CreatorDraft = { tuple: Tuple; instructions: string }
/** `undefined`: unchanged; `null`: the assistant goes back to its API service. */
type LocalDrafts = Partial<Record<LocalAssistant, LocalToolChoice | null>>

export function AiSettingsRoute({ isLocal, localKeys, localTools }: { isLocal: boolean; localKeys?: LocalProviderKeyPresence; localTools?: LocalToolsData }) {
  const t = useTranslations("settings.aiScreen")
  const gate = useModuleGate("ai")
  // Direct address while AI is off: only the notice (the Settings menu hides AI).
  if (gate.state === "off")
    return (
      <p data-testid="ai-off" className="text-sm">
        {t.rich("off", { link: (chunks) => <Link href="/admin/settings/modules" className={linkCls}>{chunks}</Link> })}
      </p>
    )
  return <OptionalModuleRoute moduleId="ai" title={t("title")} offNotice={t("offNotice")} errorText={t("errorTitle")} errorDescription={t("errorDescription")} retryLabel={t("retry")} needsSetup="render"><SettingsAiScreen isLocal={isLocal} localKeys={localKeys} localTools={localTools} /></OptionalModuleRoute>
}
