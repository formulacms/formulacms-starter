"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useQuery } from "convex/react"
import { ConvexError } from "convex/values"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { z } from "zod"
import { useUsernamePasswordSignIn } from "@/lib/auth/client"
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
  username: string
  password: string
}

function SignInForm() {
  const t = useTranslations("auth.signIn")
  const router = useRouter()
  const searchParams = useSearchParams()
  // Username and password is the only sign-in method (ADR-0056). The call goes
  // through /auth/signin, which keeps the refresh token in an httpOnly cookie.
  const { signIn } = useUsernamePasswordSignIn()

  // No account can exist yet on a deployment nobody has claimed. A sign-in
  // there answers "wrong username or password", which is false in substance
  // and sends people hunting for a typo instead of finishing setup.
  const owner = useQuery(api.cms.owner.getOwnerEstablished, {})
  // Never let this panel be a dead end: whatever the signal says, one click
  // still reaches the credential form. Hiding the only way in on a single
  // boolean is a worse failure than the misleading error it replaces.
  const [forceForm, setForceForm] = useState(false)
  const noOwnerYet = owner?.established === false && !forceForm

  const signInSchema = z.object({
    username: z.string().trim().min(1, t("validation.usernameRequired")),
    password: z.string().min(1, t("validation.passwordRequired")),
  })

  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { username: "", password: "" },
  })
  // Anything the sign-in service says back is a form-level failure, not a
  // per-field one — `root` is where react-hook-form keeps those.
  const formError = form.formState.errors.root?.message
  const busy = form.formState.isSubmitting

  const handleSubmit = form.handleSubmit(async (values) => {
    const result = await signIn({
      username: values.username,
      password: values.password,
    })
    if (result.status === "complete") {
      router.replace(
        safeNextPath(searchParams.get("next"), window.location.origin)
      )
      router.refresh()
      return
    }
    // Never say whether the username exists: every credential failure gets
    // the same message.
    const { userError } = result
    form.setError("root", {
      message:
        userError.error === "RATE_LIMITED"
          ? t("errors.rateLimited", {
              seconds: Math.ceil(userError.retryAfterMs / 1000),
            })
          : userError.error !== "OTHER_ERROR"
            ? t("errors.invalidCredentials")
            : // A refusal from the deployment (for example a disabled account)
              // arrives as a ConvexError; anything else never reached it.
              userError.cause instanceof ConvexError
              ? t("errors.default")
              : t("errors.unreachable"),
    })
  })

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
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("form.usernameLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      autoComplete="username"
                      autoCapitalize="none"
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
            <Button type="submit" disabled={busy}>
              {form.formState.isSubmitting && (
                <Loader2 className="animate-spin" />
              )}
              {form.formState.isSubmitting
                ? t("form.signingIn")
                : t("form.submit")}
            </Button>
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
