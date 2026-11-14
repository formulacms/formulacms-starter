"use client"

import { useState, type ReactNode } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// Shared by the setup wizard and Settings > Account. The show/hide labels live
// in `setup.fields`, which both screens load.

/** Password input with a show/hide eye button inside it. */
export function PasswordField({
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
