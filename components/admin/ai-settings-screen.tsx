"use client"

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { useMutation, useQueries, useQuery } from "convex/react"
import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { AlertTriangle, Ban, Check, CheckCircle2, CircleAlert, KeyRound, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import Link from "next/link"
import { useModuleGate } from "./admin-module-state-provider"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { cn } from "@/lib/utils"
import { OptionalModuleRoute } from "./optional-module-route"
import { AiSettingsModelPicker } from "./ai-settings-model-picker"
import { LOCAL_API_KEY_NAMES, type LocalProviderKeyPresence } from "@/lib/local-api-keys"
import { resolveSliceCreatorSelection } from "@/lib/slices/authoring/creator-selection"

type Status = FunctionReturnType<typeof api.cms.aiSettings.status>
type Assistant = Status["assistants"][number]
type Provider = Assistant["provider"]
type Tuple = Assistant["effective"]
type Draft = { tuple: Tuple; instructions?: string }
type Choice = Assistant["choices"][Provider][number]
type SliceCreatorProps = { data: FunctionReturnType<typeof api.cms.aiSettings.sliceCreator>; keys: LocalProviderKeyPresence }
/** "" means no instructions: the default text is only a placeholder and is never sent. */
type CreatorDraft = { tuple: Tuple; instructions: string }
const SLICE_CREATOR = "sliceCreator"
const PROVIDERS: Provider[] = ["anthropic", "openrouter", "openai"]
const selectCls = "h-9 w-full rounded-md border bg-background px-3 text-sm focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"

const TONE: Record<"off" | "ok" | "warn", string> = {
  off: "border-border bg-muted text-muted-foreground",
  ok: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  warn: "border-amber-500/50 bg-amber-500/15 text-amber-900 dark:text-amber-200",
}

function StatusBadge({ tone, text, testId }: { tone: "off" | "ok" | "warn"; text: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", TONE[tone])}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-muted-foreground/60"
        )}
      />
      {text}
    </span>
  )
}

