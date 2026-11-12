"use client";

import { createContext, use, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** One picker entry. `label` is what's shown; clicking it overwrites the
 *  dialog's input with `body` so the user can edit before submit. */
export interface PromptPreset {
  label: string;
  body: string;
}

type PickerPreset = PromptPreset & {
  pickerId: string;
};

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

type PromptOptions = {
  title: string;
  description?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  /** Allow submitting an empty value (e.g. to clear a link). Default false. */
  allowEmpty?: boolean;
  /** Multi-line input. Renders a textarea instead of an Input. */
  multiline?: boolean;
  /** Curated picker shown above the input. Click an entry to overwrite the
   *  input with its body; user can edit before submit. */
  presets?: PromptPreset[];
  /** `dropdown` for longer briefs, `chips` for short refine instructions.
   *  Default `chips`. */
  presetsVariant?: "dropdown" | "chips";
  /** Heading shown above the picker. Defaults to "Presets". */
  presetsLabel?: string;
};

type PendingPromptOptions = Omit<PromptOptions, "presets"> & {
  presets?: PickerPreset[];
};

type Pending =
  | { mode: "confirm"; options: ConfirmOptions }
  | { mode: "prompt"; options: PendingPromptOptions };

const ConfirmContext = createContext<{
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
} | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  /** Client-only identity of the preset that produced the current `value`, or
   *  null when the user has hand-typed/edited since. Labels are editorial and
   *  may be duplicated, so they cannot identify the active picker row. */
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  // Holds the resolver for the currently-open dialog. Set to null the moment a
  // result is delivered so a dismissal (Escape/overlay/X) can't resolve twice.
  const resolverRef = useRef<((result: boolean | string | null) => void) | null>(
    null,
  );
  /** Pointer to the dialog's input/textarea so a preset click can autoselect
   *  the first `{placeholder}` token in the just-filled body. */
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  function settle(result: boolean | string | null) {
    resolverRef.current?.(result);
    resolverRef.current = null;
  }

  function confirm(options: ConfirmOptions) {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = (r) => resolve(r as boolean);
      setValue("");
      setActivePresetId(null);
      setPending({ mode: "confirm", options });
    });
  }

  function prompt(options: PromptOptions) {
    return new Promise<string | null>((resolve) => {
      resolverRef.current = (r) => resolve(r as string | null);
      setValue(options.defaultValue ?? "");
      setActivePresetId(null);
      setPending({
        mode: "prompt",
        options: {
          ...options,
          presets: options.presets?.map((preset) => ({
            ...preset,
            pickerId: crypto.randomUUID(),
          })),
        },
      });
    });
  }

  /** Apply a preset: fill the input with its body, mark it active, and if the
   *  body contains a `{placeholder}` token, select that range so the user can
   *  start typing the replacement immediately. Runs in a microtask so the new
   *  value has flushed to the DOM before we touch the selection range. */
  function pickPreset(preset: PickerPreset) {
    setValue(preset.body);
    setActivePresetId(preset.pickerId);
    queueMicrotask(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const m = preset.body.match(/\{[^}]+\}/);
      if (m && m.index !== undefined) {
        el.setSelectionRange(m.index, m.index + m[0].length);
      } else {
        el.setSelectionRange(preset.body.length, preset.body.length);
      }
    });
  }

  function onInputChange(next: string) {
    setValue(next);
    if (activePresetId !== null) setActivePresetId(null);
  }

  // Any close that isn't an explicit confirm resolves with the cancel value.
  // Covers Escape, overlay click, and the X button — without this the caller's
  // awaited promise would hang forever.
  function handleOpenChange(open: boolean) {
    if (open) return;
    settle(pending?.mode === "prompt" ? null : false);
    setPending(null);
  }

  function onConfirm() {
    if (!pending) return;
    if (pending.mode === "prompt") {
      const trimmed = value.trim();
      if (!trimmed && !pending.options.allowEmpty) return;
      settle(trimmed);
    } else {
      settle(true);
    }
    setPending(null);
  }

  const isPrompt = pending?.mode === "prompt";
  const opts = pending?.options;
  const trimmed = value.trim();
  const submitDisabled =
    isPrompt && !trimmed && !(opts as PromptOptions | undefined)?.allowEmpty;

  return (
    <ConfirmContext.Provider value={{ confirm, prompt }}>
      {children}
      <Dialog open={pending !== null} onOpenChange={handleOpenChange}>
        {pending && opts && (
          <DialogContent
            showCloseButton={false}
            className="sm:max-w-sm"
            // When a description is present Radix auto-wires aria-describedby to
            // it; when absent, set it to undefined explicitly so Radix doesn't
            // warn about a missing description (the title is sufficient).
            {...(opts.description ? {} : { "aria-describedby": undefined })}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onConfirm();
              }}
            >
              <DialogHeader>
                <DialogTitle>{opts.title}</DialogTitle>
                {opts.description && (
                  <DialogDescription className="whitespace-pre-line">
                    {opts.description}
                  </DialogDescription>
                )}
              </DialogHeader>

              {isPrompt && (
                <div className="mt-4 space-y-3">
                  {(opts as PendingPromptOptions).presets &&
                    ((opts as PendingPromptOptions).presets?.length ?? 0) >
                      0 && (
                      <PresetsPicker
                        presets={(opts as PendingPromptOptions).presets!}
                        variant={
                          (opts as PromptOptions).presetsVariant ?? "chips"
                        }
                        label={(opts as PromptOptions).presetsLabel ?? t("presets")}
                        activePresetId={activePresetId}
                        onPick={pickPreset}
                      />
                    )}
                  <div className="space-y-1.5">
                    {(opts as PromptOptions).label && (
                      <Label htmlFor="confirm-prompt-input">
                        {(opts as PromptOptions).label}
                      </Label>
                    )}
                    {(opts as PromptOptions).multiline ? (
                      <Textarea
                        id="confirm-prompt-input"
                        // Input inside a just-opened modal prompt dialog;
                        // moving focus here on open is the expected dialog
                        // UX.
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        rows={4}
                        value={value}
                        placeholder={(opts as PromptOptions).placeholder}
                        onChange={(e) => onInputChange(e.target.value)}
                        ref={(el) => {
                          inputRef.current = el;
                        }}
                      />
                    ) : (
                      <Input
                        id="confirm-prompt-input"
                        // Input inside a just-opened modal prompt dialog;
                        // moving focus here on open is the expected dialog
                        // UX.
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        value={value}
                        placeholder={(opts as PromptOptions).placeholder}
                        onChange={(e) => onInputChange(e.target.value)}
                        ref={(el) => {
                          inputRef.current = el;
                        }}
                      />
                    )}
                  </div>
                </div>
              )}

              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  {opts.cancelText ?? t("cancel")}
                </Button>
                <Button
                  type="submit"
                  variant={
                    !isPrompt && (opts as ConfirmOptions).destructive
                      ? "destructive"
                      : "default"
                  }
                  disabled={submitDisabled}
                >
                  {opts.confirmText ?? (isPrompt ? t("save") : t("confirm"))}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Picker rendered above the prompt input. Two shapes:
 *   - `dropdown`: Popover combobox showing label + a one-line body excerpt;
 *     right for longer brief seeds where the label alone isn't enough to
 *     choose, and matches the rest of the admin chrome (same pattern as the
 *     Model picker in AI settings).
 *   - `chips`: buttons in a row; right for short refine instructions where the
 *     label and the body are basically the same length. The `body` shows as a
 *     tooltip on hover.
 *
 * `activePresetId` is the client-only identity most recently picked (or `null`
 * once the user edits the input); it drives the visual "active" state without
 * requiring editorial labels to be unique. */
function PresetsPicker({
  presets,
  variant,
  label,
  activePresetId,
  onPick,
}: {
  presets: PickerPreset[];
  variant: "dropdown" | "chips";
  label: string;
  activePresetId: string | null;
  onPick: (preset: PickerPreset) => void;
}) {
  if (variant === "dropdown") {
    return (
      <PresetDropdown
        presets={presets}
        label={label}
        activePresetId={activePresetId}
        onPick={onPick}
      />
    );
  }
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => {
          const isActive = p.pickerId === activePresetId;
          return (
            <button
              key={p.pickerId}
              type="button"
              title={p.body}
              onClick={() => onPick(p)}
              aria-pressed={isActive}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                isActive
                  ? "border-primary bg-primary/10 text-primary hover:bg-primary/15"
                  : "bg-muted/50 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PresetDropdown({
  presets,
  label,
  activePresetId,
  onPick,
}: {
  presets: PickerPreset[];
  label: string;
  activePresetId: string | null;
  onPick: (preset: PickerPreset) => void;
}) {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const activePreset = presets.find((p) => p.pickerId === activePresetId);
  const display = activePreset?.label ?? t("pickStartingBrief");
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            className="w-full justify-between font-normal"
          >
            <span
              className={cn(
                "truncate",
                !activePreset && "text-muted-foreground",
              )}
            >
              {display}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          id={listboxId}
          className="w-[var(--radix-popover-trigger-width)] p-1"
          align="start"
        >
          <div className="max-h-72 overflow-auto">
            {presets.map((p) => {
              const isActive = p.pickerId === activePresetId;
              return (
                <button
                  key={p.pickerId}
                  type="button"
                  onClick={() => {
                    onPick(p);
                    setOpen(false);
                  }}
                  aria-pressed={isActive}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                >
                  <Check
                    className={cn(
                      "size-4 shrink-0 mt-0.5",
                      isActive ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{p.label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {p.body}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function useConfirm() {
  const ctx = use(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx.confirm;
}

export function usePrompt() {
  const ctx = use(ConfirmContext);
  if (!ctx) throw new Error("usePrompt must be used within ConfirmProvider");
  return ctx.prompt;
}
