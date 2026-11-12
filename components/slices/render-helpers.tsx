import Link from "next/link"
import { getImageProps } from "next/image"
import { imagePresentation, type ImageFrame } from "@/lib/media/image-presentation"
import {
  CloudUpload,
  Database,
  Gauge,
  GitBranch,
  Globe,
  Lock,
  RefreshCw,
  Rocket,
  Server,
  Settings,
  Shield,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import type { ImageField, ButtonField, CMSLinkField } from "@/convex/lib/slices"
import type { SliceIconName } from "@/lib/slices/icon-names"
import {
  composeRel,
  linkToHref,
  type SliceRenderContext,
} from "@/lib/slices/links"
export { RichTextContent } from "./rich-text-content"

/**
 * Curated lucide icon set a slice may pick from via a `select` field. Kept
 * small and stable: the slice-author agent emits these exact names as enum
 * options, and `SliceIcon` maps a stored value to the icon. Extend in review,
 * never with arbitrary names — an unknown value renders nothing.
 *
 * The name list itself lives in `lib/slices/icon-names.ts` (the scaffolder and
 * both authoring prompts read it too); `satisfies` below makes `tsc` enforce
 * that this map covers exactly that list.
 */
const SLICE_ICONS = {
  CloudUpload,
  Lock,
  Server,
  Database,
  Shield,
  Zap,
  Rocket,
  Globe,
  Gauge,
  RefreshCw,
  GitBranch,
  Settings,
} satisfies Record<SliceIconName, LucideIcon>

/** Render a curated lucide icon by name, or nothing for an unknown/empty value. */
export function SliceIcon({
  name,
  className,
}: {
  name: string | undefined
  className?: string
}) {
  const Icon = name ? SLICE_ICONS[name as SliceIconName] : undefined
  if (!Icon) return null
  return <Icon aria-hidden className={className} />
}

/** Map a slice button variant to a shadcn Button variant. */
const VARIANT_MAP: Record<
  NonNullable<ButtonField["variant"]>,
  "default" | "secondary" | "outline" | "ghost" | "link"
> = {
  primary: "default",
  secondary: "secondary",
  outline: "outline",
  ghost: "ghost",
  link: "link",
}

/**
 * The reusable "bleed" preset for product-screenshot layouts (an image that
 * sits in a grid cell but renders wider than it, overflowing toward the edge).
 * Encapsulates the non-arbitrary parts so renderers stop re-inventing them with
 * raw values: `max-w-none` frees the image from the cell width, the ring uses
 * the `foreground` token (not a hardcoded `ring-white/10`) so it adapts to the
 * surface. Renderers should prefer the `bleed` preset plus standard width
 * utilities instead of reintroducing one-off responsive widths.
 */
const SLICE_IMAGE_BLEED =
  "max-w-none rounded-xl shadow-xl ring-1 ring-foreground/10"

/** Render an imageField to a plain <img>, or nothing when absent/disabled. */
export function SliceImage({
  image,
  className,
  altFallback,
  decorative = false,
  fill = false,
  frame = "aspect",
  bleed = false,
  priority = false,
  sizes,
  fieldPath,
  ctx,
}: {
  image: ImageField | undefined
  className?: string
  /** Meaningful fallback for content images when the stored alt is blank. */
  altFallback?: string
  /** Use empty alt for decorative/redundant images such as button icons. */
  decorative?: boolean
  fill?: boolean
  /** Cover a definite renderer-owned box without changing its dimensions. */
  frame?: ImageFrame
  /** Apply the wide product-screenshot bleed preset ({@link SLICE_IMAGE_BLEED}). */
  bleed?: boolean
  priority?: boolean
  /** Responsive source-size hint forwarded to every Next Image branch. */
  sizes?: string
  /** Descriptor path supplied by the kit for exact authenticated preview selection. */
  fieldPath?: string
  /** Absent from public rendering; only the authenticated canvas stamps field identity. */
  ctx?: SliceRenderContext
}) {
  if (!image?.url) return null
  const alt = decorative ? "" : image.alt?.trim() || altFallback?.trim() || ""
  const presentation = imagePresentation(image, fill, frame)
  const imageLoading = priority ? "eager" : undefined
  const fetchPriority = priority ? "high" : undefined
  const optimized =
    presentation.intrinsic || presentation.optimizedFill
      ? getImageProps({
          src: image.url,
          alt,
          ...(presentation.optimizedFill
            ? { fill: true }
            : presentation.intrinsic!),
          sizes: presentation.optimizedFill ? (sizes ?? "100vw") : sizes,
          loading: imageLoading,
          fetchPriority,
        }).props
      : null
  // Next supplies inline fill/transparent-alt styles even without a style prop.
  // Keep its documented optimizer attributes; geometry belongs to our classes.
  const { style: omittedStyle, ...imageProps } = optimized ?? {
    src: image.url,
    alt,
    loading: imageLoading,
    fetchPriority,
    style: undefined,
  }
  void omittedStyle
  const imageElement = (
    // getImageProps retains Next optimization without an Image browser island.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...imageProps}
      alt={alt}
      className={cn(
        !optimized && !presentation.wrapped && "h-auto max-w-full",
        presentation.optimizedFill && "absolute inset-0 size-full",
        !presentation.wrapped && bleed && SLICE_IMAGE_BLEED,
        !presentation.wrapped && className,
        !presentation.wrapped && frame === "cover" && "size-full object-cover",
        presentation.imageClass
      )}
    />
  )
  const imageHost = presentation.wrapped ? (
    <span
      className={cn(
        "relative inline-block overflow-hidden align-middle",
        (fill || frame === "cover") && "block",
        bleed && SLICE_IMAGE_BLEED,
        className,
        presentation.wrapperClass
      )}
    >
      {presentation.cropWindowClass ? (
        <span className={presentation.cropWindowClass}>{imageElement}</span>
      ) : (
        imageElement
      )}
    </span>
  ) : (
    imageElement
  )
  const markedImageHost =
    fieldPath && ctx?.previewField
      ? ctx.previewField({ fieldPath, kind: "image", rendered: imageHost })
      : imageHost
  return presentation.css ? (
    <>
      <style>{presentation.css}</style>
      {markedImageHost}
    </>
  ) : (
    markedImageHost
  )
}

/**
 * On-brand color overrides per shadcn variant, for buttons that sit on an
 * inverted `bg-brand` surface (e.g. the CTA band). Appended after the base
 * variant classes so `cn`/tailwind-merge drops the conflicting `bg-*`/`text-*`
 * utilities and keeps these. Binds only to ADR-0020 brand tokens — the exact
 * hue still comes from the per-site design system.
 */
const ON_BRAND_VARIANT: Record<
  "default" | "secondary" | "outline" | "ghost" | "link",
  string
> = {
  default: "bg-brand-foreground text-brand hover:bg-brand-foreground/90",
  secondary:
    "bg-brand-foreground/15 text-brand-foreground hover:bg-brand-foreground/25",
  outline:
    "border-brand-foreground/40 bg-transparent text-brand-foreground hover:bg-brand-foreground/10",
  ghost: "text-brand-foreground hover:bg-brand-foreground/10",
  link: "text-brand-foreground",
}

function buttonRenderEntries(
  items: ButtonField[] | undefined,
  ctx: SliceRenderContext
) {
  const buttons = items ?? []
  const idCounts = new Map<string, number>()
  for (const button of buttons) {
    const id = button.id?.trim()
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }

  return buttons.flatMap((button, sourceIndex) => {
    if (button.enabled === false) return []
    const linkAttrs = sliceLinkAttrs(button.link, ctx)
    if (!linkAttrs) return []
    const id = button.id?.trim()
    const key = !id
      ? JSON.stringify(["missing-id", sourceIndex])
      : idCounts.get(id) === 1
        ? JSON.stringify(["id", id])
        : JSON.stringify(["duplicate-id", id, sourceIndex])
    return [{ button, key, linkAttrs, sourceIndex }]
  })
}

/**
 * Every attribute a slice `link()` field contributes to an anchor: the resolved
 * href plus the `download` / `target` / `rel` trio the primitive's contract
 * implies (`openInNewTab` implies `rel="noopener noreferrer"`; the SEO/trust
 * flags compose on top; `type: "media"` downloads rather than navigates).
 *
 * Returns `null` when the field resolves to no href, so callers can omit the
 * action instead of presenting a styled non-interactive control. Spread the
 * rest straight onto `<Link>`:
 *
 *   const cta = sliceLinkAttrs(tier.ctaLink, ctx)
 *   cta && <Link {...cta} className={…}>…</Link>
 *
 * One implementation because three renderers had hand-copied the sequence and
 * had already drifted — the pricing CTA dropped `download`, so a media-file CTA
 * navigated instead of downloading, unlike the same link on every other slice.
 */
export function sliceLinkAttrs(
  link: CMSLinkField | undefined,
  ctx: SliceRenderContext
): {
  href: string
  download?: true
  target?: "_blank"
  rel?: string
} | null {
  const href = linkToHref(link, ctx)
  if (!href) return null
  const rel = composeRel({
    openInNewTab: link?.openInNewTab,
    noFollow: link?.noFollow,
    sponsored: link?.sponsored,
    ugc: link?.ugc,
  })
  return {
    href,
    ...(link?.type === "media" ? { download: true as const } : {}),
    ...(link?.openInNewTab ? { target: "_blank" as const } : {}),
    ...(rel ? { rel } : {}),
  }
}

/** Render a slice's button items, skipping disabled or unresolved ones. */
export function SliceButtons({
  items,
  ctx,
  className,
  onBrand = false,
  fieldPath,
}: {
  items: ButtonField[] | undefined
  ctx: SliceRenderContext
  className?: string
  /** Descriptor list path supplied by the typed kit; absent for legacy callers. */
  fieldPath?: string
  /** Style buttons for an inverted `bg-brand` surface (see {@link ON_BRAND_VARIANT}). */
  onBrand?: boolean
}) {
  const entries = buttonRenderEntries(items, ctx)
  if (entries.length === 0) return null

  return (
    <div className={cn("flex flex-wrap gap-3", className)}>
      {entries.map(({ button, key, linkAttrs, sourceIndex }) => {
        const variant = VARIANT_MAP[button.variant ?? "primary"]
        const classes = cn(
          buttonVariants({ variant }),
          onBrand && ON_BRAND_VARIANT[variant],
          "public-cta-focus"
        )
        const icon = button.withIcon === true ? button.icon : undefined
        const label = <span>{button.label}</span>
        const renderedLabel = fieldPath && ctx.previewField
          ? ctx.previewField({
              fieldPath: `${fieldPath}.${sourceIndex}.label`,
              kind: "text",
              rendered: label,
            })
          : label
        const content = (
          <>
            <SliceImage
              image={icon}
              className="size-4 shrink-0 object-contain"
              decorative
            />
            {renderedLabel}
          </>
        )
        return (
          <Link key={key} {...linkAttrs} className={classes}>
            {content}
          </Link>
        )
      })}
    </div>
  )
}