function ConnRow({ ok, state, title, line, children }: { ok: boolean | null; state?: "missing" | "ok" | "refused" | "unreachable"; title: string; line: string; children?: React.ReactNode }) {
  return (
    <li data-state={state} className="flex items-start gap-3 px-4 py-3 text-sm">
      {state === "refused" ? (
        <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      ) : state === "unreachable" ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      ) : ok === null ? (
        <Ban className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : ok ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
      ) : (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium", state === "refused" && "text-destructive", state === "unreachable" && "text-amber-800 dark:text-amber-200")}>{title}</p>
        <p className={cn("text-muted-foreground", (ok === false || state === "unreachable") && "text-amber-800 dark:text-amber-200", state === "refused" && "text-destructive")}>{line}</p>
        {children}
      </div>
    </li>
  )
}

function CardToggle({ level, className, badge, children }: { level: number; className?: string; badge: React.ReactNode; children: React.ReactNode }) {
  return (
    <AccordionTrigger headingLevel={level} className={cn("items-center gap-2 border-0 py-0 hover:no-underline", className)}>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {badge}
    </AccordionTrigger>
  )
}

// Assistant rows: the panel clips its overflow while it animates, so the row
// and the panel share a 4px inset that leaves room for the focus rings.
const ROW_CLS = "rounded-md border px-3 py-4"
const PANEL_CLS = "h-auto space-y-3 px-1 pt-3 pb-0 [&_p:not(:last-child)]:mb-0"

function tupleSummary(providerName: string, tuple: Tuple, choices: Choice[], withEffort: boolean) {
  const choice = choices.find((c) => c.model === tuple.model)
  const model = choice?.name && choice.name !== choice.model ? choice.name : tuple.model
  const effort = withEffort && "reasoning" in tuple ? tuple.reasoning?.effort : undefined
  return [providerName, model, effort].filter(Boolean).join(" · ")
}

function withModel(provider: Provider, choice: Choice, effort: Choice["efforts"][number] | undefined): Tuple {
  const nextEffort = effort && choice.efforts.includes(effort) ? effort
    : choice.efforts.includes("medium") ? "medium"
    : choice.providerDefault && choice.efforts.includes(choice.providerDefault) ? choice.providerDefault
    : choice.efforts[0]
  return { mode: "catalog", provider, model: choice.model, ...(choice.efforts.length > 0 && nextEffort ? { reasoning: { kind: "effort", effort: nextEffort } } : {}) } as Tuple
}

function ModelFields({ label, tuple, choices, defaults, onChange, setUp, providerDisabled, optionDisabled, disabled, effortLocked }: {
  label: string
  tuple: Tuple
  choices: Assistant["choices"]
  defaults: Assistant["defaults"]
  onChange: (tuple: Tuple) => void
  setUp: (provider: Provider) => boolean
  providerDisabled: boolean
  optionDisabled: (provider: Provider) => boolean
  disabled: boolean
  effortLocked: boolean
}) {
  const t = useTranslations("settings.aiScreen")
  const provider = tuple.provider
  const models = choices[provider]
  const selected = models.find((choice) => choice.model === tuple.model)
  const effort = "reasoning" in tuple ? tuple.reasoning?.effort : undefined
  // A saved explicit tuple remains visible even if the active catalog now refuses it.
  const offeredEfforts = selected?.efforts ?? []
  const efforts = effort && !offeredEfforts.includes(effort) ? [effort, ...offeredEfforts] : offeredEfforts
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">{t("runsWith")}</span>
        <select className={selectCls} value={provider} disabled={providerDisabled} onChange={(event) => {
          const next = defaults[event.target.value as Provider]
          if (next) onChange(next)
        }}>
          {PROVIDERS.map((p) => <option key={p} value={p} disabled={optionDisabled(p)}>{t(`providers.${p}`)}{setUp(p) ? "" : t("notSetUp")}</option>)}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">{t("model")}</span>
        <AiSettingsModelPicker taskLabel={label} models={models} value={tuple.model} disabled={disabled} onChange={(model) => {
          onChange(withModel(provider, models.find((c) => c.model === model)!, effort))
        }} />
      </label>
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">{t("effort")}</span>
        <select className={selectCls} value={effort ?? ""} disabled={disabled || effortLocked || efforts.length === 0} onChange={(event) => onChange({ mode: "catalog", provider, model: tuple.model, reasoning: { kind: "effort", effort: event.target.value } } as Tuple)}>
          {effort === undefined && offeredEfforts.length > 0 && <option value="" disabled>{t("effortNotSet")}</option>}
          {efforts.length === 0 ? <option value="">{t("noEffort")}</option> : efforts.map((value) => <option key={value}>{value}</option>)}
        </select>
      </label>
    </div>
  )
}

function ConnectionsCard({ connections, open }: Pick<Status, "connections"> & { open: boolean }) {
  const t = useTranslations("settings.aiScreen")
  const locale = useLocale()
  function observedTime(at: number) {
    const date = new Date(at)
    const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false })
    return date.toDateString() === new Date().toDateString()
      ? t("today", { time })
      : date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })
  }
  const connected = connections.filter((c) => c.state === "connected").length
  // Owner, 2026-11-11: "Ready" when at least one key works and none is refused.
  const ready = connected > 0 && !connections.some((c) => c.state === "refused")
  return (
    <AccordionItem value="connections" asChild className="not-last:border-b-0">
      <Card data-testid="connections">
        <CardHeader>
          <CardToggle level={2} className="font-heading text-base leading-normal"
            badge={<StatusBadge tone={ready ? "ok" : "warn"} text={ready ? t("ready") : t("needsAttention")} testId="connections-status" />}>
            <KeyRound className="size-4" aria-hidden /> {t("connections")}
          </CardToggle>
          <CardDescription>{open ? t("connectionsDescription") : t("keysConnected", { connected, total: connections.length })}</CardDescription>
        </CardHeader>
        <AccordionContent className="h-auto pb-0 [&_p:not(:last-child)]:mb-0">
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t("apiKeys")}</h3>
              <ul className="divide-y rounded-md border">
                {connections.map((connection) => {
                  const { provider, envVar, state } = connection
                  const name = t(`providers.${provider}`)
                  const values = { provider: name, envVar, at: observedTime(connection.observedAt ?? 0) }
                  return (
                    <ConnRow key={provider} ok={state === "connected" || state === "unreachable"} state={state === "connected" ? "ok" : state} title={name}
                      line={state === "connected" ? t("connected") : t(`connection.${state}`, values)}>
                      {state === "refused" && <div className="mt-1 space-y-1 text-xs text-muted-foreground"><p>{t("replaceKey", { envVar })}</p><p>{t("refusedAssistants", { provider: name })}</p></div>}
                      {state === "unreachable" && <p className="mt-1 text-xs text-muted-foreground">{t("temporary")}</p>}
                      {state === "missing" && <p className="mt-1 text-xs text-muted-foreground">{t("addKey", { envVar })}</p>}
                    </ConnRow>
                  )
                })}
              </ul>
            </div>
          </CardContent>
        </AccordionContent>
      </Card>
    </AccordionItem>
  )
}

