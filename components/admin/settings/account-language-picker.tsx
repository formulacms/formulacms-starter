"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "@/convex/_generated/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  currentLocale: string;
  localeOptions: Array<{ code: string; label: string }>;
}

export function AccountLanguagePicker({ currentLocale, localeOptions }: Props) {
  const router = useRouter();
  const t = useTranslations("settings.account");
  const [selected, setSelected] = useState(currentLocale);
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const setAdminLocale = useMutation(api.cms.userPreferences.setAdminLocale);

  async function handleApply() {
    if (selected === currentLocale) return;
    setIsSaving(true);
    try {
      await setAdminLocale({ locale: selected });
      startTransition(() => {
        router.refresh();
      });
    } catch {
      toast.error(t("updateFailed"));
      setIsSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Select value={selected} onValueChange={setSelected} disabled={isSaving || isPending}>
        <SelectTrigger className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {localeOptions.map(({ code, label }) => (
            <SelectItem key={code} value={code}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        onClick={handleApply}
        disabled={isSaving || isPending || selected === currentLocale}
      >
        {t("ok")}
      </Button>
    </div>
  );
}
