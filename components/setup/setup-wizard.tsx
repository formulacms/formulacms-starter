"use client"

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react"
import { ConvexHttpClient } from "convex/browser"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import {
  NextIntlClientProvider,
  useTranslations,
  type AbstractIntlMessages,
} from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { api } from "@/convex/_generated/api"
import { authClient } from "@/lib/auth-client"
import { SUPPORTED_LOCALES, getLocaleDisplayName } from "@/lib/i18n/config"
import {
  hasAdminDictionary,
  type AdminDictionaryLocale,
} from "@/lib/i18n/admin-dictionaries"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { SetupBootstrapHandoff } from "@/lib/setup/bootstrap-handoff"
import { readSiteDescription } from "@/lib/i18n/site-description"
import type { OwnerCodeTarget } from "@/lib/setup/owner-code-command"
import { OWNER_CLAIM_HEADER } from "@/convex/lib/ownerClaim"

// ─── Step definitions ────────────────────────────────────────────────────────

// The multi-step onboarding form is deferred (01-foundation.md, onboarding
// scope decision 2026-09-13): setup is the owner account plus one atomic
// bootstrap. Email, AI and other languages are configured later in Settings.
// Language and region come first (owner, 2026-11-01): the rest of setup and
// the admin follow the choice. That step is client-only; it saves nothing.
type StepKey = "language" | "account" | "identity"

const STEPS: StepKey[] = ["language", "account", "identity"]

const MIN_PASSWORD_LENGTH = 8

/**
 * Admin dictionaries the wizard can switch to, as `{ setup, caughtErrors }`
 * message slices keyed by locale. Only these two namespaces are shipped to the
 * wizard; the page builds the record on the server.
 */
export type SetupWizardMessages = Record<
  AdminDictionaryLocale,
  AbstractIntlMessages
>

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

function getTimezones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.("timeZone")
    if (supported && supported.length > 0) return supported
  } catch {
    /* fall through */
  }
  return [
    "UTC",
    "America/New_York",
    "America/Toronto",
    "Europe/London",
    "Europe/Paris",
    "Asia/Dubai",
    "Asia/Tokyo",
  ]
}

const TIMEZONES = getTimezones()

function matchSupportedLocale(tag: string): string | null {
  const lower = tag.toLowerCase()
  const supported = SUPPORTED_LOCALES as readonly string[]
  if (supported.includes(lower)) return lower
  const base = lower.split("-")[0] ?? ""
  return supported.includes(base) ? base : null
}

// Browser language and time zone, read through useSyncExternalStore so the
// server render and hydration use the neutral "en" / "UTC" and the client then
// switches to the real values without a hydration mismatch.
function subscribeNever() {
  return () => {}
}
function browserRegionSnapshot() {
  const language =
    typeof navigator === "undefined" ? "" : (navigator.language ?? "")
  return `${language}|${detectTimezone()}`
}
function serverRegionSnapshot() {
  return "|UTC"
}
function useBrowserRegion() {
  const snapshot = useSyncExternalStore(
    subscribeNever,
    browserRegionSnapshot,
    serverRegionSnapshot
  )
  const separator = snapshot.indexOf("|")
  const language = snapshot.slice(0, separator)
  return {
    locale: matchSupportedLocale(language) ?? "en",
    timezone: snapshot.slice(separator + 1) || "UTC",
  }
}

// The address setup was opened on, as an editable suggestion for the Site
// address. Same pattern as the browser region: empty on the server, the real
// origin on the client, with no hydration mismatch.
function browserOriginSnapshot() {
  return typeof window === "undefined" ? "" : window.location.origin
}
function serverOriginSnapshot() {
  return ""
}
function useBrowserOrigin() {
  return useSyncExternalStore(
    subscribeNever,
    browserOriginSnapshot,
    serverOriginSnapshot
  )
}

function useLocalTime(timezone: string, locale: string) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(id)
  }, [])
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(now)
  } catch {
    return ""
  }
}