function usableIn(status: Status, provider: Provider) {
  return status.connections.some((c) => c.provider === provider && (c.state === "connected" || c.state === "unreachable"))
}

/** The Slice creator's tuple before any edit: saved, else the default of the
 *  provider it would run with on this computer, else the first offered default. */
function creatorBaseTuple({ data, keys }: SliceCreatorProps): Tuple | undefined {
  if (data.tuple) return data.tuple
  const provider = resolveSliceCreatorSelection(undefined, keys).provider
  return (provider ? data.defaults[provider] : null) ?? PROVIDERS.map((p) => data.defaults[p]).find((tuple) => tuple !== null) ?? undefined
}

/** Cards that need the owner start open; the rest start collapsed. Computed once. */
function initialOpen(status: Status, creator: SliceCreatorProps | undefined) {
  const open: string[] = []
  if (status.connections.some((c) => c.state !== "connected")) open.push("connections")
  for (const assistant of status.assistants) {
    if (assistant.available && !usableIn(status, assistant.effective.provider)) open.push(assistant.id)
  }
  const creatorTuple = creator && creatorBaseTuple(creator)
  if (creator && creatorTuple && !creator.keys[creatorTuple.provider]) open.push(SLICE_CREATOR)
  return open
}

function AssistantsCard({ status, isLocal, creator, open }: { status: Status; isLocal: boolean; creator?: SliceCreatorProps; open: string[] }) {
  const t = useTranslations("settings.aiScreen")
  const common = useTranslations("settings.common")
  const saveAssistant = useMutation(api.cms.aiSettings.setAssistant)
  const saveCreator = useMutation(api.cms.aiSettings.setSliceCreator)
  const [drafts, setDrafts] = useState<Partial<Record<Assistant["id"], Draft>>>({})
  const [creatorDraft, setCreatorDraft] = useState<CreatorDraft>()
  const [saving, setSaving] = useState(false)
  const assistants = status.assistants.filter((assistant) => assistant.available)
  const dirty = assistants.some((assistant) => drafts[assistant.id] !== undefined) || creatorDraft !== undefined
  const usable = (provider: Provider) => usableIn(status, provider)
  const anyUsable = status.connections.some((c) => usable(c.provider))
  async function save() {
    const pending = Object.entries(drafts) as [Assistant["id"], Draft][]
    const pendingCreator = creatorDraft
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
      toast.success(t("saved"))
    } catch {
      toast.error(common("failedSave"))
    } finally {
      setSaving(false)
    }
  }
  const creatorTuple = creator && (creatorDraft?.tuple ?? creatorBaseTuple(creator))
  return (
    <Card data-testid="assistants">
      <CardHeader>
        <CardTitle>{t("assistants")}</CardTitle>
        <CardDescription>{t(isLocal ? "assistantsLocal" : "assistantsLive")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {assistants.map((assistant) => {
          const { id } = assistant
          const draft = drafts[id] ?? { tuple: assistant.effective, instructions: assistant.instructions }
          const tuple = draft.tuple
          const provider = tuple.provider
          const connection = status.connections.find((c) => c.provider === provider)
          const isUsable = usable(provider)
          const label = t(`tasks.${id}.title`)
          const set = (patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [id]: { ...draft, ...patch } }))
          return (
            <AccordionItem key={id} value={id} asChild>
              <section data-testid={`assistant-${id}`} className={ROW_CLS}>
                <div className="px-1">
                  <CardToggle level={3}
                    badge={<StatusBadge tone={isUsable ? "ok" : "warn"} text={isUsable ? t("ready") : connection?.state === "refused" ? t("keyRefused") : t("finishConnection")} testId={`assistant-status-${id}`} />}>
                    {label}
                  </CardToggle>
                  <p className="text-sm text-muted-foreground">
                    {open.includes(id) ? t(`tasks.${id}.summary`) : tupleSummary(t(`providers.${assistant.effective.provider}`), assistant.effective, assistant.choices[assistant.effective.provider], id !== "translation")}
                  </p>
                </div>
                <AccordionContent className={PANEL_CLS}>
                  <ModelFields label={label} tuple={tuple} choices={assistant.choices} defaults={assistant.defaults} onChange={(next) => set({ tuple: next })}
                    setUp={usable} providerDisabled={!anyUsable} optionDisabled={(p) => !usable(p) || assistant.defaults[p] === null}
                    disabled={!isUsable} effortLocked={id === "translation"} />
                  <div className="grid gap-1.5">
                    <Label htmlFor={`prompt-${id}`}>{t("instructions")}</Label>
                    <Textarea id={`prompt-${id}`} rows={3} maxLength={4000} value={draft.instructions ?? t(`tasks.${id}.prompt`)} onChange={(event) => set({ instructions: event.target.value })} />
                    <p className="text-xs text-muted-foreground">
                      {t("instructionsNote")}
                      {draft.instructions !== undefined && <> {" "}<button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => set({ instructions: undefined })}>{t("reset")}</button></>}
                    </p>
                  </div>
                  {id === "writing" && <p className="text-xs text-muted-foreground">{t("presetsNote")}</p>}
                </AccordionContent>
              </section>
            </AccordionItem>
          )
        })}
        {creator && creatorTuple && (
          <SliceCreatorRow creator={creator} tuple={creatorTuple} draft={creatorDraft} setDraft={setCreatorDraft} open={open.includes(SLICE_CREATOR)} />
        )}
        <div className="flex justify-end border-t pt-4"><Button disabled={!dirty || saving} onClick={save}><Check /> {t("save")}</Button></div>
      </CardContent>
    </Card>
  )
}

