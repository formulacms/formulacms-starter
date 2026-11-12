import { Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  FieldLocaleActions,
  type FieldGenerate,
  type FieldTranslate,
} from "../../fields/field-editor"
import type { Slice } from "@/convex/lib/slices"
import type { Locale } from "@/lib/i18n/config"
import { hasAnyContent } from "../lib/content"

type SeoPanelProps = {
  currentLocale: Locale
  title: string
  slices: Slice[]
  metaTitle: string
  metaDescription: string
  seoNoIndex: boolean
  seoNoFollow: boolean
  seoOgTitle: string
  seoOgDescription: string
  seoOgImage: string
  canGenerate: boolean
  metaGenerationAvailable: boolean
  isGeneratingMeta: boolean
  fieldSourceMetaTitle: string
  fieldSourceMetaDescription: string
  fieldTranslate: FieldTranslate | undefined
  fieldGenerate: FieldGenerate | undefined
  onGenerateMeta(): void
  onMetaTitleChange(value: string): void
  onMetaDescriptionChange(value: string): void
  onSeoNoIndexChange(value: boolean): void
  onSeoNoFollowChange(value: boolean): void
  onSeoOgTitleChange(value: string): void
  onSeoOgDescriptionChange(value: string): void
  onSeoOgImageChange(value: string): void
}

export function SeoPanel({
  currentLocale,
  title,
  slices,
  metaTitle,
  metaDescription,
  seoNoIndex,
  seoNoFollow,
  seoOgTitle,
  seoOgDescription,
  seoOgImage,
  canGenerate,
  metaGenerationAvailable,
  isGeneratingMeta,
  fieldSourceMetaTitle,
  fieldSourceMetaDescription,
  fieldTranslate,
  fieldGenerate,
  onGenerateMeta,
  onMetaTitleChange,
  onMetaDescriptionChange,
  onSeoNoIndexChange,
  onSeoNoFollowChange,
  onSeoOgTitleChange,
  onSeoOgDescriptionChange,
  onSeoOgImageChange,
}: SeoPanelProps) {
  const t = useTranslations("editor.seo")

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("heading", { locale: currentLocale.toUpperCase() })}
        </h2>
        {canGenerate &&
          metaGenerationAvailable &&
          hasAnyContent(slices, title) && (
            <button
              type="button"
              disabled={isGeneratingMeta}
              onClick={onGenerateMeta}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles className="size-3.5" />
              {isGeneratingMeta ? t("generating") : t("generate")}
            </button>
          )}
      </div>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex min-h-5 items-center justify-between gap-2">
            <label htmlFor="page-meta-title" className="block text-sm font-medium">
              {t("metaTitle")}
            </label>
            <FieldLocaleActions
              label={t("metaTitle")}
              sourceValue={fieldSourceMetaTitle || undefined}
              currentValue={metaTitle}
              kind="text"
              translate={fieldTranslate}
              generate={fieldGenerate}
              onResult={onMetaTitleChange}
            />
          </div>
          <input
            id="page-meta-title"
            type="text"
            value={metaTitle}
            onChange={(e) => onMetaTitleChange(e.target.value)}
            maxLength={70}
            placeholder={title}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {metaTitle.length}/70
          </p>
        </div>
        <div>
          <div className="mb-1.5 flex min-h-5 items-center justify-between gap-2">
            <label
              htmlFor="page-meta-description"
              className="block text-sm font-medium"
            >
              {t("metaDescription")}
            </label>
            <FieldLocaleActions
              label={t("metaDescription")}
              sourceValue={fieldSourceMetaDescription || undefined}
              currentValue={metaDescription}
              kind="text"
              translate={fieldTranslate}
              generate={fieldGenerate}
              onResult={onMetaDescriptionChange}
            />
          </div>
          <textarea
            id="page-meta-description"
            value={metaDescription}
            onChange={(e) => onMetaDescriptionChange(e.target.value)}
            maxLength={160}
            rows={3}
            placeholder={t("metaDescriptionPlaceholder")}
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {metaDescription.length}/160
          </p>
        </div>
      </div>

      <div className="space-y-4 border-t pt-5">
        <h3 className="text-sm font-medium">
          {t("socialAndIndexing")}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            {t("sharedHint")}
          </span>
        </h3>
        <div>
          <label htmlFor="page-og-title" className="mb-1.5 block text-sm font-medium">
            {t("socialTitle")}
          </label>
          <input
            id="page-og-title"
            type="text"
            value={seoOgTitle}
            onChange={(e) => onSeoOgTitleChange(e.target.value)}
            placeholder={metaTitle || title}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
        </div>
        <div>
          <label
            htmlFor="page-og-description"
            className="mb-1.5 block text-sm font-medium"
          >
            {t("socialDescription")}
          </label>
          <textarea
            id="page-og-description"
            value={seoOgDescription}
            onChange={(e) => onSeoOgDescriptionChange(e.target.value)}
            rows={2}
            placeholder={metaDescription || t("socialDescriptionPlaceholder")}
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="page-og-image" className="mb-1.5 block text-sm font-medium">
            {t("socialImage")}
          </label>
          <input
            id="page-og-image"
            type="url"
            value={seoOgImage}
            onChange={(e) => onSeoOgImageChange(e.target.value)}
            placeholder={t("socialImagePlaceholder")}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
        </div>
        <div className="space-y-2 pt-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={seoNoIndex}
              onChange={(e) => onSeoNoIndexChange(e.target.checked)}
              className="size-4 rounded border"
            />
            <span>
              {t.rich("noIndex", {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={seoNoFollow}
              onChange={(e) => onSeoNoFollowChange(e.target.checked)}
              className="size-4 rounded border"
            />
            <span>
              {t.rich("noFollow", {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </span>
          </label>
        </div>
      </div>
    </div>
  )
}
