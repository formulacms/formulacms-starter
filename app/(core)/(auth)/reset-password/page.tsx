"use client"

import { Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { z } from "zod"
import { authClient } from "@/lib/auth-client"
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

type ResetPasswordValues = {
  password: string
  confirm: string
}

function ResetPasswordForm() {
  const t = useTranslations("auth.resetPassword")
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const errorParam = searchParams.get("error")

  const resetPasswordSchema = z
    .object({
      password: z.string().min(8, t("validation.passwordLength")),
      confirm: z.string().min(1, t("validation.confirmRequired")),
    })
    // The mismatch belongs on the field the reader would retype, not on the
    // form as a whole — otherwise the message sits away from the input at fault.
    .refine((values) => values.password === values.confirm, {
      path: ["confirm"],
      message: t("validation.passwordMismatch"),
    })

  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirm: "" },
  })
  const serverError = form.formState.errors.root?.message

  const handleSubmit = form.handleSubmit(async (values) => {
    const { error: resetError } = await authClient.resetPassword({
      newPassword: values.password,
      token,
    })
    if (resetError) {
      console.error("Reset password error:", resetError)
      form.setError("root", {
        message: t("errors.expired"),
      })
      return
    }
    // Intentionally do NOT auto-sign-in — forcing a fresh sign-in with the new
    // password matches the "no enumeration / neutral copy" posture and
    // ensures the user proves possession of the new credential.
    router.push("/sign-in?reset=ok")
  })

  // Better Auth redirects back here with `?error=INVALID_TOKEN` when the user
  // hits a stale link from the email. Token presence alone is the gate for
  // showing the form.
  if (!token || errorParam) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-xl font-semibold">{t("invalid.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("invalid.description")}
        </p>
        <p className="text-sm">
          <Link href="/forgot-password" className="underline">
            {t("requestNewLink")}
          </Link>
        </p>
      </div>
    )
  }

  return (
    <Form {...form}>
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4"
        noValidate
      >
        <h1 className="text-xl font-semibold">{t("form.title")}</h1>
        {serverError && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
            <Link href="/forgot-password" className="text-sm underline">
              {t("requestNewLink")}
            </Link>
          </div>
        )}
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("form.passwordLabel")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder={t("form.passwordPlaceholder")}
                  autoComplete="new-password"
                  disabled={form.formState.isSubmitting}
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
              <FormLabel>{t("form.confirmLabel")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder={t("form.confirmPlaceholder")}
                  autoComplete="new-password"
                  disabled={form.formState.isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting
            ? t("form.updating")
            : t("form.updatePassword")}
        </Button>
      </form>
    </Form>
  )
}

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      {/* useSearchParams requires a Suspense boundary in App Router. */}
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </div>
  )
}