function SliceCreatorRow({ creator: { data, keys }, tuple, draft, setDraft, open }: {
  creator: SliceCreatorProps
  tuple: Tuple
  draft: CreatorDraft | undefined
  setDraft: (draft: CreatorDraft) => void
  open: boolean
}) {
  const t = useTranslations("settings.aiScreen")
  const provider = tuple.provider
  const ready = keys[provider]
  const envVar = LOCAL_API_KEY_NAMES[provider][0]
  // With no local key at all, name every provider's variable, not only the fallback one.
  const anyKey = keys.anthropic || keys.openrouter || keys.openai
  const instructions = draft ? draft.instructions : data.instructions ?? ""
  const label = t("sliceCreator.title")
  const set = (patch: Partial<CreatorDraft>) => setDraft({ tuple, instructions, ...patch })
  return (
    <AccordionItem value={SLICE_CREATOR} asChild>
      <section data-testid="assistant-sliceCreator" className={ROW_CLS}>
        <div className="px-1">
          <CardToggle level={3}
            badge={<StatusBadge tone={ready ? "ok" : "warn"} text={ready ? t("ready") : t("sliceCreator.finishSetup")} testId="assistant-status-sliceCreator" />}>
            {label}
          </CardToggle>
          <p className="text-sm text-muted-foreground">
            {open ? t("sliceCreator.summary") : tupleSummary(t(`providers.${provider}`), tuple, data.choices[provider], true)}
          </p>
        </div>
        <AccordionContent className={PANEL_CLS}>
          <ModelFields label={label} tuple={tuple} choices={data.choices} defaults={data.defaults} onChange={(next) => set({ tuple: next })}
            setUp={(p) => keys[p]} providerDisabled={false} optionDisabled={(p) => data.defaults[p] === null}
            disabled={false} effortLocked={false} />
          {!ready && (
            <div className="space-y-1">
              <p className="text-sm text-amber-800 dark:text-amber-200">{anyKey ? t("sliceCreator.keyMissing", { envVar }) : t("sliceCreator.keyMissingAny")}</p>
              <p className="text-xs text-muted-foreground">{anyKey ? t("sliceCreator.keyHelp", { envVar }) : t("sliceCreator.keyHelpAny", {
                openrouter: LOCAL_API_KEY_NAMES.openrouter[0], anthropic: LOCAL_API_KEY_NAMES.anthropic[0], openai: LOCAL_API_KEY_NAMES.openai[0],
              })}</p>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="prompt-sliceCreator">{t("instructions")}</Label>
            <Textarea id="prompt-sliceCreator" rows={3} maxLength={4000} value={instructions} placeholder={t("sliceCreator.prompt")} onChange={(event) => set({ instructions: event.target.value })} />
            <p className="text-xs text-muted-foreground">
              {t("instructionsNote")}
              {instructions !== "" && <> {" "}<button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => set({ instructions: "" })}>{t("reset")}</button></>}
            </p>
          </div>
        </AccordionContent>
      </section>
    </AccordionItem>
  )
}

function AiSettingsCards({ status, isLocal, creator }: { status: Status; isLocal: boolean; creator?: SliceCreatorProps }) {
  // No stored open/closed state: the default is set once, then the owner's clicks decide.
  const [open, setOpen] = useState(() => initialOpen(status, creator))
  return (
    <Accordion type="multiple" value={open} onValueChange={setOpen} className="gap-6">
      <ConnectionsCard connections={status.connections} open={open.includes("connections")} />
      <AssistantsCard status={status} isLocal={isLocal} creator={creator} open={open} />
    </Accordion>
  )
}

export function SettingsAiScreen({ isLocal, localKeys }: { isLocal: boolean; localKeys?: LocalProviderKeyPresence }) {
  const t = useTranslations("settings.aiScreen")
  const status = useQuery(api.cms.aiSettings.status, {})
  // The Slice creator exists only in local development, where the server passes key presence.
  const keys = isLocal ? localKeys : undefined
  const creator = useQuery(api.cms.aiSettings.sliceCreator, keys ? {} : "skip")
  if (status === undefined || (keys && creator === undefined)) return null
  const text = status.card.state === "active" ? t("active") : status.card.state === "refused" ? t("refusedCard", { provider: t(`providers.${status.card.provider}`) }) : t("missingCard")
  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold">{t("title")}</h1><StatusBadge tone={status.card.state === "active" ? "ok" : "warn"} text={text} testId="ai-page-status" /></div>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <AiSettingsCards status={status} isLocal={isLocal} creator={keys && creator ? { data: creator, keys } : undefined} />
    </div>
  )
}

