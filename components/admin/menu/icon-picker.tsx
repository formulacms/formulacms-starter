"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MENU_ICON_DEFINITIONS } from "@/components/menu-icon-definitions";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

interface IconPickerProps {
  value?: string;
  onChange: (value: string | undefined) => void;
}

export function IconPicker({ value, onChange }: IconPickerProps) {
  const t = useTranslations("menus.iconPicker");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedIcon = value
    ? MENU_ICON_DEFINITIONS.find((icon) => icon.name === value)
    : undefined;
  const q = search.trim().toLowerCase();
  const filteredIcons = q
    ? MENU_ICON_DEFINITIONS.filter((icon) =>
        icon.name.toLowerCase().includes(q)
      )
    : MENU_ICON_DEFINITIONS;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-expanded={open}
          className="w-full justify-start gap-2"
        >
          {selectedIcon ? (
            <>
              <selectedIcon.component className="size-4" />
              <span>{value}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{t("select")}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchLabel")}
            className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[280px] overflow-y-auto p-1">
          <button
            type="button"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
            className="w-full rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
          >
            {t("none")}
          </button>
          <div className="grid grid-cols-6 gap-1 p-2">
            {filteredIcons.map((iconDef) => {
              const Icon = iconDef.component;
              return (
                <button
                  key={iconDef.name}
                  type="button"
                  onClick={() => {
                    onChange(iconDef.name);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex items-center justify-center rounded p-2 hover:bg-accent",
                    value === iconDef.name && "bg-accent"
                  )}
                  title={iconDef.name}
                  aria-label={iconDef.name}
                >
                  <Icon className="size-4" />
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
