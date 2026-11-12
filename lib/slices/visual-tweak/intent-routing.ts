export type SliceChangeIntentKind =
  | "content-model"
  | "page-content"
  | "unsupported-text-color"
  | "local-style"
  | "design-system-import"
  | "design-system-edit"
  | "design-system-binding"
  | "structural"
  | "ambiguous"

export interface SliceChangeIntent {
  kind: SliceChangeIntentKind
  message: string
  newSiblingSuggested?: boolean
}

const CONTENT_MODEL_RE =
  /\b(field|schema|model|content model|descriptor|validator|placeholder|sample copy|ai hint|optional field|field group|rename (?:the )?field|add an? (?:optional )?(?:field|group|list)|remove (?:the )?field|select field|boolean field|number field|link field)\b/i

const TEXT_COLOR_RE =
  /\b(?:red|blue|green|orange|purple|pink|yellow|teal|cyan|indigo|violet|black|white|gr[ae]y|brand|destructive|accent|text)\b[^.!?\n]{0,50}\b(?:colou?r|tone)\b|\b(?:colou?r|tone)\b[^.!?\n]{0,50}\b(?:word|text|copy|headline|heading|title|subtitle|eyebrow|sentence|paragraph|label)\b|\b(?:make|turn|set)\b[^.!?\n]{0,35}\b(?:word|text|copy|headline|heading|title|subtitle|eyebrow|sentence|paragraph|label)\b[^.!?\n]{0,35}\b(?:red|blue|green|orange|purple|pink|yellow|teal|cyan|indigo|violet|black|white|gr[ae]y)\b/i
const TEXT_TARGET_RE =
  /\b(word|text|copy|headline|heading|title|subtitle|eyebrow|sentence|paragraph|label)\b/i
const GLOBAL_SCOPE_RE =
  /\b(all|every|global|globally|site[- ]wide|shared|everywhere|across the site)\b/i

const DESIGN_SYSTEM_NOUN_RE =
  /\b(design system|brand system|brand styles?|style guide|design tokens?|token json|theme|visual system|visual language|figma|website design|css variables?|styles? from [^.!?\n]{0,60}(?:website|site))\b/i
const DESIGN_SYSTEM_IMPORT_RE =
  /\b(bring|import|migrate|extract|translate|adopt|copy|match|recreate|port|use)\b/i
const DESIGN_SYSTEM_BIND_RE =
  /\b(apply|bind|use|switch|assign)\b[^.!?\n]{0,80}\b(pages?|content types?|slices?|blocks?|sections?|surfaces?|registers?|locales?|site areas?|site)\b|\b(pages?|content types?|slices?|blocks?|sections?|surfaces?|registers?|locales?|site areas?|site)\b[^.!?\n]{0,80}\b(apply|bind|use|switch|assign)\b/i
const DESIGN_SYSTEM_EDIT_RE =
  /\b(brand colou?r|global font|font family|shared type role|shared rhythm|site[- ]wide|all headings|every heading|design token|palette|global theme|global spacing|site rhythm)\b/i

const STRUCTURAL_RE =
  /\b(new wrapper|wrap(?:per)? element|semantic element|change (?:the )?(?:tag|element)|different repeat structure|repeat structure|new helper|new import|aria|accessibility wiring|two columns?|three columns?|reorder|move .* (?:left|right|above|below)|layout|restructure|crop|wrapping|breakpoint|alignment|align|center|radius|container width|grid)\b/i
const NEW_SIBLING_RE =
  /\b(new slice|new slice type|new block|new block type|new sibling|different layout|new variant|fundamentally different|different composition)\b/i

const PAGE_CONTENT_RE =
  /\b(reword|rewrite (?:the )?(?:page )?(?:copy|wording|headline|heading|title|subtitle|eyebrow|paragraph)|copy|wording|bold|italic|underline|strikethrough|highlight|selected word|last word|sentence|paragraph|page text|page content)\b/i

const LOCAL_STYLE_RE = /\b(padding|margin|spacing|gap)\b/i

/**
 * Route a Slice Type change request before any model call.
 *
 * Precedence is deliberately fail-closed: unsupported text color, owner design
 * system work, and structural work win over a supported clause in a mixed
 * request. That prevents the old "partially execute what the model understood"
 * failure mode.
 */
export function classifySliceChangeIntent(brief: string): SliceChangeIntent {
  const text = brief.trim()
  if (!text) {
    return {
      kind: "ambiguous",
      message: "Describe the outcome you want before continuing.",
    }
  }

  const isDesignSystemEdit =
    DESIGN_SYSTEM_EDIT_RE.test(text) ||
    (DESIGN_SYSTEM_NOUN_RE.test(text) &&
      /\b(change|update|edit|adjust|set|make)\b/i.test(text))

  if (
    TEXT_COLOR_RE.test(text) &&
    ((TEXT_TARGET_RE.test(text) && !GLOBAL_SCOPE_RE.test(text)) ||
      !isDesignSystemEdit)
  ) {
    return {
      kind: "unsupported-text-color",
      message:
        "Text color is not available yet. You can edit wording and supported formatting in the Page editor, but per-word or text-tone changes need an approved content mark first.",
    }
  }

  if (DESIGN_SYSTEM_NOUN_RE.test(text) && DESIGN_SYSTEM_BIND_RE.test(text)) {
    return {
      kind: "design-system-binding",
      message:
        "This applies an existing design-system register to a Page, content type, Block Type, or site surface. It needs reviewed binding work so existing owner scopes and modes stay intact.",
    }
  }

  if (DESIGN_SYSTEM_NOUN_RE.test(text) && DESIGN_SYSTEM_IMPORT_RE.test(text)) {
    return {
      kind: "design-system-import",
      message:
        "This brings an external design system into the site. Use the reviewed design-translation workflow to map its tokens, modes, fonts, components, and ownership before changing the site.",
    }
  }

  if (isDesignSystemEdit) {
    return {
      kind: "design-system-edit",
      message:
        "This changes an owner-supplied design system and may affect several Pages or Block Types. The design-system workspace with scoped impact preview is not available yet; use reviewed design-system work.",
    }
  }

  if (NEW_SIBLING_RE.test(text) || STRUCTURAL_RE.test(text)) {
    return {
      kind: "structural",
      message:
        "This changes renderer structure or an unsupported presentation property. It requires reviewed developer work and cannot be applied as a simulator nudge.",
      newSiblingSuggested: NEW_SIBLING_RE.test(text),
    }
  }

  if (CONTENT_MODEL_RE.test(text)) {
    return {
      kind: "content-model",
      message: "This is a Block Type content-model request.",
    }
  }

  if (PAGE_CONTENT_RE.test(text)) {
    return {
      kind: "page-content",
      message:
        "This changes Page content, not the reusable Block Type. Choose a Page that uses this Block Type and edit its content there.",
    }
  }

  if (LOCAL_STYLE_RE.test(text)) {
    return {
      kind: "local-style",
      message:
        "This is a supported local spacing change. Open the simulator, select the element, preview the change, and save it there.",
    }
  }

  return {
    kind: "ambiguous",
    message:
      "This request is ambiguous enough for the Block Type proposal to interpret safely before any write.",
  }
}

export function mayReachSliceSpecModel(intent: SliceChangeIntent): boolean {
  return intent.kind === "content-model" || intent.kind === "ambiguous"
}
