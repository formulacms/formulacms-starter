"use client"

import { useState } from "react"
import { useMutation } from "convex/react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { PasswordField } from "@/components/auth/password-field"
import { Button } from "@/components/ui/button"

const MIN_PASSWORD_LENGTH = 10

type ChangeResult = (typeof api.account.changeMyPassword)["_returnType"]

/** Settings > Account: the owner changes their own password (ADR-0056). */
export function ChangePassword() {
  const t = useTranslations("settings.account")
  const tSetup = useTranslations("setup.fields")
  const tErrors = useTranslations("caughtErrors")
  const tSignIn = useTranslations("auth.signIn.errors")
  const tCommon = useTranslations("common")
  const changeMyPassword = useMutation(api.account.changeMyPassword)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A refusal of the new password itself shows under that field.
  const [newPasswordError, setNewPasswordError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const passwordsMatch = next === confirm

  function errorFor(result: Exclude<ChangeResult, { status: "changed" }>) {
    switch (result.status) {
      case "wrong_password":
        return tErrors("invalidPassword")
      case "rate_limited":
        return tSignIn("rateLimited", {
          seconds: Math.ceil(result.retryAfterMs / 1000),
        })
      case "invalid_input":
        if (result.error === "PASSWORD_TOO_SHORT") {
          return tErrors("passwordTooShort")
        }
        if (result.error === "PASSWORD_TOO_LONG") {
          return tErrors("passwordTooLong")
        }
        return tCommon("error")
    }
  }

  async function handleChange() {
    setBusy(true)
    setError(null)
    setNewPasswordError(null)
    setNotice(null)
    try {
      const result = await changeMyPassword({
        currentPassword: current,
        newPassword: next,
      })
      if (result.status === "changed") {
        setNotice(t("passwordChanged"))
        setCurrent("")
        setNext("")
        setConfirm("")
      } else if (
        result.status === "invalid_input" &&
        result.error === "PASSWORD_TOO_COMMON"
      ) {
        setNewPasswordError(tErrors("passwordTooCommon"))
      } else if (
        result.status === "invalid_input" &&
        result.error === "PASSWORD_HAS_SURROUNDING_WHITESPACE"
      ) {
        setNewPasswordError(tErrors("passwordSurroundingSpaces"))
      } else {
        setError(errorFor(result))
      }
    } catch {
      setError(tCommon("error"))
    }
    setBusy(false)
  }

  return (
    <div>
      <h2 className="text-sm font-medium mb-3">{t("changePassword")}</h2>
      <div className="space-y-3">
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
        <PasswordField
          id="currentPassword"
          label={t("currentPassword")}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          disabled={busy}
        />
        <PasswordField
          id="newPassword"
          label={t("newPassword")}
          value={next}
          onChange={(value) => {
            setNext(value)
            setNewPasswordError(null)
          }}
          autoComplete="new-password"
          disabled={busy}
        >
          {newPasswordError && (
            <p className="text-xs text-destructive" role="alert">
              {newPasswordError}
            </p>
          )}
        </PasswordField>
        <PasswordField
          id="confirmNewPassword"
          label={t("confirmPassword")}
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          disabled={busy}
        >
          {confirm.length > 0 && !passwordsMatch && (
            <p className="text-xs text-destructive" role="alert">
              {tSetup("passwordsMismatch")}
            </p>
          )}
        </PasswordField>
        <div>
          <Button
            disabled={
              busy ||
              !current ||
              next.length < MIN_PASSWORD_LENGTH ||
              !passwordsMatch
            }
            onClick={() => void handleChange()}
          >
            {busy && <Loader2 className="animate-spin" />}
            {t("changePassword")}
          </Button>
        </div>
      </div>
    </div>
  )
}
