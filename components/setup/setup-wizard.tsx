"use client"

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react"
import { ConvexHttpClient } from "convex/browser"
import { Loader2 } from "lucide-react"
import {
  NextIntlClientProvider,
  useTranslations,
  type AbstractIntlMessages,
} from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { api } from "@/convex/_generated/api"
import { useSignOut, useUsernamePasswordSignIn } from "@/lib/auth/client"
import { SUPPORTED_LOCALES, getLocaleDisplayName } from "@/lib/i18n/config"
import {
  hasAdminDictionary,
  type AdminDictionaryLocale,
} from "@/lib/i18n/admin-dictionaries"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { PasswordField } from "@/components/auth/password-field"
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

// ─── Step definitions ────────────────────────────────────────────────────────

// The multi-step onboarding form is deferred (01-foundation.md, onboarding
// scope decision 2026-09-13): setup is the owner account plus one atomic
// bootstrap. Email, AI and other languages are configured later in Settings.
// Language and region come first (owner, 2026-11-01): the rest of setup and
// the admin follow the choice. That step is client-only; it saves nothing.
type StepKey = "language" | "account" | "identity"

const STEPS: StepKey[] = ["language", "account", "identity"]

// Convex Auth password limits (ADR-0056): 10 to 100 characters.
const MIN_PASSWORD_LENGTH = 10

/**
 * Admin dictionaries the wizard can switch to, as `{ setup, caughtErrors }`
 * message blocks keyed by locale. Only these two namespaces are shipped to the
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
 * What to tell someone whose owner code was refused.
 *
 * The server cannot say. `createOwnerAccount` answers a single `unavailable`
 * for a wrong code, a consumed code and an unset code alike — deliberate, per
 * ADR-0007, so the response can't be used to probe the deployment.
 *
 * Only a refusal followed by a fresh, still-open public availability read
 * points to a typo (the reactive client's one-off query can reuse its
 * subscribed value, so the read goes over HTTP). Later consumption also
 * changes the rendered refusal.
 */
type AccountErrorKey = "errors.ownerCodeUnavailable" | "errors.ownerCodeMismatch"

type AccountErrorOptions = {
  claimAvailable?: boolean
}