/** Password input with a show/hide eye button inside it. */
function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
  name,
  children,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  disabled?: boolean
  /** Form field name; defaults to the id. Password managers expect `password`. */
  name?: string
  children?: ReactNode
}) {
  const t = useTranslations("setup.fields")
  const [shown, setShown] = useState(false)
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name ?? id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          className="pr-9"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
          aria-label={shown ? t("hidePassword") : t("showPassword")}
          aria-pressed={shown}
          onClick={() => setShown((current) => !current)}
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </div>
      {children}
    </div>
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type OnboardingProgress = {
  account: boolean
  identity: boolean
  locales: boolean
  ai: boolean
  finished: boolean
}

function hasCompletedOnboardingStep(progress: OnboardingProgress | undefined) {
  return Boolean(
    progress &&
    (progress.account || progress.identity || progress.locales || progress.ai)
  )
}

async function withRetryOnAuthLag<T>(
  fn: () => Promise<T>,
  attempt = 0
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : ""
    if (!msg.toLowerCase().includes("unauthenticated") || attempt >= 14) {
      throw e
    }
    await sleep(300)
    return withRetryOnAuthLag(fn, attempt + 1)
  }
}

async function waitForConvexAuthentication(
  isAuthenticated: () => boolean,
  timeoutMessage: string,
  attempt = 0
): Promise<void> {
  if (isAuthenticated()) return
  if (attempt >= 33) {
    throw new Error(timeoutMessage)
  }
  await sleep(300)
  return waitForConvexAuthentication(
    isAuthenticated,
    timeoutMessage,
    attempt + 1
  )
}

// The setup code is single-use, and its consumption is recorded as a hash, so
// there is no way to recover the original value — only to issue a new one.
// Saying "ask the person who deployed it" is useless when that person is the
// one reading this, which is the common case for a self-hosted CMS. So name
// the way out. The commands match the owner setup code steps in
// docs/starter/local-setup.md (local) and docs/starter/hosting.md (hosted).

/** Collapsed by default: only the deployer needs it, and only when stuck. */
function RotateOwnerCodeHelp({
  reloadAfter,
  target,
}: {
  reloadAfter?: boolean
  target: OwnerCodeTarget
}) {
  const t = useTranslations("setup.ownerCodeHelp")

  if (target.kind === "local-unbound" || target.kind === "live-unbound") {
    return (
      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {t("summary")}
        </summary>
        <div className="mt-3 space-y-2">
          <p className="text-muted-foreground">
            {t(target.kind === "local-unbound" ? "localUnbound" : "liveUnbound")}
          </p>
        </div>
      </details>
    )
  }

  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        {t("summary")}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-muted-foreground">
          {target.kind === "local"
            ? t(reloadAfter ? "instructionsLocalReload" : "instructionsLocal", {
                folder: target.folder,
              })
            : t(reloadAfter ? "instructionsLiveReload" : "instructionsLive", {
                deployment: target.deployment,
              })}
        </p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          <code>{target.command}</code>
        </pre>
        <p className="text-muted-foreground">{t("replacementWarning")}</p>
      </div>
    </details>
  )
}

/**
 * What to tell someone whose account creation just failed.
 *
 * The server cannot say. `claimOwner` returns only `claimed | unavailable`,
 * and the sign-up hook answers a single "Account creation is not available."
 * for a wrong code, a consumed code, an unset code, and an untrusted
 * transport alike — deliberate, per ADR-0007, so the response can't be used
 * to probe the deployment.
 *
 * An unavailable claim result cannot establish a typo, so it always uses
 * unavailable copy. A signup 403 checks fresh public availability over HTTP
 * before blaming a typo; the reactive client's one-off query can reuse its
 * subscribed value. Later consumption also changes the rendered refusal.
 */
type AccountErrorKey =
  | "errors.tooManyAttempts"
  | "errors.accountAlreadyExists"
  | "errors.ownerCodeUnavailable"
  | "errors.createOwner"
  | "errors.ownerCodeMismatch"

type AccountErrorOptions = {
  /** Which call failed. Claim refusal never establishes a typo. */
  source: "signup" | "claim"
  status?: number
  code?: string
  claimAvailable?: boolean
}

