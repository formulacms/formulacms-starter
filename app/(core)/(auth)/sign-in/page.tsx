"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useQuery } from "convex/react"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { z } from "zod"
import { authClient } from "@/lib/auth-client"
import { api } from "@/convex/_generated/api"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { safeNextPath } from "./safe-next-path"

type SignInValues = {
  email: string
  password: string
}

function SignInForm() {
  const displayError = useCaughtError()
  const t = useTranslations("auth.signIn")
  const router = useRouter()
  const searchParams = useSearchParams()
  const justReset = searchParams.get("reset") === "ok"

  // Optional providers: render Google only when the deployment env is fully
  // configured. `undefined` while loading → hide; `false` → hide.
  const providers = useQuery(api.auth.getProvidersAvailable, {})
  const googleEnabled = providers?.google === true

  // No account can exist yet on a deployment nobody has claimed. Better Auth
  // answers "Invalid email or password" there, which is false in substance and
  // sends people hunting for a typo instead of finishing setup.
  const owner = useQuery(api.cms.owner.getOwnerEstablished, {})
  // Never let this panel be a dead end: whatever the signal says, one click
  // still reaches the credential form. Hiding the only way in on a single
  // boolean is a worse failure than the misleading error it replaces.
  const [forceForm, setForceForm] = useState(false)
  const noOwnerYet = owner?.established === false && !forceForm

  // Google is a second, non-form path to the same page, so it keeps its own
  // pending flag; the credential form's is `formState.isSubmitting`.
  const [googlePending, setGooglePending] = useState(false)

  const signInSchema = z.object({
    email: z
      .string()
      .trim()
      .min(1, t("validation.emailRequired"))
      .pipe(z.email(t("validation.emailInvalid"))),
    password: z.string().min(1, t("validation.passwordRequired")),
  })

  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  })
  // Anything the sign-in service says back is a form-level failure, not a
  // per-field one — `root` is where react-hook-form keeps those.
  const formError = form.formState.errors.root?.message
  const busy = form.formState.isSubmitting || googlePending

  const handleSubmit = form.handleSubmit(async (values) => {
    try {
      const { error: signInError } = await authClient.signIn.email({
        email: values.email,
        password: values.password,
      })
      if (signInError) {
        form.setError("root", {
          message: displayError(signInError, t("errors.default")),
        })
        return
      }
      router.replace(
        safeNextPath(searchParams.get("next"), window.location.origin)
      )
      router.refresh()
    } catch {
      form.setError("root", {
        message: t("errors.unreachable"),
      })
    }
  })

  async function handleGoogle() {
    setGooglePending(true)
    form.clearErrors("root")
    try {
      const { error: signInError } = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
      })
      if (signInError) {
        form.setError("root", {
          message: displayError(signInError, t("errors.googleDefault")),
        })
      }
    } catch {
      form.setError("root", {
        message: t("errors.googleUnreachable"),
      })
    }
    setGooglePending(false)
  }

  if (owner === undefined) {
    return (
      <Card className="w-full max-w-sm" aria-live="polite">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("checking.title")}
          </CardTitle>
          <CardDescription>{t("checking.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Loader2 className="animate-spin" aria-label={t("checking.label")} />
        </CardContent>
      </Card>
    )
  }

  if (noOwnerYet) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("unconfigured.title")}
          </CardTitle>
          <CardDescription>{t("unconfigured.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button asChild>
            <Link href="/setup">{t("unconfigured.setup")}</Link>
          </Button>
          <Button
            type="button"
            variant="link"
            onClick={() => setForceForm(true)}
          >
            {t("unconfigured.forceForm")}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          {t("form.title")}
        </CardTitle>
        <CardDescription>{t("form.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
            noValidate
          >
            {justReset && (
              <p
                className="rounded-md border border-green-600/40 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/30 dark:text-green-200"
                role="status"
              >
                {t("form.resetSuccess")}
              </p>
            )}
            {formError && (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {formError}
              </p>
            )}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("form.emailLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      spellCheck={false}
                      disabled={busy}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("form.passwordLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      disabled={busy}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end">
              <Link
                href="/forgot-password"
                className="text-xs text-muted-foreground underline underline-offset-4"
              >
                {t("form.forgotPassword")}
              </Link>
            </div>
            <Button type="submit" disabled={busy}>
              {form.formState.isSubmitting && (
                <Loader2 className="animate-spin" />
              )}
              {form.formState.isSubmitting
                ? t("form.signingIn")
                : t("form.submit")}
            </Button>
            {googleEnabled && (
              <>
                <div className="my-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <span>{t("form.divider")}</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleGoogle()}
                >
                  {googlePending && <Loader2 className="animate-spin" />}
                  {googlePending
                    ? t("form.googleConnecting")
                    : t("form.googleContinue")}
                </Button>
              </>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function SignInFallback() {
  const t = useTranslations("auth.signIn.loading")
  return (
    <Card className="w-full max-w-sm" aria-live="polite">
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Loader2 className="animate-spin" aria-label={t("label")} />
      </CardContent>
    </Card>
  )
}

export default function SignInPage() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      {/* useSearchParams requires a Suspense boundary in App Router. */}
      <Suspense fallback={<SignInFallback />}>
        <SignInForm />
      </Suspense>
    </div>
  )
}
