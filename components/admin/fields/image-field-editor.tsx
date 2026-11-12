"use client";

import { createContext, use, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ImagePlus, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { MediaPicker } from "../media-picker";
import { ImageTransformEditorDialog } from "../media-image-editor";
import { SliceImage } from "@/components/slices/render-helpers";
import type { ImageField } from "@/convex/lib/slices";

const ImageFieldLocaleContext = createContext<string | undefined>(undefined);

function imageFramingSummary(
  image: ImageField | undefined,
  labels: { cropped: string; focal: (position: string) => string },
): string[] {
  if (!image) return [];
  const details: string[] = [];
  if (image.cropSize) {
    details.push(`${image.cropSize.width}×${image.cropSize.height}`);
  } else if (image.crop && image.width && image.height) {
    details.push(
      `${Math.round((image.width * image.crop.width) / 100)}×${Math.round(
        (image.height * image.crop.height) / 100,
      )}`,
    );
  } else if (image.crop) {
    details.push(labels.cropped);
  }
  if (image.focal) {
    details.push(
      labels.focal(
        `${Math.round(image.focal.x)} / ${Math.round(image.focal.y)}`,
      ),
    );
  }
  return details;
}

function hasCustomFraming(image: ImageField | undefined): boolean {
  return Boolean(image?.crop || image?.cropSize || image?.focal);
}

export function ImageFieldLocaleProvider({
  locale,
  children,
}: {
  locale?: string;
  children: ReactNode;
}) {
  return (
    <ImageFieldLocaleContext.Provider value={locale}>
      {children}
    </ImageFieldLocaleContext.Provider>
  );
}

export function ImageFieldEditor({
  label,
  value,
  onChange,
  locale,
}: {
  label: string;
  value: ImageField | undefined;
  onChange: (image: ImageField | undefined) => void;
  locale?: string;
}) {
  const t = useTranslations("editor.imageField");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const contextLocale = use(ImageFieldLocaleContext);
  const effectiveLocale = locale ?? contextLocale;
  const framingSummary = imageFramingSummary(value, {
    cropped: t("cropped"),
    focal: (position) => t("focal", { position }),
  });

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">{label}</label>
      {value?.url ? (
        <div className="flex items-start gap-3">
          <div className="relative w-28 h-20 rounded-md border overflow-hidden bg-muted shrink-0">
            <SliceImage
              image={value}
              className="size-full object-cover"
              frame="cover"
              sizes="7rem"
            />
            <button
              type="button"
              onClick={() => onChange(undefined)}
              title={t("remove")}
              className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-white hover:bg-black/80 transition-colors"
            >
              <X className="size-3" />
            </button>
          </div>
          <div className="flex-1 space-y-1.5">
            <input
              type="text"
              value={value.alt ?? ""}
              onChange={(e) => onChange({ ...value, alt: e.target.value })}
              placeholder={t("altText")}
              aria-label={t("altText")}
              className="w-full px-3 py-1.5 text-sm rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setEditorOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent/50"
              >
                <SlidersHorizontal className="size-3" />
                {t("editFraming")}
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                {t("replace")}
              </button>
              {hasCustomFraming(value) && (
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...value,
                      crop: undefined,
                      cropSize: undefined,
                      focal: undefined,
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                >
                  <RotateCcw className="size-3" />
                  {t("resetFraming")}
                </button>
              )}
            </div>
            {framingSummary.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {framingSummary.map((item) => (
                  <span
                    key={item}
                    className="rounded border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-md border border-dashed text-sm text-muted-foreground hover:bg-accent/50 transition-colors w-full justify-center"
        >
          <ImagePlus className="size-4" />
          {t("choose")}
        </button>
      )}

      <MediaPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        locale={effectiveLocale}
        onSelect={(img) => onChange({ ...img, alt: value?.alt })}
      />
      <ImageTransformEditorDialog
        image={value}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onApply={onChange}
      />
    </div>
  );
}