function accountErrorMessage(
  options: AccountErrorOptions,
  translate: (key: AccountErrorKey) => string,
  displayError: (error: unknown, fallback: string) => string
): string {
  if (options.status === 429) {
    return translate("errors.tooManyAttempts")
  }
  if (options.code === "USER_ALREADY_EXISTS") {
    return translate("errors.accountAlreadyExists")
  }
  // Only the perimeter hook's 403 identifies a setup-code refusal. Other
  // sign-up failures select allowlisted validation copy or the translated
  // operation fallback, never arbitrary provider wording.
  if (options.source === "signup" && options.status !== 403) {
    return displayError({ code: options.code }, translate("errors.createOwner"))
  }
  // Only a signup refusal with fresh, still-open public availability points
  // to a typo. A claim result alone cannot distinguish a consumed valid code.
  if (options.source === "claim" || options.claimAvailable !== true) {
    return translate("errors.ownerCodeUnavailable")
  }
  return translate("errors.ownerCodeMismatch")
}

function OwnerCodeUnavailable({ target }: { target: OwnerCodeTarget }) {
  const t = useTranslations("setup")

  return (
    <div className="space-y-3">
      {/* Three causes reach here — no code configured, duplicate ledger rows,
          or a genuinely consumed code — and the server won't say which. The
          copy has to hold for all three: `create-formulacms-app` produces the
          unset case whenever it skips the owner-claim step. */}
      <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        {t("errors.ownerCodeUnavailable")}
      </p>
      <RotateOwnerCodeHelp reloadAfter target={target} />
    </div>
  )
}

type SetupRegion = {
  locale: string
  timezone: string
  detectedTimezone: string
  setLocale: (locale: string) => void
  setTimezone: (timezone: string) => void
}

/**
 * Owns the step-1 choices (site language and time zone) so the wizard itself
 * can render in the chosen language. When an admin dictionary exists for the
 * locale (en, fr) the wizard re-renders in it immediately; other locales keep
 * English. Later steps and the bootstrap read the same values.
 */
export function SetupWizard({
  initialSetup,
  messages,
  ownerCodeTarget = { kind: "live-unbound" },
}: {
  initialSetup?: SetupBootstrapHandoff | null
  /** Built on the server: which "Make a new code" block this site shows. */
  ownerCodeTarget?: OwnerCodeTarget
  /** Setup message slices per admin dictionary; without them the wizard uses the surrounding provider. */
  messages?: SetupWizardMessages
}) {
  const { isAuthenticated } = useConvexAuth()
  const ownerSession = useQuery(
    api.cms.owner.getOwnerSession,
    isAuthenticated ? {} : "skip"
  )
  const savedSettings = useQuery(
    api.cms.settings.getSettings,
    ownerSession?.role === "admin" ? {} : "skip"
  )
  const browser = useBrowserRegion()
  const [localeDraft, setLocale] = useState<string | null>(
    initialSetup?.defaultLocale ?? null
  )
  const [timezoneDraft, setTimezone] = useState<string | null>(
    initialSetup?.timezone ?? null
  )
  // Saved settings (a resumed owner) win over what the browser suggests.
  const locale = localeDraft ?? savedSettings?.defaultLocale ?? browser.locale
  const timezone =
    timezoneDraft ?? savedSettings?.timezone ?? browser.timezone
  const wizardLocale = hasAdminDictionary(locale) ? locale : "en"

  useEffect(() => {
    const root = document.documentElement
    const previous = root.lang
    root.lang = wizardLocale
    return () => {
      root.lang = previous
    }
  }, [wizardLocale])

  const body = (
    <SetupWizardBody
      initialSetup={initialSetup}
      ownerCodeTarget={ownerCodeTarget}
      region={{
        locale,
        timezone,
        detectedTimezone: browser.timezone,
        setLocale,
        setTimezone,
      }}
    />
  )
  if (!messages) return body
  const wizardMessages =
    messages[wizardLocale as AdminDictionaryLocale] ?? messages.en
  return (
    <NextIntlClientProvider locale={wizardLocale} messages={wizardMessages}>
      {body}
    </NextIntlClientProvider>
  )
}

