"use client"

import { useState } from "react"
import Link from "next/link"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { z } from "zod"
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

type ForgotPasswordValues = {
  email: string
}

export default function ForgotPasswordPage() {
  const t = useTranslations("auth.forgotPassword")
  const [submitted, setSubmitted] = useState(false)

  const forgotPasswordSchema = z.object({
    email: z
      .string()
      .trim()
      .min(1, t("validation.emailRequired"))
      .pipe(z.email(t("validation.emailInvalid"))),
  })

  const form = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  })

  const handleSubmit = form.handleSubmit(async (values) => {
    // The Convex action never throws and always returns { ok: true } — even
    // on rate-limit or unknown email — so we show the same neutral confirmation
    // regardless. Any thrown error here is a transport-level failure; we still
    // flip to the success state to avoid leaking whether the email exists.
    try {
      await fetch("/api/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: values.email.trim() }),
      })
    } catch (err) {
      console.error("[forgot-password] request failed:", err)
    }
    setSubmitted(true)
  })

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        {submitted ? (
          <>
            <p className="text-sm text-muted-foreground">{t("confirmation")}</p>
            <p className="text-sm">
              <Link href="/sign-in" className="underline">
                {t("backToSignIn")}
              </Link>
            </p>
          </>
        ) : (
          <Form {...form}>
            <form
              onSubmit={handleSubmit}
              className="flex flex-col gap-4"
              noValidate
            >
              <p className="text-sm text-muted-foreground">
                {t("instructions")}
              </p>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("emailLabel")}</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder={t("emailPlaceholder")}
                        autoComplete="email"
                        inputMode="email"
                        spellCheck={false}
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
                  ? t("sending")
                  : t("sendResetLink")}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                {t("remembered")}{" "}
                <Link href="/sign-in" className="underline">
                  {t("signIn")}
                </Link>
              </p>
            </form>
          </Form>
        )}
      </div>
    </div>
  )
}
