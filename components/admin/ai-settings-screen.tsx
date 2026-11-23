"use client"

import { useEffect, useState, useTransition, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { useMutation, useQuery } from "convex/react"
import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { ArrowUpRight, Check, ChevronsUpDown, Copy, KeyRound, Laptop, RefreshCw, Sparkles, type LucideIcon } from "lucide-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
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
import { AiSettingsModelPicker, ModelTag, updatedSinceRefresh, type ListsUpdated, type ModelChoice } from "./ai-settings-model-picker"
import { LOCAL_API_KEY_NAMES, type LocalProviderKeyPresence } from "@/lib/local-api-keys"
import { localToolModelName } from "@/lib/local-model-names"
import { resolveBlockCreatorSelection } from "@/lib/blocks/authoring/creator-selection"

// Settings › AI: approved restore prototype dbd446a6 (owner, 2026-11-22).
// Provider tabs keep setup actions beside their actual readiness and key
// location. Ready providers hide the setup link. The tab lives in `?tab=` and changes in the browser only
// (`history.pushState`): each server render runs the local tools' status
// commands. Drafts live above the tabs, so unsaved edits survive a tab change.

type Status = NonNullable<FunctionReturnType<typeof api.cms.aiSettings.status>>
type Assistant = Status["assistants"][number]
type Provider = Assistant["provider"]
type Tuple = Assistant["effective"]
type Draft = { tuple: Tuple; instructions?: string }
type Choice = ModelChoice
type Effort = Choice["efforts"][number]
type CreatorData = FunctionReturnType<typeof api.cms.aiSettings.blockCreator>
type BlockCreatorProps = { data: CreatorData; keys: LocalProviderKeyPresence }

// Local tools (ADR-0057 step 1): offered to every assistant, in a browser on
// this computer only. The choice is saved in the local file by a server
// action, never in Convex; Convex keeps the API service choice.
export type LocalToolEngine = "claude" | "codex"
/** The sign-in method only; never the tool's own output. */
export type LocalToolStatus = "plan" | "api-key" | "unknown" | "signed-out" | "not-installed"
export type LocalAssistant = "help" | "blockCreator" | "writing" | "translation"
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
type TabId = "claude-code" | "codex" | "anthropic-api" | "openai-api" | "openrouter-api"
type Tab = "assistants" | TabId
type T = ReturnType<typeof useTranslations<"settings.aiScreen">>

const TOOLS: LocalToolEngine[] = ["claude", "codex"]
const APIS: Provider[] = ["anthropic", "openai", "openrouter"]
const TAB_OF: Record<RowProvider, TabId> = { claude: "claude-code", codex: "codex", anthropic: "anthropic-api", openai: "openai-api", openrouter: "openrouter-api" }
const PROVIDER_OF = Object.fromEntries(Object.entries(TAB_OF).map(([provider, tab]) => [tab, provider])) as Record<TabId, RowProvider>
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
const nameOf = (t: T, provider: RowProvider) => t(`names.${TAB_OF[provider]}`)
const effortOf = (tuple: RowTuple) => ("reasoning" in tuple ? tuple.reasoning?.effort : undefined)
// A tool may use a plan, an API key or an unverified method. Provider identity
// never proves who funds a run; both copy surfaces use the same neutral label.
const fundingCopyKind = (provider: RowProvider) => isTool(provider) ? "local" : "api"

// ---- Status words -----------------------------------------------------------------------

/** One meaning each (GLOSSARY.md "Status words"). */
export type StatusWord = "ready" | "signedOut" | "notInstalled" | "notSetUp" | "invalidKey"

/**
 * A missing program is Not installed; an installed, signed-out one is Signed
 * out. An API key: missing → Not set
 * up, refused → Invalid key, connected or unreachable → Ready. "Invalid key"
 * is only for an API key, "Signed out" only for a subscription, and a provider
 * is never "Active".
 */
export function statusWord(provider: RowProvider, connections: Status["connections"], local: ToolFacts): StatusWord {
  if (isTool(provider)) return toolReady(local, provider) ? "ready" : toolStatus(local, provider) === "signed-out" ? "signedOut" : "notInstalled"
  const state = connections.find((c) => c.provider === provider)?.state ?? "missing"
  return state === "missing" ? "notSetUp" : state === "refused" ? "invalidKey" : "ready"
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

/** The Block creator's tuple before any edit: saved, else the default of the
 *  provider it would run with on this computer, else the first offered default. */
function creatorBaseTuple({ data, keys }: BlockCreatorProps): Tuple | undefined {
  if (data.tuple) return data.tuple
  const provider = resolveBlockCreatorSelection(undefined, keys).provider
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
  const badge = problem ? (
    <span className="flex items-center gap-2">
      <StatusBadge tone="warn" text={t(`words.${problem}`)} testId={`assistant-status-${id}`} word={problem} />
      <TabLink to={TAB_OF[provider]} testId={`providers-link-${id}`} className={cn("text-xs", linkCls)}>{nameOf(t, provider)}</TabLink>
    </span>
  ) : selected
    ? <StatusBadge tone="ok" text={t("words.ready")} testId={`assistant-status-${id}`} word="ready" />
    : <StatusBadge tone="warn" text={t("chooseAnotherModel")} testId={`assistant-status-${id}`} word="chooseAnotherModel" />
  return (
    <Card role="region" aria-labelledby={`assistant-title-${id}`} aria-describedby={`assistant-summary-${id}${id === "writing" ? " assistant-presets" : ""}`} data-testid={`assistant-${id}`} className="overflow-visible">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h3 id={`assistant-title-${id}`} className="font-heading text-base leading-normal font-medium">{title}</h3>
          {badge}
        </div>
        <p data-testid={`top-line-${id}`} className="text-sm text-foreground">
          {t.rich("redesign.uses", { provider: nameOf(t, provider), billing: t(`redesign.billing.${fundingCopyKind(provider)}`), model: modelName,
            b: (chunks) => <strong className="font-semibold">{chunks}</strong> })}{effort ? ` · ${effort}` : ""}
        </p>
        <Description id={`assistant-summary-${id}`}>{props.summary}</Description>
        {disabled && <p id={`assistant-reason-${id}`} data-testid={`assistant-reason-${id}`} className="text-sm text-amber-800 dark:text-amber-200">{t("redesign.disabledReason", { provider: nameOf(t, provider), state: t(`words.${problem}`) })}</p>}
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
                describedBy={[disabled && `assistant-reason-${id}`, fableNeedsPlan && `fable-description-${id}`].filter(Boolean).join(" ") || undefined}
                updated={isTool(provider) ? undefined : props.lists(provider)}
                onChange={(model) => props.onRoute(withModel(provider, models.find((c) => c.model === model)!, effort))} />
            </div>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{t("effort")}</span>
            <select data-testid={`effort-${id}`} className={selectCls} value={effort ?? ""} disabled={disabled || props.effortLocked || !selected || efforts.length === 0}
              aria-describedby={[disabled && `assistant-reason-${id}`, fableNeedsPlan && `fable-description-${id}`, !disabled && props.effortLocked && `effort-locked-${id}`].filter(Boolean).join(" ") || undefined}
              onChange={(event) => props.onRoute({ mode: route.mode === "local" ? "local" : "catalog", provider, model: route.model, reasoning: { kind: "effort", effort: event.target.value } } as RowTuple)}>
              {effort === undefined && offeredEfforts.length > 0 && <option value="" disabled>{t("effortNotSet")}</option>}
              {efforts.length === 0 ? <option value="">{t("noEffort")}</option> : efforts.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {fableNeedsPlan && <Description id={`fable-description-${id}`} testId="fable-plan">{t("fableNeedsPlan")}</Description>}
        {!disabled && props.effortLocked && <Description id={`effort-locked-${id}`}>{t("redesign.effortLocked")}</Description>}
        {props.instructions}
        {id === "writing" && <Description id="assistant-presets">{t("presetsNote")}</Description>}
      </CardContent>
    </Card>
  )
}

function Instructions({ id, value, placeholder, onChange, onReset }: { id: string; value: string; placeholder?: string; onChange: (value: string) => void; onReset?: () => void }) {
  const t = useTranslations("settings.aiScreen")
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`prompt-${id}`}>{t("instructions")}</Label>
      <Textarea id={`prompt-${id}`} aria-describedby={`instructions-description-${id}`} rows={2} maxLength={4000} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      <Description id={`instructions-description-${id}`}>{t("instructionsNote")}</Description>
      {onReset && <p className="text-xs"><button type="button" className={linkCls} onClick={onReset}>{t("reset")}</button></p>}
    </div>
  )
}

// ---- Provider rail and setup ------------------------------------------------------------

const SETUP_URLS: Record<RowProvider, string> = {
  claude: "https://code.claude.com/docs/en/quickstart",
  codex: "https://learn.chatgpt.com/docs/codex/cli",
  anthropic: "https://platform.claude.com/docs/en/get-api-key",
  openai: "https://developers.openai.com/api/docs/quickstart",
  openrouter: "https://openrouter.ai/docs/api-reference/authentication",
}
const KEY_URLS: Record<Provider, string> = {
  anthropic: "https://platform.claude.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
}
const KEY_EXAMPLES: Record<Provider, string> = { anthropic: "sk-ant-...", openai: "sk-...", openrouter: "sk-or-..." }
const SUB_COMMANDS = {
  claude: { signIn: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
  codex: { signIn: "codex login", install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
} as const

function Description({ id, children, testId }: { id: string; children: ReactNode; testId?: string }) {
  return <span id={id} className="sr-only" data-helper-copy data-testid={testId}>{children}</span>
}

function Rail({ tab, tools, word }: { tab: Tab; tools: LocalToolEngine[]; word: (provider: RowProvider) => StatusWord }) {
  const t = useTranslations("settings.aiScreen")
  const item = (to: Tab, Icon: LucideIcon, label: string, state?: StatusWord) => (
    <TabLink key={to} to={to} current={tab === to} testId={`rail-${to}`}
      className={cn("flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        tab === to ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="lg:flex-1">{label}</span>
      {state && <><span aria-hidden data-testid={`rail-dot-${to}`} className={cn("size-2 shrink-0 rounded-full", state === "ready" ? "bg-emerald-500" : state === "invalidKey" ? "bg-destructive" : "bg-muted-foreground/40")} /><span className="sr-only">{t(`words.${state}`)}</span></>}
    </TabLink>
  )
  return (
    <aside className="w-full min-w-0 border-b border-border pb-3 lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0 lg:pr-3 lg:pb-0">
      <nav aria-label={t("rail.label")} data-testid="ai-rail" className="relative flex gap-0.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {item("assistants", Sparkles, t("rail.assistants"))}
        {tools.length > 0 && <div data-testid="group-subscriptions" className="contents">
          <span aria-hidden className="mx-1 w-px shrink-0 self-stretch bg-border lg:hidden" />
          <p className="mt-4 mb-1 hidden px-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase lg:block">{t("redesign.rail.subscriptions")}</p>
          {tools.map((provider) => item(TAB_OF[provider], Laptop, nameOf(t, provider), word(provider)))}
        </div>}
        <div data-testid="group-api-keys" className="contents">
          <span aria-hidden className="mx-1 w-px shrink-0 self-stretch bg-border lg:hidden" />
          <p className="mt-4 mb-1 hidden px-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase lg:block">{t("rail.apiKeys")}</p>
          {APIS.map((provider) => item(TAB_OF[provider], KeyRound, nameOf(t, provider), word(provider)))}
        </div>
      </nav>
    </aside>
  )
}

function SetupLink({ provider }: { provider: RowProvider }) {
  const t = useTranslations("settings.aiScreen")
  return <a href={SETUP_URLS[provider]} target="_blank" rel="noreferrer" data-testid={`setup-${provider}`} className="inline-flex items-center gap-0.5 text-xs text-foreground underline underline-offset-4">
    {t("local.setupLink")}<span className="sr-only">: {t("local.setupLinkName", { provider: nameOf(t, provider) })}</span><ArrowUpRight className="size-3" aria-hidden />
  </a>
}

function KeyLink({ provider }: { provider: Provider }) {
  const t = useTranslations("settings.aiScreen.redesign.steps")
  return <a href={KEY_URLS[provider]} target="_blank" rel="noreferrer" data-testid={`get-key-${TAB_OF[provider]}`} className="inline-flex items-center gap-0.5 text-xs text-foreground underline underline-offset-4">
    {t("getKey")}<ArrowUpRight className="size-3" aria-hidden /><span className="sr-only"> {t("newTab")}</span>
  </a>
}

function CopyButton({ text, what, testId }: { text: string; what: string; testId: string }) {
  const t = useTranslations("settings.aiScreen.redesign.steps")
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const [copies, setCopies] = useState(0)
  useEffect(() => {
    if (copies === 0) return
    const timer = window.setTimeout(() => setState((current) => current === "copied" ? "idle" : current), 2000)
    return () => window.clearTimeout(timer)
  }, [copies])
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(text)
      setState("copied")
      setCopies((current) => current + 1)
    } catch { setState("failed") }
  }
  return <>
    <Button type="button" variant="outline" size="sm" data-testid={testId} data-copy-state={state} onClick={copy}>
      {state === "copied" ? <><Check aria-hidden data-icon="inline-start" />{t("copied")}</> : <><Copy aria-hidden data-icon="inline-start" />{t("copy")}<span className="sr-only"> {what}</span></>}
    </Button>
    <span role="status" className={state === "failed" ? "text-xs text-destructive" : "sr-only"}>{state === "copied" ? t("copied") : state === "failed" ? t("copyFailed") : ""}</span>
  </>
}

function Steps({ testId, intro, code, after, link, children, line }: { testId: string; intro: ReactNode; code: string; after?: ReactNode; link?: ReactNode; children?: ReactNode; line?: boolean }) {
  const t = useTranslations("settings.aiScreen.redesign.steps")
  return <div role="group" aria-labelledby={`${testId}-intro`} aria-describedby={after ? `${testId}-after` : undefined} data-testid={testId} className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm text-foreground">
    <p id={`${testId}-intro`}>{intro}</p>
    <div className="@container/step flex flex-wrap items-center gap-2">
      <code data-testid={`${testId}-code`} className="block min-w-0 basis-full @md/step:flex-1 overflow-x-auto whitespace-pre rounded-md border bg-background px-2 py-1.5 font-mono text-xs">{code}</code>
      <CopyButton key={code} text={code} what={t(line ? "line" : "command")} testId={`${testId}-copy`} />{link}
    </div>
    {after && <Description id={`${testId}-after`}>{after}</Description>}{children}
  </div>
}

/** A real Next server refresh re-runs the owner-gated tool status checks. */
function CheckAgain() {
  const t = useTranslations("settings.aiScreen.redesign.steps")
  const router = useRouter()
  const [checking, startTransition] = useTransition()
  const [checked, setChecked] = useState(false)
  const [checks, setChecks] = useState(0)
  useEffect(() => {
    if (checks === 0 || checking) return
    const timer = window.setTimeout(() => setChecked(false), 2000)
    return () => window.clearTimeout(timer)
  }, [checks, checking])
  return <div className="flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" size="sm" data-testid="check-again" disabled={checking} onClick={() => startTransition(() => { router.refresh(); setChecked(true); setChecks((current) => current + 1) })}>
      <RefreshCw aria-hidden data-icon="inline-start" className={cn(checking && "animate-spin motion-reduce:animate-none")} />{t("check")}
    </Button>
    <span role="status" data-testid="check-again-status" className="text-xs text-muted-foreground">{checked && !checking ? t("checked") : ""}</span>
  </div>
}

function Section({ title, testId, action, children }: { title: string; testId: string; action?: ReactNode; children: ReactNode }) {
  return <section aria-labelledby={`${testId}-title`} data-testid={testId} className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><h3 id={`${testId}-title`} className="text-sm font-medium">{title}</h3>{action}</div>{children}
  </section>
}

function ModelsCheck({ lists }: { lists: ListsUpdated }) {
  const t = useTranslations("settings.aiScreen")
  const locale = useLocale()
  const when = lists.at === undefined ? undefined : new Date(lists.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Button type="button" variant="ghost" size="sm" data-testid="check-models" disabled={lists.refreshing} aria-describedby="models-checked" onClick={lists.onRefresh}>
      <RefreshCw aria-hidden data-icon="inline-start" className={cn(lists.refreshing && "animate-spin motion-reduce:animate-none")} />{t(lists.refreshing ? "redesign.modelCheck.checking" : "redesign.modelCheck.check")}
    </Button>
    <span id="models-checked" role="status" data-testid="models-checked" className="text-xs text-muted-foreground">{when ? t("redesign.modelCheck.checked", { when }) : t("redesign.modelCheck.never")}</span>
  </div>
}

function KeyRow({ name, note, detail, tone, text, testId, children }: { name: string; note: string; detail: string; tone: Tone; text: string; testId: string; children?: ReactNode }) {
  return <li data-testid={testId} className="@container/key space-y-2 px-4 py-2.5 text-sm">
    <div role="group" aria-labelledby={`${testId}-name`} aria-describedby={`${testId}-description`} className="flex flex-wrap @md/key:flex-nowrap items-start justify-between gap-3">
      <p id={`${testId}-name`} className="contents @md/key:block min-w-0 font-medium"><span>{name}</span>{" "}<span data-testid={`${testId}-variable`} className="order-last block min-w-0 basis-full overflow-x-auto whitespace-pre @md/key:inline @md/key:overflow-visible @md/key:whitespace-normal @md/key:break-all font-mono text-xs font-normal text-muted-foreground">{detail}</span></p>
      <Description id={`${testId}-description`}>{note}</Description><StatusBadge tone={tone} text={text} />
    </div>{children}
  </li>
}

function ProviderPane({ provider, status, localTools, localKeys, models, usedBy, lists, siteFolder, knownModels }: {
  provider: RowProvider; status: Status; localTools?: LocalToolsData; localKeys?: LocalProviderKeyPresence;
  models: Choice[]; usedBy: string[]; lists?: ListsUpdated; siteFolder: string; knownModels?: string[]
}) {
  const t = useTranslations("settings.aiScreen")
  const locale = useLocale()
  const word = statusWord(provider, status.connections, localTools)
  const ready = word === "ready"
  const connection = status.connections.find((entry) => entry.provider === provider)
  const tool = isTool(provider) ? toolStatus(localTools, provider) ?? "not-installed" : undefined
  const plan = provider === "codex" ? "chatgpt" : localTools?.claudePlan
  const badge = tool === "plan" ? (plan ? t("tab.signedIn", { plan }) : t("tab.signedInNoPlan"))
    : tool ? t(`local.state.${tool}`) : ready ? t("redesign.connected") : t(`words.${word}`)
  const billing = fundingCopyKind(provider)
  const Icon = isTool(provider) ? Laptop : KeyRound
  const commands = isTool(provider) ? SUB_COMMANDS[provider] : undefined
  const installed = tool !== "not-installed"
  const keyState = connection?.state === "refused" ? "refused" : connection?.state === "missing" ? "missing" : "connected"
  const at = connection?.observedAt === undefined ? undefined : new Date(connection.observedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })
  return <Card role="region" aria-labelledby="provider-title" aria-describedby="provider-description" data-testid="provider-panel" data-provider={TAB_OF[provider]}>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="provider-title" className="flex items-center gap-2 font-heading text-base leading-normal font-medium"><Icon className="size-4" aria-hidden />{nameOf(t, provider)}</h2>
        <StatusBadge tone={rowTone(word)} text={badge} testId="provider-status" word={word} />
      </div>
      <Description id="provider-description">{t(`redesign.sentence.${billing}`)}{isTool(provider) ? ` ${t("local.note")}` : ""}</Description>
      {!ready && <div><SetupLink provider={provider} /></div>}
      {connection?.state === "refused" && at && <p data-testid="provider-refused" className="text-sm text-destructive">{t("connection.refused", { provider: nameOf(t, provider), envVar: connection.envVar, at })}</p>}
      {connection?.state === "unreachable" && at && <p data-testid="provider-unreachable" className="text-sm text-amber-800 dark:text-amber-200">{t("connection.unreachable", { provider: nameOf(t, provider), envVar: connection.envVar, at })}</p>}
      {commands && !ready && <Steps key={`${provider}-${tool}`} testId="steps-subscription" intro={t(installed ? "redesign.steps.runIn" : "redesign.steps.run", { siteFolder })}
        code={installed ? commands.signIn : commands.install}
        after={installed ? t("redesign.steps.afterSignIn") : t.rich("redesign.steps.afterInstall", { siteFolder, command: commands.signIn, c: (chunks) => <code className="font-mono text-xs">{chunks}</code> })}>
        <CheckAgain />
      </Steps>}
      {!isTool(provider) && !ready && <Steps testId="steps-deployment" intro={t(keyState === "refused" ? "redesign.steps.deploymentRefused" : "redesign.steps.deploymentMissing", { siteFolder })}
        code={`npx convex env set ${connection!.envVar} ${KEY_EXAMPLES[provider]}`} link={<KeyLink provider={provider} />} after={t("redesign.steps.deploymentAfter")} />}
    </CardHeader>
    <CardContent className="space-y-5">
      {!isTool(provider) && <Section title={t("redesign.keys.title")} testId="provider-keys"><ul className="divide-y rounded-md border">
        <KeyRow name={t("redesign.keys.deployment")} note={t("redesign.keys.deploymentNote")} detail={connection!.envVar} testId="key-deployment" tone={rowTone(word)} text={t(`redesign.keys.${keyState}`)} />
        {localKeys && <KeyRow name={t("redesign.keys.local")} note={t("redesign.keys.localNote")} detail={LOCAL_API_KEY_NAMES[provider][0]} testId="key-local" tone={localKeys[provider] ? "ok" : "off"} text={t(localKeys[provider] ? "redesign.keys.found" : "redesign.keys.missing")}>
          {!localKeys[provider] && <Steps testId="steps-local" intro={t("redesign.steps.localMissing", { siteFolder })} code={`${LOCAL_API_KEY_NAMES[provider][0]}=${KEY_EXAMPLES[provider]}`} line />}
        </KeyRow>}
      </ul></Section>}
      <Section title={t("redesign.models")} testId="provider-models" action={lists && <ModelsCheck lists={lists} />}>
        <ul className="divide-y rounded-md border">{models.map((model) => <li key={model.model} data-unavailable={model.unavailable ? "true" : undefined} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
          <span className={cn(model.unavailable && "text-muted-foreground opacity-60")}>{model.name ?? model.model}</span>
          {knownModels && !knownModels.includes(model.model) ? <span className="shrink-0 rounded-sm border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">{t("redesign.modelCheck.new")}</span> : <ModelTag model={model} />}
        </li>)}</ul>
      </Section>
      <Section title={t("redesign.usedBy")} testId="used-by">{usedBy.length ? <p className="text-sm"><span data-testid="used-by-names">{usedBy.join(", ")}</span> · <TabLink to="assistants" className={cn("text-xs", linkCls)}>{t("redesign.changeInAssistants")}</TabLink></p> : <p data-testid="used-by-names" className="text-sm text-muted-foreground">{t("redesign.none")}</p>}</Section>
    </CardContent>
  </Card>
}

// ---- Screen -----------------------------------------------------------------------------

export function SettingsAiScreen({ isLocal, localKeys, localTools: offeredTools, siteFolder }: { isLocal: boolean; localKeys?: LocalProviderKeyPresence; localTools?: LocalToolsData; siteFolder: string }) {
  const t = useTranslations("settings.aiScreen")
  const common = useTranslations("settings.common")
  const errors = useTranslations("common")
  const searchParams = useSearchParams()
  const localTools = isLocal ? offeredTools : undefined
  const status = useQuery(api.cms.aiSettings.status, {})
  // The Block creator exists only in local development, where the server passes key presence.
  const keys = isLocal ? localKeys : undefined
  const creatorData = useQuery(api.cms.aiSettings.blockCreator, keys ? {} : "skip")
  const saveAssistant = useMutation(api.cms.aiSettings.setAssistant)
  const saveCreator = useMutation(api.cms.aiSettings.setBlockCreator)
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
  const [knownModels, setKnownModels] = useState<Partial<Record<Provider, string[]>>>()
  const [refreshing, setRefreshing] = useState(false)
  // null: the AI module is off; the route shows its own AI-off state.
  if (status === undefined || status === null || (keys && creatorData === undefined)) return null

  const tools = localTools ? TOOLS : []
  const requestedTab = searchParams.get("tab")
  const requestedProvider = requestedTab && Object.hasOwn(PROVIDER_OF, requestedTab) ? PROVIDER_OF[requestedTab as TabId] : undefined
  // Old links to the removed overview still open a real provider panel.
  const tab: Tab = requestedTab === "providers" ? (tools.length ? "claude-code" : "anthropic-api")
    : requestedProvider && (!isTool(requestedProvider) || localTools) ? requestedTab as TabId : "assistants"

  const creator = keys && creatorData ? { data: creatorData, keys } : undefined
  const assistants = status.assistants.filter((assistant) => assistant.available)
  const word = (provider: RowProvider) => statusWord(provider, status.connections, localTools)
  const problem = (provider: RowProvider) => {
    const value = word(provider)
    return value === "ready" ? undefined : value
  }
  const usable = (provider: RowProvider) => problem(provider) === undefined
  const creatorBase = creator && creatorBaseTuple(creator)
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
  const shared = { problem, lists }

  // The call only schedules the reads: each list says "Updated" once its own
  // read succeeds (its lastSuccessAt moves past the one seen at the click),
  // else Refresh stays.
  async function refreshLists() {
    setKnownModels((current) => current ?? Object.fromEntries(APIS.map((provider) => [provider, paneModels(provider).map((model) => model.model)])))
    setListsBefore(Object.fromEntries(APIS.map((p) => [p, status?.catalogSync?.[p].lastSuccessAt ?? null])))
    setRefreshing(true)
    try {
      await refreshCatalogs({})
    } catch (error) {
      // The existing deployment-wide five-minute limit keeps the provider's
      // last successful check time visible; it is not a new failure.
      if (!isRateLimited(error)) toast.error(errors("error"))
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
        // setBlockCreator replaces the stored entry, so both values travel together.
        const args: FunctionArgs<typeof api.cms.aiSettings.setBlockCreator> = {}
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
    const local = localRoute("blockCreator")
    const instructions = creatorDraft ? creatorDraft.instructions : data.instructions ?? ""
    const apiTuple = creatorDraft?.tuple ?? creatorBase
    const route: RowTuple = local ? localTuple(local) : apiTuple
    const set = (patch: Partial<CreatorDraft>) => setCreatorDraft((current) => ({ tuple: apiTuple, instructions, ...current, ...patch }))
    const { all, providers, hasDefault } = toolChoices("blockCreator", data.choices)
    cards.push(
      <AssistantCard key="blockCreator" id="blockCreator" title={t("blockCreator.title")} summary={t("blockCreator.summary")} route={route} choices={all} providers={providers} {...shared}
        // The Block creator runs on its own .env.local key, not the Convex one: an API key's word follows that file.
        // Nothing records a refused file key, so it has no Invalid key.
        problem={(p) => isTool(p) ? problem(p) : fileKeys[p] ? undefined : "notSetUp"}
        optionDisabled={(p) => isTool(p) ? !toolReady(localTools, p) || !hasDefault(p) : data.defaults[p] === null}
        selectDisabled={false}
        onProvider={(p) => {
          if (isTool(p)) return chooseTool("blockCreator", p)
          leaveTool("blockCreator")
          if (p === creatorBase.provider) {
            if (creatorDraft) set({ tuple: creatorBase })
          } else set({ tuple: data.defaults[p]! })
        }}
        onRoute={(next) => next.mode === "local" ? setLocal("blockCreator", { engine: next.provider, model: next.model, effort: next.reasoning.effort }) : set({ tuple: next })}
        effortLocked={false}
        instructions={<Instructions id="blockCreator" value={instructions} placeholder={t("blockCreator.prompt")} onChange={(value) => set({ instructions: value })}
          onReset={instructions !== "" ? () => set({ instructions: "" }) : undefined} />} />
    )
  }

  const dirty = assistants.some((assistant) => drafts[assistant.id] !== undefined) || creatorDraft !== undefined || Object.keys(localDrafts).length > 0
  const savedAssistants = assistants.map((assistant) => [t(`tasks.${assistant.id}.title`), localTools && savedLocal[assistant.id] ? savedLocal[assistant.id]!.engine : assistant.effective.provider] as [string, RowProvider])
  const savedProvider: [string, RowProvider | undefined][] = [
    ...savedAssistants,
    ...(creator ? [[t("blockCreator.title"), (localTools && savedLocal.blockCreator?.engine) || creatorBase?.provider] as [string, RowProvider | undefined]] : []),
  ]
  const paneProvider = tab === "assistants" ? undefined : PROVIDER_OF[tab]
  const paneModels = (provider: RowProvider): Choice[] => {
    if (isTool(provider)) return localChoices(localTools!, provider)
    const seen = new Map<string, Choice>()
    for (const list of [...assistants.map((assistant) => assistant.choices[provider]), creator?.data.choices[provider] ?? []])
      for (const model of list) if (!seen.has(model.model)) seen.set(model.model, model)
    return [...seen.values()]
  }
  // As in the approved prototype, the page badge names keys needed by the
  // saved assistant routes. Local routes and the Block creator are excluded.
  const neededApis = savedAssistants.map(([, provider]) => provider).filter((provider): provider is Provider => !isTool(provider))
  const refused = neededApis.find((provider) => word(provider) === "invalidKey")
  const missing = neededApis.some((provider) => word(provider) === "notSetUp")
  const pageText = refused ? t("refusedCard", { provider: nameOf(t, refused) }) : missing ? t("missingCard") : t("active")
  return (
    <section aria-labelledby="ai-title" aria-describedby="ai-description" className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h1 id="ai-title" className="text-2xl font-semibold">{t("title")}</h1><StatusBadge tone={refused ? "bad" : missing ? "warn" : "ok"} text={pageText} testId="ai-page-status" /></div>
        <Description id="ai-description">{t("description")}</Description>
      </div>
      <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-0">
        <Rail tab={tab} tools={tools} word={word} />
        <div className="min-w-0 flex-1 lg:pl-6" data-testid="ai-pane">
          {paneProvider ? (
            <ProviderPane key={paneProvider} provider={paneProvider} status={status} localTools={localTools} localKeys={keys} models={paneModels(paneProvider)}
              usedBy={savedProvider.filter(([, provider]) => provider === paneProvider).map(([name]) => name)}
              lists={isTool(paneProvider) ? undefined : lists(paneProvider)} knownModels={isTool(paneProvider) ? undefined : knownModels?.[paneProvider]} siteFolder={siteFolder} />
          ) : (
            <section aria-label={t("rail.assistants")} aria-describedby="assistants-description" className="space-y-4" data-testid="assistants">
              <Description id="assistants-description">{t(isLocal ? "assistantsLocal" : "assistantsLive")}</Description>
              {cards}
              <div className="flex justify-end border-t pt-4"><Button disabled={!dirty || saving} onClick={save}><Check /> {t("save")}</Button></div>
            </section>
          )}
        </div>
      </div>
    </section>
  )
}

/** "" means no instructions: the default text is only a placeholder and is never sent. */
type CreatorDraft = { tuple: Tuple; instructions: string }
/** `undefined`: unchanged; `null`: the assistant goes back to its API service. */
type LocalDrafts = Partial<Record<LocalAssistant, LocalToolChoice | null>>

export function AiSettingsRoute({ isLocal, localKeys, localTools, siteFolder }: { isLocal: boolean; localKeys?: LocalProviderKeyPresence; localTools?: LocalToolsData; siteFolder: string }) {
  const t = useTranslations("settings.aiScreen")
  const gate = useModuleGate("ai")
  // Direct address while AI is off: only the notice (the Settings menu hides AI).
  if (gate.state === "off")
    return (
      <p data-testid="ai-off" className="text-sm">
        {t.rich("off", { link: (chunks) => <Link href="/admin/settings/modules" className={linkCls}>{chunks}</Link> })}
      </p>
    )
  return <OptionalModuleRoute moduleId="ai" title={t("title")} offNotice={t("offNotice")} errorText={t("errorTitle")} errorDescription={t("errorDescription")} retryLabel={t("retry")} needsSetup="render"><SettingsAiScreen isLocal={isLocal} localKeys={localKeys} localTools={localTools} siteFolder={siteFolder} /></OptionalModuleRoute>
}