function SetupWizardBody({
  initialSetup,
  region,
  ownerCodeTarget,
}: {
  initialSetup?: SetupBootstrapHandoff | null
  ownerCodeTarget: OwnerCodeTarget
  region: SetupRegion
}) {
  const displayError = useCaughtError()
  const t = useTranslations("setup")
  const convex = useConvex()
  const router = useRouter()
  const { data: session } = authClient.useSession()
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth()
  const convexAuthenticatedRef = useRef(isConvexAuthenticated)
  useEffect(() => {
    convexAuthenticatedRef.current = isConvexAuthenticated
  }, [isConvexAuthenticated])

  const progress = useQuery(api.cms.settings.getOnboardingProgress, {})
  const ownerClaimAvailability = useQuery(
    api.cms.owner.getOwnerClaimAvailability,
    {}
  )
  const ownerEstablished = useQuery(api.cms.owner.getOwnerEstablished, {})
  const ownerAccountExists =
    progress?.account === true || ownerEstablished?.established === true
  const onboardingFinished = progress?.finished === true

  const ownerSession = useQuery(
    api.cms.owner.getOwnerSession,
    isConvexAuthenticated ? {} : "skip"
  )
  const ownerRoleEstablished = ownerSession?.role === "admin"
  const savedSettings = useQuery(
    api.cms.settings.getSettings,
    ownerRoleEstablished ? {} : "skip"
  )

  // The stored admin language survives a reload, unlike the ref below.
  const storedAdminLocale = useQuery(
    api.cms.userPreferences.getAdminLocale,
    ownerRoleEstablished ? {} : "skip"
  )
  const setAdminLocale = useMutation(api.cms.userPreferences.setAdminLocale)
  const claimOwner = useMutation(api.cms.owner.claimOwner)
  const replaceOwner = useMutation(api.cms.owner.replaceOwner)
  const bootstrapInstallation = useMutation(
    api.cms.settings.bootstrapInstallation
  )

  const [replacingOwner, setReplacingOwner] = useState(false)
  // Step 1 is client-only and never blocks a resumed owner: it always shows
  // first, and bookmarks route only the steps after it.
  const [languageDone, setLanguageDone] = useState(false)
  // Bookmarks stamped by the retired language/AI steps do not route anywhere:
  // once an owner exists, the only remaining step is the bootstrap.
  const progressStepKey: StepKey = ownerAccountExists ? "identity" : "account"
  const [stepOverride, setStepOverride] = useState<StepKey | null>(null)
  const stepKey: StepKey = replacingOwner
    ? "account"
    : !languageDone
      ? "language"
      : (stepOverride ?? progressStepKey)
  const hasResumeBanner =
    languageDone &&
    stepOverride === null &&
    progressStepKey !== "account" &&
    hasCompletedOnboardingStep(progress)

  // Keep the refusal cause, so a later public availability update can correct
  // the alert even when the claim response settled before that query update.
  const [errorState, setError] = useState<
    string | AccountErrorOptions | null
  >(null)
  const error =
    typeof errorState === "string"
      ? errorState
      : errorState
        ? accountErrorMessage(
            {
              ...errorState,
              claimAvailable:
                errorState.claimAvailable === true &&
                ownerClaimAvailability?.available === true,
            },
            t,
            displayError
          )
        : null
  // Claiming the owner role is the one irreversible step in the wizard, and it
  // used to pass silently — the step simply advanced. Say what happened.
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Account
  const [name, setName] = useState("")
  const [email, setEmail] = useState(initialSetup?.adminEmail ?? "")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [ownerClaim, setOwnerClaim] = useState("")
  const passwordsMatch = password === confirmPassword
  const passwordAcceptable =
    password.length >= MIN_PASSWORD_LENGTH && passwordsMatch

  // Identity
  const [siteNameDraft, setSiteName] = useState<string | null>(
    initialSetup?.siteName ?? null
  )
  const [siteUrlDraft, setSiteUrl] = useState<string | null>(
    initialSetup?.siteUrl ?? null
  )
  const [siteDescriptionDraft, setSiteDescription] = useState<string | null>(
    initialSetup?.siteDescription ?? null
  )

  const siteName = siteNameDraft ?? savedSettings?.siteName ?? ""
  // Only a suggestion, and only while nothing is saved: a saved or edited
  // value (even an emptied field) always wins.
  const suggestedSiteUrl = useBrowserOrigin()
  const siteUrl =
    siteUrlDraft ?? (savedSettings?.siteUrl || suggestedSiteUrl)
  const siteDescription =
    siteDescriptionDraft ??
    (savedSettings
      ? readSiteDescription(savedSettings, savedSettings.defaultLocale)
      : undefined) ??
    ""
  const { timezone, locale: defaultLocale } = region
  // Terminal copy/paste can add a newline or surrounding spaces. The server
  // still compares the claim exactly; normalize only the transport boundary
  // so the value used for signup and the follow-up owner claim is identical.
  const submittedOwnerClaim = ownerClaim.trim()

  function goBack() {
    const idx = STEPS.indexOf(stepKey)
    if (idx <= 0) return
    if (STEPS[idx - 1] === "language") {
      setLanguageDone(false)
    } else {
      setStepOverride(STEPS[idx - 1] ?? null)
    }
    setError(null)
  }

  // Once the owner is signed in as admin, remember the language chosen in
  // step 1 as their admin language, but only when an admin dictionary exists.
  // A failure here must never block setup.
  // The ref holds the last locale saved, so going Back and choosing another
  // language saves the new one after the next Continue.
  const savedAdminLocaleRef = useRef<string | null>(null)
  useEffect(() => {
    if (!languageDone || !ownerRoleEstablished) return
    // Without an admin dictionary the admin stays in English, so a language
    // saved earlier in this session (for example French, before going Back)
    // is replaced with English, and so is a stored preference from before a
    // reload. Nothing is saved when the admin is already English.
    const storedNotEnglish =
      typeof storedAdminLocale === "string" && storedAdminLocale !== "en"
    const target = hasAdminDictionary(defaultLocale)
      ? defaultLocale
      : savedAdminLocaleRef.current !== null || storedNotEnglish
        ? "en"
        : null
    if (target === null || savedAdminLocaleRef.current === target) return
    savedAdminLocaleRef.current = target
    void Promise.resolve()
      .then(() => setAdminLocale({ locale: target }))
      .catch(() => {})
  }, [
    languageDone,
    ownerRoleEstablished,
    defaultLocale,
    storedAdminLocale,
    setAdminLocale,
  ])

  // ─── Step handlers ────────────────────────────────────────────────────────

  async function handleResumeSignIn() {
    setBusy(true)
    setError(null)
    try {
      const { error: authError } = await authClient.signIn.email({
        email,
        password,
      })
      if (authError) {
        setError(displayError(authError, t("errors.signIn")))
      }
    } catch {
      setError(t("errors.signIn"))
      setBusy(false)
      return
    }
    setBusy(false)
  }

  async function handleResumeSignOut() {
    setBusy(true)
    setError(null)
    try {
      await authClient.signOut()
      router.refresh()
    } catch {
      setError(t("errors.signOut"))
      setBusy(false)
      return
    }
    setBusy(false)
  }

  async function handleAccount() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const alreadyAdmin = session && ownerSession?.role === "admin"
      if (!alreadyAdmin && ownerClaimAvailability?.available !== true) {
        setError({ source: "claim" })
        setBusy(false)
        return
      }

      if (!session) {
        const { error: authError } = await authClient.signUp.email({
          name,
          email,
          password,
          fetchOptions: {
            headers: {
              [OWNER_CLAIM_HEADER]: submittedOwnerClaim,
            },
          },
        })
        if (authError) {
          // Account may already exist from an earlier abandoned run.
          const { error: signInError } = await authClient.signIn.email({
            email,
            password,
          })
          if (signInError) {
            let claimAvailable = false
            if (
              authError.status === 403 &&
              authError.code !== "USER_ALREADY_EXISTS"
            ) {
              try {
                // HTTP query performs a new read; ConvexReactClient.query may
                // return the pre-refusal subscribed availability value.
                const availability = await new ConvexHttpClient(convex.url).query(
                  api.cms.owner.getOwnerClaimAvailability,
                  {}
                )
                claimAvailable = availability.available
              } catch {
                // Without a fresh read, a typo is not established.
              }
            }
            setError({
              source: "signup",
              claimAvailable,
              status: authError.status,
              code: authError.code,
            })
            setBusy(false)
            return
          }
        }
      }

      if (!alreadyAdmin) {
        await waitForConvexAuthentication(
          () => convexAuthenticatedRef.current,
          t("errors.connectAccount")
        )
        const claimResult = replacingOwner
          ? await replaceOwner({ claim: submittedOwnerClaim })
          : await claimOwner({ claim: submittedOwnerClaim })
        if (claimResult.status !== "claimed") {
          setError({ source: "claim" })
          setBusy(false)
          return
        }
        setNotice(
          replacingOwner
            ? t("notices.ownerMoved", {
                email:
                  email || session?.user?.email || t("notices.thisAccount"),
              })
            : t("notices.ownerCreated", {
                email: email || t("notices.you"),
              })
        )
      }

      if (replacingOwner && progress?.finished) {
        setReplacingOwner(false)
        router.refresh()
        setBusy(false)
        return
      }
      if (replacingOwner) setReplacingOwner(false)
      setStepOverride("identity")
      setError(null)
      setBusy(false)
    } catch (e) {
      setError(displayError(e, t("errors.createAccount")))
      setBusy(false)
    }
  }

  async function handleIdentity() {
    setBusy(true)
    setError(null)
    try {
      await withRetryOnAuthLag(() =>
        bootstrapInstallation({
          siteName,
          siteUrl: siteUrl || undefined,
          siteDescription: siteDescription || undefined,
          timezone,
          defaultLocale,
        })
      )
      // A hard navigation: /setup and /admin share a layout that Next.js does
      // not re-render on client navigation, so only a full load picks up the
      // interface language saved during setup.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/admin")
      setBusy(false)
    } catch (e) {
      setError(displayError(e, t("errors.saveSite")))
      setBusy(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const stepIdx = STEPS.indexOf(stepKey)
  const currentLabel = t(`steps.${stepKey}`)
  const timezoneOptions = TIMEZONES.includes(timezone)
    ? TIMEZONES
    : [timezone, ...TIMEZONES]
  const localTime = useLocalTime(timezone, defaultLocale)

  const stepIndicator = (
    <div className="flex gap-1 pt-2" data-testid="step-indicator">
      {STEPS.map((step, i) => (
        <div
          key={step}
          className={`h-1 flex-1 rounded-full ${
            i <= stepIdx || stepDone(step) ? "bg-primary" : "bg-muted"
          }`}
          title={t(`steps.${step}`)}
        />
      ))}
    </div>
  )

  function stepDone(key: StepKey): boolean {
    if (key === "language") return languageDone
    if (!progress) return false
    return progress[key]
  }

  if (
    progress === undefined ||
    (!progress.account && ownerEstablished === undefined) ||
    (!ownerAccountExists && ownerClaimAvailability === undefined)
  ) {
    return (
      <Card className="w-full max-w-2xl" aria-live="polite">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("status.checkingTitle")}
          </CardTitle>
          <CardDescription>{t("status.checkingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Loader2
            className="animate-spin"
            aria-label={t("status.checkingLabel")}
          />
        </CardContent>
      </Card>
    )
  }

  const ownerReplacementAvailable =
    ownerEstablished?.established === true &&
    ownerClaimAvailability?.available === true

  if (onboardingFinished && !replacingOwner) {
    return (
      <Card className="w-full max-w-2xl" aria-live="polite">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("complete.title")}
          </CardTitle>
          <CardDescription>{t("complete.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild>
            <Link href="/admin">{t("actions.openAdmin")}</Link>
          </Button>
          {!ownerRoleEstablished && ownerReplacementAvailable && (
            <Button variant="outline" onClick={() => setReplacingOwner(true)}>
              {t("actions.replaceOwnerAccount")}
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  if (!languageDone && !replacingOwner) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("wizard.title")}
          </CardTitle>
          <CardDescription>
            {t("wizard.progress", {
              current: currentLabel,
              step: stepIdx + 1,
              total: STEPS.length,
            })}
          </CardDescription>
          {stepIndicator}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("language.description")}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="bootstrapDefaultLocale">
                {t("fields.siteLanguage")}
              </Label>
              <select
                id="bootstrapDefaultLocale"
                className={SELECT_CLASS}
                value={defaultLocale}
                onChange={(e) => region.setLocale(e.target.value)}
              >
                {SUPPORTED_LOCALES.map((code) => (
                  <option key={code} value={code}>
                    {getLocaleDisplayName(code)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {hasAdminDictionary(defaultLocale)
                  ? t("fields.siteLanguageHint")
                  : t("fields.siteLanguageHintOther")}
              </p>
              {!hasAdminDictionary(defaultLocale) && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="language-english-note"
                >
                  {t("fields.siteLanguageEnglishOnly")}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">{t("fields.timezone")}</Label>
              <select
                id="timezone"
                className={SELECT_CLASS}
                value={timezone}
                onChange={(e) => region.setTimezone(e.target.value)}
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              <p
                className="text-xs text-muted-foreground"
                data-testid="timezone-now"
              >
                {t("fields.timezoneNow", { timezone, time: localTime })}
                {timezone === region.detectedTimezone
                  ? ` ${t("fields.timezoneDetected")}`
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex justify-between pt-2">
            <Button variant="ghost" disabled>
              {t("actions.back")}
            </Button>
            <Button
              onClick={() => {
                // Lock in the values on screen so settings that load later
                // cannot replace them.
                region.setLocale(defaultLocale)
                region.setTimezone(timezone)
                setLanguageDone(true)
              }}
            >
              {t("actions.continue")}
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (ownerAccountExists && !session && !replacingOwner) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("resume.signInTitle")}
          </CardTitle>
          <CardDescription>{t("resume.signInDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="resumeEmail">{t("fields.email")}</Label>
            <Input
              id="resumeEmail"
              name="email"
              type="email"
              value={email}
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <PasswordField
            id="resumePassword"
            name="password"
            label={t("fields.accountPassword")}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            disabled={busy}
          />
          <div className="flex justify-between pt-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setLanguageDone(false)
                setError(null)
              }}
            >
              {t("actions.back")}
            </Button>
            <Button
              disabled={busy || !email.trim() || password.length < 8}
              onClick={() => void handleResumeSignIn()}
            >
              {busy && <Loader2 className="animate-spin" />}
              {t("actions.signInAndResume")}
            </Button>
          </div>
          {ownerReplacementAvailable && (
            <Button variant="outline" onClick={() => setReplacingOwner(true)}>
              {t("actions.replaceOwnerAccount")}
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  if (ownerAccountExists && session && !isConvexAuthenticated) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("resume.connectingTitle")}
          </CardTitle>
          <CardDescription>{t("resume.connectingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Loader2
            className="animate-spin"
            aria-label={t("resume.connectingLabel")}
          />
        </CardContent>
      </Card>
    )
  }

  if (
    ownerAccountExists &&
    session &&
    isConvexAuthenticated &&
    ownerSession === undefined
  ) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("resume.checkingAccessTitle")}
          </CardTitle>
          <CardDescription>
            {t("resume.checkingAccessDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Loader2
            className="animate-spin"
            aria-label={t("resume.checkingAccessLabel")}
          />
        </CardContent>
      </Card>
    )
  }

  if (
    ownerAccountExists &&
    session &&
    ownerSession !== undefined &&
    !ownerRoleEstablished &&
    !replacingOwner
  ) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("resume.wrongAccountTitle")}
          </CardTitle>
          <CardDescription>
            {t("resume.wrongAccountDescription", {
              email: session.user?.email ?? "",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void handleResumeSignOut()}
          >
            {busy && <Loader2 className="animate-spin" />}
            {t("actions.signOutAndRetry")}
          </Button>
          {ownerReplacementAvailable && (
            <Button variant="outline" onClick={() => setReplacingOwner(true)}>
              {t("actions.replaceOwnerAccount")}
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          {t("wizard.title")}
        </CardTitle>
        <CardDescription>
          {t("wizard.progress", {
            current: currentLabel,
            step: stepIdx + 1,
            total: STEPS.length,
          })}
        </CardDescription>
        {stepIndicator}
        {initialSetup && (
          <p className="pt-2 text-xs text-muted-foreground">
            {t("wizard.loadedHandoff")}
          </p>
        )}
        {hasResumeBanner && (
          <p className="pt-2 text-xs text-muted-foreground">
            {t.rich("wizard.resumeBanner", {
              step: () => <strong>{currentLabel}</strong>,
            })}
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p
            className="rounded-md border border-green-600/40 bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950/30 dark:text-green-200"
            role="status"
          >
            {notice}
          </p>
        )}

        {stepKey === "account" && (
          <div className="space-y-3">
            {session && ownerSession?.role === "admin" ? (
              <p className="text-sm text-muted-foreground">
                {t("account.signedInAs", {
                  email: session.user?.email ?? "",
                })}
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {replacingOwner
                    ? t("account.replaceDescription")
                    : t("account.createDescription")}
                </p>
                {ownerClaimAvailability?.available === false ? (
                  <OwnerCodeUnavailable target={ownerCodeTarget} />
                ) : (
                  <>
                    {!session && (
                      <>
                        <div className="space-y-1.5">
                          <Label htmlFor="name">{t("fields.name")}</Label>
                          <Input
                            id="name"
                            name="name"
                            value={name}
                            autoComplete="name"
                            disabled={busy}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="email">
                            {t("fields.signInEmail")}
                          </Label>
                          <Input
                            id="email"
                            name="email"
                            type="email"
                            value={email}
                            autoComplete="email"
                            inputMode="email"
                            spellCheck={false}
                            disabled={busy}
                            onChange={(e) => setEmail(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            {t("fields.signInEmailHint")}
                          </p>
                        </div>
                        <PasswordField
                          id="password"
                          label={t("fields.newPassword")}
                          value={password}
                          onChange={setPassword}
                          autoComplete="new-password"
                          disabled={busy}
                        >
                          <p className="text-xs text-muted-foreground">
                            {t("fields.newPasswordHint")}
                          </p>
                        </PasswordField>
                        <PasswordField
                          id="confirmPassword"
                          label={t("fields.confirmPassword")}
                          value={confirmPassword}
                          onChange={setConfirmPassword}
                          autoComplete="new-password"
                          disabled={busy}
                        >
                          {confirmPassword.length > 0 && !passwordsMatch && (
                            <p className="text-xs text-destructive" role="alert">
                              {t("fields.passwordsMismatch")}
                            </p>
                          )}
                        </PasswordField>
                      </>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="ownerClaim">
                        {t("fields.ownerCode")}
                      </Label>
                      <Input
                        id="ownerClaim"
                        name="ownerClaim"
                        type="password"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        disabled={busy}
                        value={ownerClaim}
                        onChange={(e) => setOwnerClaim(e.target.value)}
                      />
                    </div>
                    <RotateOwnerCodeHelp target={ownerCodeTarget} />
                  </>
                )}
              </>
            )}
          </div>
        )}

        {stepKey === "identity" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="siteName">{t("fields.siteName")}</Label>
              <Input
                id="siteName"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="siteUrl">{t("fields.siteUrl")}</Label>
              <Input
                id="siteUrl"
                placeholder={t("fields.siteUrlPlaceholder")}
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("fields.siteUrlHint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="siteDescription">
                {t("fields.siteDescription")}
              </Label>
              <Textarea
                id="siteDescription"
                value={siteDescription}
                onChange={(e) => setSiteDescription(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Action row */}
        <div className="flex justify-between pt-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={replacingOwner ? () => setReplacingOwner(false) : goBack}
          >
            {replacingOwner
              ? t("actions.cancel")
              : t("actions.back")}
          </Button>

          {stepKey === "account" && (
            <Button
              disabled={
                busy ||
                (Boolean(session) && ownerSession === undefined) ||
                (ownerSession?.role !== "admin" &&
                  (ownerClaimAvailability?.available !== true ||
                    !ownerClaim.trim())) ||
                (!session && (!name || !email || !passwordAcceptable))
              }
              onClick={() => void handleAccount()}
            >
              {busy && <Loader2 className="animate-spin" />}
              {replacingOwner
                ? session
                  ? t("actions.replaceOwner")
                  : t("actions.createReplacementAccount")
                : session
                  ? t("actions.continue")
                  : t("actions.createAccount")}
            </Button>
          )}

          {stepKey === "identity" && (
            <Button
              disabled={busy || !siteName.trim()}
              onClick={() => void handleIdentity()}
            >
              {busy && <Loader2 className="animate-spin" />}
              {t("actions.finishSetup")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
