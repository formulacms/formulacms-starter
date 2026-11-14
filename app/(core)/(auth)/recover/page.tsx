"use client"

// Owner recovery by one-time link (ADR-0056 rule 4). The owner runs the
// recovery command in a terminal; it prints /recover?token=…. This page claims
// the link with a NEW username and password, then signs the new account in.
import { Suspense, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useMutation, useQuery } from "convex/react"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { z } from "zod"
import { api } from "@/convex/_generated/api"
import { useUsernamePasswordSignIn } from "@/lib/auth/client"
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

const MIN_PASSWORD_LENGTH = 10

// Library codes from the sign-up (Convex Auth username-password) with a
// message of their own, and the field each one belongs to.
const INPUT_MESSAGES: Record<
  string,
  {
    field: "username" | "password"
    key:
      | "passwordLength"
      | "passwordTooLong"
      | "passwordTooCommon"
      | "passwordSurroundingSpaces"
      | "usernameTaken"
  }
> = {
  PASSWORD_TOO_SHORT: { field: "password", key: "passwordLength" },
  PASSWORD_TOO_LONG: { field: "password", key: "passwordTooLong" },
  PASSWORD_TOO_COMMON: { field: "password", key: "passwordTooCommon" },
  PASSWORD_HAS_SURROUNDING_WHITESPACE: {
    field: "password",
    key: "passwordSurroundingSpaces",
  },
  USERNAME_TAKEN: { field: "username", key: "usernameTaken" },
}

type RecoverValues = {
  username: string
  password: string
  confirm: string
}

function RecoverExpired() {
  const t = useTranslations("auth.recover")
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          {t("title")}
        </CardTitle>
        <CardDescription>{t("expired")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          href="/sign-in"
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          {t("backToSignIn")}
        </Link>
      </CardContent>
    </Card>
  )
}

function RecoverForm({ token }: { token: string }) {
  const t = useTranslations("auth.recover")
  const tSignIn = useTranslations("auth.signIn")
  const tSetup = useTranslations("setup")
  const tErrors = useTranslations("caughtErrors")
  const router = useRouter()
  const claimRecoveryLink = useMutation(api.cms.recovery.claimRecoveryLink)
  const { signIn } = useUsernamePasswordSignIn()
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const [linkClosed, setLinkClosed] = useState(false)

  const recoverSchema = z
    .object({
      username: z
        .string()
        .trim()
        .min(1, tSignIn("validation.usernameRequired")),
      password: z
        .string()
        .min(MIN_PASSWORD_LENGTH, t("validation.passwordLength")),
      confirm: z.string().min(1, t("validation.confirmRequired")),
    })
    .refine((values) => values.password === values.confirm, {
      path: ["confirm"],
      message: tSetup("fields.passwordsMismatch"),
    })

  const form = useForm<RecoverValues>({
    resolver: zodResolver(recoverSchema),
    defaultValues: { username: "", password: "", confirm: "" },
  })
  const busy = form.formState.isSubmitting

  const handleSubmit = form.handleSubmit(async (values) => {
    // zod already trimmed the username.
    const username = values.username
    let result: Awaited<ReturnType<typeof claimRecoveryLink>>
    try {
      result = await claimRecoveryLink({
        token,
        username,
        password: values.password,
      })
    } catch {
      form.setError("username", { message: tSetup("errors.createOwner") })
      return
    }
    if (result.status === "claimed") {
      // The claim ends the session it created; sign the new account in so
      // "Open admin" lands in the admin. `signIn` returns failures instead of
      // throwing; a failed sign-in still reaches the sign-in page from there.
      await signIn({ username, password: values.password })
      setMovedTo(username)
      return
    }
    if (result.status === "invalid_input") {
      const message = INPUT_MESSAGES[result.error]
      if (message) {
        form.setError(message.field, {
          message:
            message.key === "passwordLength"
              ? t("validation.passwordLength")
              : tErrors(message.key),
        })
      } else {
        // Codes without their own message: password codes on the password
        // field, username codes (invalid characters, length) on the username.
        form.setError(
          result.error.startsWith("PASSWORD_") ? "password" : "username",
          { message: tSetup("errors.createOwner") }
        )
      }
      return
    }
    // RECOVERY_INVALID, RECOVERY_USED, RECOVERY_EXPIRED
    setLinkClosed(true)
  })

  if (linkClosed) return <RecoverExpired />

  if (movedTo !== null) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {t("title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p
            className="rounded-md border border-green-600/40 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/30 dark:text-green-200"
            role="status"
          >
            {t("success", { username: movedTo })}
          </p>
          <Button
            type="button"
            onClick={() => {
              router.replace("/admin")
              router.refresh()
            }}
          >
            {tSetup("actions.openAdmin")}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("usernameLabel")}</FormLabel>
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
                  <FormLabel>{t("passwordLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
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
              name="confirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("confirmLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      disabled={busy}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {t("submit")}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function RecoverContent() {
  const token = useSearchParams().get("token")
  // The page reads its clock once, at load (a lazy initial state keeps the
  // render pure).
  const [loadedAt] = useState(() => Date.now())
  // The link check decides only the first screen. A successful claim closes
  // the link while the form is still finishing, so keep the first answer and
  // stop listening; after that only the submit result changes the screen.
  const [firstScreen, setFirstScreen] = useState<"form" | "expired" | null>(
    null
  )
  const linkState = useQuery(
    api.cms.recovery.recoveryLinkState,
    token && firstScreen === null ? { token } : "skip"
  )
  if (firstScreen === null && linkState !== undefined) {
    setFirstScreen(
      linkState.status === "open" && linkState.expiresAt > loadedAt
        ? "form"
        : "expired"
    )
  }

  if (!token || firstScreen === "expired") return <RecoverExpired />
  // While the check loads, show nothing, so the form never flashes.
  if (firstScreen === null) return null
  return <RecoverForm token={token} />
}

export default function RecoverPage() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      {/* useSearchParams requires a Suspense boundary in App Router. */}
      <Suspense>
        <RecoverContent />
      </Suspense>
    </div>
  )
}