function accountErrorMessage(
  options: AccountErrorOptions,
  translate: (key: AccountErrorKey) => string
): string {
  return options.claimAvailable === true
    ? translate("errors.ownerCodeMismatch")
    : translate("errors.ownerCodeUnavailable")
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
  /** Setup message blocks per admin dictionary; without them the wizard uses the surrounding provider. */
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
  const tErrors = useTranslations("caughtErrors")
  const convex = useConvex()
  const router = useRouter()
  // Convex Auth: the Convex client's own state is the session.
  const { isLoading: authLoading, isAuthenticated: isConvexAuthenticated } =
    useConvexAuth()
  const signedIn = isConvexAuthenticated
  const { signIn } = useUsernamePasswordSignIn()
  const signOut = useSignOut()
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
  const createOwnerAccount = useMutation(api.cms.owner.createOwnerAccount)
  const bootstrapInstallation = useMutation(
    api.cms.settings.bootstrapInstallation
  )

  // Step 1 is client-only and never blocks a resumed owner: it always shows
  // first, and bookmarks route only the steps after it.
  const [languageDone, setLanguageDone] = useState(false)
  // Bookmarks stamped by the retired language/AI steps do not route anywhere:
  // once an owner exists, the only remaining step is the bootstrap.
  const progressStepKey: StepKey = ownerAccountExists ? "identity" : "account"
  const [stepOverride, setStepOverride] = useState<StepKey | null>(null)
  const stepKey: StepKey = !languageDone
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
            t
          )
        : null
  // Claiming the owner role is the one irreversible step in the wizard, and it
  // used to pass silently — the step simply advanced. Say what happened.
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Account
  const [name, setName] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  // A refusal of the password itself shows under the password field.
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmPassword, setConfirmPassword] = useState("")
  const [notificationEmail, setNotificationEmail] = useState("")
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

  // Every `invalid_input` code from `createOwnerAccount` gets a message. A bad
  // notification email names that field; the two password refusals show under
  // the password field (handleAccount); the rest keep the general message.
  function createOwnerInputError(code: string): string {
    switch (code) {
      case "RATE_LIMITED":
        return t("errors.tooManyAttempts")
      case "EMAIL_INVALID":
        return tErrors("invalidEmail")
      default:
        return t("errors.createOwner")
    }
  }

  async function handleResumeSignIn() {
    setBusy(true)
    setError(null)
    const result = await signIn({ username: username.trim(), password })
    if (result.status !== "complete") {
      setError(
        result.userError.error === "RATE_LIMITED"
          ? t("errors.tooManyAttempts")
          : t("errors.signIn")
      )
    }
    setBusy(false)
  }

  async function handleResumeSignOut() {
    setBusy(true)
    setError(null)
    try {
      await signOut()
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
    setPasswordError(null)
    setNotice(null)
    try {
      const alreadyAdmin = signedIn && ownerSession?.role === "admin"
      if (!alreadyAdmin) {
        if (ownerClaimAvailability?.available !== true) {
          setError({})
          setBusy(false)
          return
        }
        // One transaction checks the owner code, creates the account and
        // binds it as the owner (ADR-0056 rule 1). Then the owner signs in
        // through the normal sign-in route.
        const accountUsername = username.trim()
        const created = await createOwnerAccount({
          code: submittedOwnerClaim,
          name: name.trim(),
          username: accountUsername,
          password,
          ...(notificationEmail.trim()
            ? { notificationEmail: notificationEmail.trim() }
            : {}),
        })
        if (created.status === "unavailable") {
          let claimAvailable = false
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
          setError({ claimAvailable })
          setBusy(false)
          return
        }
        if (created.status === "invalid_input") {
          if (created.error === "PASSWORD_TOO_COMMON") {
            setPasswordError(tErrors("passwordTooCommon"))
          } else if (
            created.error === "PASSWORD_HAS_SURROUNDING_WHITESPACE"
          ) {
            setPasswordError(tErrors("passwordSurroundingSpaces"))
          } else {
            setError(createOwnerInputError(created.error))
          }
          setBusy(false)
          return
        }
        const signInResult = await signIn({
          username: accountUsername,
          password,
        })
        if (signInResult.status !== "complete") {
          setError(t("errors.signIn"))
          setBusy(false)
          return
        }
        await waitForConvexAuthentication(
          () => convexAuthenticatedRef.current,
          t("errors.connectAccount")
        )
        setNotice(t("notices.ownerCreated", { username: accountUsername }))
      }

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

  if (onboardingFinished) {
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
        </CardContent>
      </Card>
    )
  }

  if (!languageDone) {
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

  // The Convex client is still reading the stored session.
  if (ownerAccountExists && authLoading) {
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

  if (ownerAccountExists && !signedIn) {
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
            <Label htmlFor="resumeUsername">{t("fields.username")}</Label>
            <Input
              id="resumeUsername"
              name="username"
              type="text"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setUsername(event.target.value)}
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
              disabled={
                busy ||
                !username.trim() ||
                password.length < MIN_PASSWORD_LENGTH
              }
              onClick={() => void handleResumeSignIn()}
            >
              {busy && <Loader2 className="animate-spin" />}
              {t("actions.signInAndResume")}
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (ownerAccountExists && signedIn && ownerSession === undefined) {
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
    signedIn &&
    ownerSession !== undefined &&
    !ownerRoleEstablished
  ) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("resume.wrongAccountTitle")}
          </CardTitle>
          <CardDescription>
            {t("resume.wrongAccountDescription")}
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
            {signedIn && ownerSession?.role === "admin" ? (
              <p className="text-sm text-muted-foreground">
                {t("account.signedInAs", {
                  name: ownerSession.displayName ?? "",
                })}
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("account.createDescription")}
                </p>
                {ownerClaimAvailability?.available === false ? (
                  <OwnerCodeUnavailable target={ownerCodeTarget} />
                ) : (
                  <>
                    {!signedIn && (
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
                          <Label htmlFor="username">
                            {t("fields.username")}
                          </Label>
                          <Input
                            id="username"
                            name="username"
                            type="text"
                            value={username}
                            autoComplete="username"
                            autoCapitalize="none"
                            spellCheck={false}
                            disabled={busy}
                            onChange={(e) => setUsername(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            {t("fields.usernameHint")}
                          </p>
                        </div>
                        <PasswordField
                          id="password"
                          label={t("fields.newPassword")}
                          value={password}
                          onChange={(value) => {
                            setPassword(value)
                            setPasswordError(null)
                          }}
                          autoComplete="new-password"
                          disabled={busy}
                        >
                          <p className="text-xs text-muted-foreground">
                            {t("fields.newPasswordHint")}
                          </p>
                          {passwordError && (
                            <p className="text-xs text-destructive" role="alert">
                              {passwordError}
                            </p>
                          )}
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
                        <div className="space-y-1.5">
                          <Label htmlFor="notificationEmail">
                            {t("fields.notificationEmail")}
                          </Label>
                          <Input
                            id="notificationEmail"
                            name="notificationEmail"
                            type="email"
                            value={notificationEmail}
                            autoComplete="email"
                            inputMode="email"
                            spellCheck={false}
                            disabled={busy}
                            onChange={(e) =>
                              setNotificationEmail(e.target.value)
                            }
                          />
                          <p className="text-xs text-muted-foreground">
                            {t("fields.notificationEmailHint")}
                          </p>
                        </div>
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
            onClick={goBack}
          >
            {t("actions.back")}
          </Button>

          {stepKey === "account" && (
            <Button
              disabled={
                busy ||
                (signedIn && ownerSession === undefined) ||
                (ownerSession?.role !== "admin" &&
                  (ownerClaimAvailability?.available !== true ||
                    !ownerClaim.trim())) ||
                (!signedIn && (!name || !username.trim() || !passwordAcceptable))
              }
              onClick={() => void handleAccount()}
            >
              {busy && <Loader2 className="animate-spin" />}
              {signedIn ? t("actions.continue") : t("actions.createAccount")}
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