export function AiSettingsRoute({ isLocal, localKeys }: { isLocal: boolean; localKeys?: LocalProviderKeyPresence }) {
  const t = useTranslations("settings.aiScreen")
  return <OptionalModuleRoute moduleId="ai" title={t("title")} offNotice={t("offNotice")} errorText={t("errorTitle")} errorDescription={t("errorDescription")} retryLabel={t("retry")} needsSetup="render"><SettingsAiScreen isLocal={isLocal} localKeys={localKeys} /></OptionalModuleRoute>
}

export function AiModuleSetupLine({ savedOn }: { savedOn: boolean }) {
  const t = useTranslations("settings.modules.aiSetup")
  const providers = useTranslations("settings.aiScreen.providers")
  const gate = useModuleGate("ai")
  const { status } = useQueries(savedOn ? {
    status: { query: api.cms.aiSettings.status, args: {} },
  } : {}) as { status?: FunctionReturnType<typeof api.cms.aiSettings.status> | Error }
  useEffect(() => {
    if (status instanceof Error) reportContainedModuleFailure("ai", "admin.contribution", status)
  }, [status])
  if (!savedOn || gate.state === "loading" || gate.state === "error" ||
    !status || status instanceof Error || status.card.state === "active") return null
  return (
    <div data-testid="ai-finish-setup" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <div><p>{status.card.state === "refused" ? t("refused", { provider: providers(status.card.provider) }) : t("missing")}</p><p>{t("description")}</p></div>
      <Button size="sm" variant="outline" asChild><Link href="/admin/settings/ai">{t("finish")}</Link></Button>
    </div>
  )
}
