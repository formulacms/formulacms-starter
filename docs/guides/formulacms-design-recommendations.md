# formulacms Design Recommendations

This guide defines how visual design becomes production code in formulacms.
It is written for designers, web designers, developers, and AI agents.

> Identity & naming: `formulacms` (lowercase) is a full-stack CMS — see
> [`Identity.md`](../../Identity.md) for the canonical name, label, and
> positioning. Do not use the camel-case form, or call it "headless" or
> "open source."

The goal is a smooth design-to-code journey: preserve design intent, keep the
implementation coherent with the existing stack, and avoid the familiar fight
where design artifacts are treated either as untouchable pixels or disposable
inspiration.

## Core Position

Design artifacts are source material. Production code is normalized into the
formulacms system.

A designer may provide Figma frames, screenshots, exported HTML, JSX, CSS,
Tailwind examples, motion references, or plain written direction. Those inputs
are valuable and should be treated seriously. They are authoritative for intent,
not automatically authoritative for implementation.

Production code must follow the repo's conventions:

- Next.js and React patterns already used by the app.
- Tailwind v4 utilities for styling.
- The site design-system tokens in `app/globals.css`.
- Existing shared components and slice patterns before new primitives.
- shadcn/Radix primitives for standard interface controls.
- The existing `motion` package for meaningful animation.
- Typed slice descriptors and field primitives for CMS-editable content.

This is the central contract:

> A designer's HTML, JSX, or CSS is a high-fidelity design brief. It may be
> reused when compatible, but it must be translated into formulacms conventions
> before becoming production code.

## Why This Document Exists

The design-to-code handoff fails when people are optimizing for different
truths.

Designers usually optimize for clarity, emotion, hierarchy, brand expression,
and the quality of the final page.

Developers usually optimize for maintainability, accessibility, typed content,
responsive behavior, performance, reuse, and long-term change.

AI agents need even more explicit rules. Without them, agents tend to copy
surface details too literally, invent new fields, ignore existing tokens, or
generate code that looks plausible but does not fit the product.

This document makes the translation rules explicit so everyone is pushing in
the same direction.

## Audience

Use this document when:

- A designer prepares a page, section, or component for implementation.
- A web designer turns visual direction into HTML, JSX, or CSS.
- A developer turns design input into a formulacms slice or component.
- An AI agent generates, reviews, or refactors design-derived code.
- A reviewer decides whether the result is faithful to both the design and the
  system.

## Shared Vocabulary

Use these terms consistently in briefs, code reviews, and agent prompts.

| Term | Meaning |
| --- | --- |
| Design artifact | Any source input: Figma, screenshot, HTML, JSX, CSS, image, prototype, or written brief. |
| Page | A routable document composed from slices and global layout chrome. |
| Slice | A reusable, typed CMS section with a descriptor, renderer, fields, and AI hint. |
| Component | A React building block used by pages, slices, admin UI, or shared UI. |
| Variant | A named option inside a component or slice when the underlying structure stays the same. |
| Field | CMS-editable content or structural intent stored in a typed descriptor. |
| Token | A named design-system value for color, type, spacing, radius, or container width. |
| Renderer | The React component that turns typed content into public UI. |
| Structural intent | A content-relevant layout choice, such as list order or media presence. |
| Styling | Presentation concerns such as color, spacing, typography, shadows, and radius. |

## The Translation Rule

When translating a design artifact, separate four layers:

1. **Content**
   Text, links, images, videos, dates, prices, people, products, FAQ items,
   testimonials, and other editor-controlled meaning.

2. **Structure**
   Hierarchy, repeated groups, section layout, responsive reflow, call-to-action
   order, and content relationships.

3. **Design system**
   Colors, typography, spacing, radius, containers, surface treatment, and
   recurring visual roles.

4. **Implementation**
   React components, Tailwind classes, shadcn/Radix primitives, typed
   descriptors, validation, accessibility, performance, and tests.

Content and structure inform fields and JSX.

Design-system concerns resolve through tokens.

Implementation follows the formulacms stack.

## Opinionated Defaults

formulacms should be opinionated enough to keep production code coherent, while
remaining flexible enough to respect strong design work.

### Non-Negotiable

- Production code follows this repository's Next.js, React, and TypeScript
  conventions.
- Styling uses Tailwind v4 utilities and the site design-system tokens.
- Colors, type scale, section rhythm, and container roles bind to tokens first.
- Standard controls use existing shared UI, shadcn components, or Radix
  primitives.
- Icons use the existing icon approach, currently `lucide-react`, unless a
  brand asset or custom illustration is required.
- Motion uses the existing `motion` package when animation needs JavaScript.
- CMS fields store content and structural intent, not pure visual styling.
- Slice descriptors are typed. Do not use `v.any()`.
- Generated or pasted code must be reviewed and normalized before merge.

### Default

- Prefer existing slices, field primitives, helpers, and UI components.
- Prefer semantic HTML over div-only structures.
- Prefer mobile-first responsive Tailwind classes.
- Prefer token utilities such as `text-display`, `text-heading`, `text-lead`,
  `py-section`, `px-gutter`, `gap-stack`, `max-w-content`, `max-w-wide`,
  `bg-surface`, `bg-surface-2`, `text-on-surface`, `text-on-surface-muted`,
  `text-brand`, and `bg-brand`.
- Prefer shadcn/Radix for buttons, inputs, checkboxes, dialogs, drawers, menus,
  tabs, accordions, tooltips, navigation menus, and form controls.
- Prefer CSS transitions or Tailwind animation utilities for small state
  changes.
- Prefer `motion` for choreographed entrance, layout, drag, gesture, or
  scroll-linked animation.

### Escape Hatch

Custom CSS, custom components, or a new dependency can be proposed when there is
a clear reason:

- Tailwind cannot express the interaction or visual treatment cleanly.
- A shadcn/Radix primitive does not match the required behavior.
- The design depends on a brand-specific asset, illustration, or rendering
  technique.
- Performance, accessibility, or bundle size improves with a specialized
  solution.
- The requirement is foundational and likely to be reused across the site.

The escape hatch needs a short rationale in the PR, issue, or agent summary:

```md
Escape hatch: custom CSS is used for the radial product mask because Tailwind
cannot express the mask path clearly. The color and spacing still bind to site
tokens.
```

## Designer Guidance

Designers do not need to design "in Tailwind" or "in shadcn." They should
design the best page or section for the user and provide enough information for
faithful implementation.

For each design handoff, provide:

- Desktop frame.
- Mobile frame.
- Tablet frame when the layout changes meaningfully between mobile and desktop.
- Repeated item examples, including minimum and maximum likely content.
- Long text examples, not only ideal short copy.
- Empty or optional-field behavior when relevant.
- Hover, focus, active, disabled, loading, and error states for interactive UI.
- Image aspect ratios, crop intent, focal points, and alt-text guidance.
- Motion intent when animation matters.
- Accessibility concerns, such as heading order, keyboard behavior, or reduced
  motion expectations.
- Notes on what is brand-critical versus flexible.

Designers should label repeated structures explicitly:

- "These are feature cards."
- "This is a testimonial list."
- "This eyebrow is optional."
- "The second CTA can be omitted."
- "The image should crop around the person's face."
- "This layout must stack before the image on mobile."

Small labels like that save real implementation time.

## Web Designer Guidance

Web designers may ship HTML, JSX, CSS, or Tailwind examples. That is welcome.
Treat these artifacts as strong design communication.

When preparing code-like artifacts, optimize for clarity:

- Use semantic HTML.
- Preserve repeated structures as repeated markup.
- Include mobile and desktop behavior.
- Keep class names or utilities readable.
- Avoid obfuscated generated code.
- Do not hide important layout behavior in global CSS.
- Include comments only when they explain intent that is not visible.

The implementation team or AI agent may rewrite the markup. That rewrite is not
a rejection of the design. It is the normalization step that turns a design
artifact into maintainable formulacms code.

## Developer Guidance

Developers should preserve design intent while translating the artifact into the
system.

Before implementing:

- Inspect existing slices and shared components.
- Identify repeated groups, optional regions, and editor-controlled content.
- Decide what belongs in the CMS model and what belongs in CSS.
- Map colors, type, spacing, radius, and containers to existing tokens.
- Identify whether the artifact is a page composition, a new slice, a slice
  renderer change, or a shared component.

During implementation:

- Use Server Components by default.
- Add `"use client"` only for hooks, events, browser APIs, or client-side
  libraries.
- Keep slice fields focused on content and structural intent.
- Keep pure styling in renderers, CSS, and tokens.
- Use shared render helpers for buttons, links, rich text, and media where
  available.
- Keep layout geometry faithful to the source design.
- Bind brand and typography decisions to tokens.
- Avoid copying raw third-party theme code into the project.

After implementation:

- Compare desktop and mobile output against the design artifact.
- Test long content, missing optional content, and real CMS data.
- Check keyboard focus, accessible names, heading order, and reduced motion.
- Run the relevant typecheck, validation, and slice verification commands.

## AI Agent Guidance

AI agents must treat this guide as an operating contract.

When given a design artifact:

1. Identify the artifact type: Figma, screenshot, HTML, JSX, CSS, prompt, or
   mixed input.
2. Extract content, structure, design-system signals, and implementation needs.
3. Search the repo for existing slices, components, helpers, and tokens before
   creating new patterns.
4. Preserve layout geometry and responsive intent.
5. Translate color, type, spacing, radius, and container values into site tokens.
6. Use Tailwind v4, shared UI, shadcn/Radix primitives, and existing helpers.
7. Do not add a new dependency unless the escape hatch is justified.
8. Do not convert visual styling into CMS fields.
9. Do not invent fields that are not supported by the design's content or
   structure.
10. Flag uncertainty instead of guessing when the design artifact is ambiguous.

Agents should say what they normalized:

```md
Normalized the provided JSX into a typed formulacms slice. Kept the two-column
layout and card repetition, mapped raw palette classes to `text-brand` and
`bg-surface`, and used the shared button renderer for CTAs.
```

## Design-To-Code Workflow

Use this workflow for new pages, sections, and design-derived features.

### 1. Intent

Clarify the job of the design:

- What user need does it serve?
- What content does it contain?
- What action should the user take?
- What parts are brand-critical?
- What parts are flexible?

### 2. Source Artifact

Collect the best available artifact:

- Figma frame.
- Desktop and mobile screenshots.
- HTML, JSX, CSS, or Tailwind snippet.
- Written brief.
- Existing site reference.
- Motion reference.

Higher-fidelity inputs reduce guessing. HTML or JSX is especially useful for
repeated structure and responsive intent, even when it is not production-ready.

### 3. Content Model

Classify each visible element:

- Editor content: title, summary, link, image, label, item list.
- Structural intent: ordered list, grouped cards, optional media, CTA count.
- Pure styling: color, spacing, radius, shadows, font size, overlay strength.

Only content and structural intent become CMS fields.

### 4. System Mapping

Map the artifact into formulacms conventions:

- Existing slice or new slice.
- Existing component or new component.
- Existing token or proposed token.
- Existing shadcn/Radix primitive or custom interaction.
- Existing motion pattern or new animation.

### 5. Implementation

Build the slice, component, or page using repo conventions.

Keep implementation scoped to the request. If the design exposes a broader
system gap, note it separately instead of smuggling a large refactor into the
feature.

### 6. Review

Review against both sources of truth:

- Does it preserve the design intent?
- Does it fit the formulacms implementation model?

The best outcome is not blindly pixel-perfect code. It is a faithful design
translated into a maintainable system.

## When A Designer Ships HTML, JSX, Or CSS

Use this decision table.

| Artifact detail | Treat as authoritative for | Normalize into |
| --- | --- | --- |
| Semantic markup | Content hierarchy and structure | React components and slice renderers |
| Repeated DOM blocks | Lists, groups, and field shape | Typed field primitives |
| Tailwind classes | Layout, spacing, responsive clues | Tailwind v4 plus design-system tokens |
| Raw CSS colors | Brand and surface intent | Token roles in `app/globals.css` |
| Font sizes | Type hierarchy | `text-display`, `text-title`, `text-heading`, `text-lead`, etc. |
| Pixel spacing | Visual rhythm | `py-section`, `px-gutter`, `gap-stack`, or local layout utilities |
| JavaScript animation | Motion intent | Existing `motion` package or CSS transitions |
| Third-party component markup | Interaction intent | shadcn/Radix or existing shared UI |

Do not copy pasted HTML, JSX, or CSS directly into production unless it already
meets the repo's conventions.

## Worked Examples

These examples show how to translate design artifacts without flattening their
intent or importing incompatible implementation choices.

### Example 1: Designer Ships Tailwind JSX For A Hero

Input artifact:

```tsx
export function Hero() {
  return (
    <section className="bg-indigo-950 px-6 py-24 text-white sm:py-32">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold uppercase text-indigo-300">
            Launch faster
          </p>
          <h1 className="mt-4 text-5xl font-bold tracking-tight">
            Build your site from your real design
          </h1>
          <p className="mt-6 text-lg text-indigo-100">
            Turn approved visual sections into editable CMS slices.
          </p>
          <div className="mt-8 flex gap-3">
            <a className="rounded-md bg-white px-4 py-2 text-indigo-950">
              Start now
            </a>
            <a className="rounded-md border border-white/30 px-4 py-2">
              See demo
            </a>
          </div>
        </div>
        <img className="rounded-3xl" src="/dashboard.png" alt="" />
      </div>
    </section>
  )
}
```

Treat as authoritative for:

- Two-column hero structure.
- Eyebrow, headline, lead text, two CTAs, and image.
- Desktop max-width and grid rhythm.
- Mobile-first stack with desktop split.
- Dark brand surface with light foreground.

Normalize into formulacms:

```md
Slice type:
hero-product-split

Fields:
- eyebrow optional text
- title required text
- lead optional rich text
- image optional media
- buttons list, max 2

Renderer decisions:
- `bg-indigo-950` -> `bg-brand` or `bg-surface` depending on site tokens
- `text-indigo-300` -> `text-brand` or `text-on-surface-muted`
- `text-5xl` -> `text-display`
- `text-lg` -> `text-lead`
- `px-6` -> `px-gutter`
- `py-24 sm:py-32` -> `py-section`
- `max-w-7xl` -> `max-w-wide`
- Keep `lg:grid-cols-2`, `gap-12`, image placement, and rounded media geometry
- Use shared button rendering instead of hand-coded anchors
```

Do not create fields for:

- Background color.
- Heading size.
- Section padding.
- Button radius.
- Text color.

Those are design-system and renderer concerns.

### Example 2: Designer Ships CSS With Brand Styling

Input artifact:

```css
.cta {
  background: #4f46e5;
  color: white;
  padding: 96px 24px;
  border-radius: 32px;
}

.cta h2 {
  font-size: 48px;
  line-height: 1.05;
}
```

Translation:

| Source | Meaning | formulacms output |
| --- | --- | --- |
| `#4f46e5` | Brand color signal | Use `bg-brand`; propose a brand token override if site-wide |
| `white` | Foreground on brand | Use `text-brand-foreground` or `text-on-surface` |
| `96px 24px` | Section rhythm and gutter | Use `py-section px-gutter` |
| `32px` radius | Large rounded treatment | Use existing radius utility or propose token if reused |
| `48px` heading | Display heading | Use `text-display` |

Good implementation summary:

```md
Mapped the CTA CSS to site tokens. The brand color becomes `bg-brand`, section
padding becomes `py-section px-gutter`, and the heading uses `text-display`.
Kept a large radius locally because the design's pill-like band is part of the
section geometry.
```

Bad implementation summary:

```md
Copied the `.cta` CSS into `globals.css`.
```

### Example 3: Pricing Cards Field Classifier

Input design:

- Section eyebrow: "Pricing"
- Heading: "Plans that scale with your team"
- Three pricing cards.
- Each card has plan name, monthly price, description, feature list, CTA.
- The middle card is emphasized with a stronger border and brand badge.
- Cards have a gradient background and soft shadow.

Field decision table:

| Visible detail | CMS field? | Why |
| --- | --- | --- |
| Eyebrow | Yes, optional text | Editor-controlled copy |
| Heading | Yes, required text | Main content |
| Plan name | Yes, text inside `plans[]` | Repeated content |
| Monthly price | Yes, text or structured price field | Editor-controlled offer |
| Feature list | Yes, list inside each plan | Repeated content |
| CTA label and link | Yes | Editor-controlled action |
| Emphasized plan | Yes, `featured` boolean per plan | Structural intent: changes which plan is featured |
| Border color | No | Styling |
| Gradient background | No | Styling |
| Shadow strength | No | Styling |
| Card padding | No | Styling |

Possible model shape:

```md
pricing-comparison-cards

Fields:
- eyebrow optional text
- title required text
- intro optional rich text
- plans list
  - name required text
  - price required text
  - description optional text
  - features list of text
  - featured boolean, structural intent
  - cta required button ref
```

Renderer decisions:

- Use a grid that stacks on mobile and becomes three columns on desktop.
- Use `bg-surface`, `bg-surface-2`, `border-border`, and `text-brand`.
- Use shared button variants for CTAs.
- Apply featured styling based on structural intent, not hand-authored content
  like "middle card."

### Example 4: Motion Reference

Input artifact:

```md
Motion note:
Feature cards should fade in one by one as the section enters the viewport.
The animation should feel quick and calm, not playful.
```

Decision:

```md
Use `motion` if the reveal is important to the experience and already requires
viewport detection or stagger orchestration. Use CSS transitions only for simple
hover/focus states. Do not add GSAP or another animation package.
```

Implementation requirements:

- Keep content readable if JavaScript is slow or disabled.
- Respect reduced-motion preferences.
- Avoid long delays before text becomes visible.
- Keep stagger timing subtle.
- Do not animate layout in a way that causes reading jumps.

Good agent summary:

```md
Implemented a reduced-motion-aware card reveal with the existing `motion`
package. The cards render in place, use a short opacity/translate transition,
and remain readable without relying on animation for layout.
```

### Example 5: Ambiguous Screenshot

Input artifact:

```md
One desktop screenshot of a testimonial section.
No mobile view. No HTML. No notes.
```

Agent or developer response:

```md
Assumptions:
- The three testimonials become a list.
- The desktop three-column layout stacks into one column on mobile.
- Avatar images are optional media fields.
- Star rating is decorative unless the CMS needs editable rating values.

Implementation:
- Create `testimonials-three-up`.
- Use `quotes[]` with name, role, quote, avatar, and optional rating.
- Use `max-w-wide`, `px-gutter`, `py-section`, `bg-surface`, and `text-heading`.

Needs review:
- Confirm whether ratings are real data or decorative proof.
- Confirm whether mobile order should change.
```

This is better than silently guessing. It keeps the work moving while surfacing
the decisions that need human confirmation.

## Slice-Specific Rules

formulacms slices are code-first and typed.

When a design becomes a slice:

- Follow the slice authoring guide in `.agents/skills/formulacms/AUTHORING.md`.
- Use a slice name that describes layout or intent.
- Model repeated structures as lists.
- Model optional content as optional fields.
- Use relation fields for references to existing content.
- Keep styling out of the descriptor.
- Put renderer styling in JSX classes, CSS, and tokens.
- Include an `aiHint` that names fields clearly for content-generation agents.
- Verify the slice after hand-tuning generated output.

Per ADR-0044, run reuse triage before creation. Reuse a registered Slice Type
unchanged only when its editorial job and structural contract match exactly.
Never widen an existing schema to absorb a meaningfully different design;
structural siblings and genuinely new contracts receive new types.

## SliceSpec JSON Skeleton

Include a SliceSpec skeleton when the handoff is meant for AI agents or
developers who will generate a real formulacms slice. It gives the implementation
step a machine-readable target and reduces ambiguity around fields, repeated
items, and content-generation hints.

Use it as an advanced handoff artifact, not as a replacement for screenshots,
Figma frames, or design notes.

Important rules:

- The JSON must be strict JSON: no comments, no trailing commas, no TypeScript.
- Use the real `SliceSpec` shape from `lib/slices/authoring/scaffold.ts`.
- Keep design notes outside the JSON block.
- Use exact primitive names: `richText`, not `rich-text`.
- Choose one existing group: `heroes`, `content`, `features`, `commerce`, or
  `navigation`.
- Use `{ "kind": "ref", "ref": "button" }` for shared button fields.
- Use `items` for a repeated top-level slice region.
- Use nested `list` fields for repeated content inside a group.
- Do not include styling fields such as `backgroundColor`, `padding`, `fontSize`,
  `shadow`, or `radius`.

Template:

```json
{
  "type": "kebab-case-slice-name",
  "label": "Human Label",
  "description": "Short picker description.",
  "icon": "Layers",
  "group": "features",
  "primary": {
    "kind": "group",
    "fields": {
      "eyebrow": {
        "kind": "text",
        "optional": true,
        "config": {
          "placeholder": "Short label from the design"
        }
      },
      "title": {
        "kind": "text",
        "config": {
          "placeholder": "Readable headline from the design"
        }
      },
      "intro": {
        "kind": "richText",
        "optional": true,
        "config": {
          "profile": "inline",
          "placeholder": "Optional intro copy from the design"
        }
      },
      "image": {
        "kind": "image",
        "optional": true
      }
    }
  },
  "items": {
    "item": {
      "kind": "group",
      "fields": {
        "title": {
          "kind": "text",
          "config": {
            "placeholder": "Item title"
          }
        },
        "description": {
          "kind": "richText",
          "optional": true,
          "config": {
            "profile": "inline",
            "placeholder": "Item description"
          }
        },
        "icon": {
          "kind": "select",
          "optional": true,
          "config": {
            "options": ["sparkles", "shield", "zap"],
            "default": "sparkles",
            "labels": {
              "sparkles": "Sparkles",
              "shield": "Shield",
              "zap": "Zap"
            }
          }
        },
        "cta": {
          "kind": "ref",
          "ref": "button",
          "optional": true
        }
      }
    },
    "min": 1,
    "max": 6
  },
  "aiHint": {
    "purpose": "Describe what this slice helps a page communicate.",
    "fields": [
      "Return the fields below, each wrapped in matching fenced tags.",
      "[eyebrow]\\nShort label\\n[/eyebrow]",
      "[title]\\nClear section title\\n[/title]",
      "[intro]\\nOne or two sentence intro.\\n[/intro]",
      "[items]\\n- Item title: item description\\n[/items]"
    ]
  }
}
```

Example for pricing cards:

```json
{
  "type": "pricing-comparison-cards",
  "label": "Pricing Comparison Cards",
  "description": "Pricing cards with feature lists and plan CTAs.",
  "icon": "CreditCard",
  "group": "commerce",
  "primary": {
    "kind": "group",
    "fields": {
      "eyebrow": {
        "kind": "text",
        "optional": true,
        "config": {
          "placeholder": "Pricing"
        }
      },
      "title": {
        "kind": "text",
        "config": {
          "placeholder": "Plans that scale with your team"
        }
      },
      "intro": {
        "kind": "richText",
        "optional": true,
        "config": {
          "profile": "inline",
          "placeholder": "Choose the plan that matches your current stage."
        }
      }
    }
  },
  "items": {
    "item": {
      "kind": "group",
      "fields": {
        "name": {
          "kind": "text",
          "config": {
            "placeholder": "Starter"
          }
        },
        "price": {
          "kind": "text",
          "config": {
            "placeholder": "$29/mo"
          }
        },
        "description": {
          "kind": "text",
          "optional": true,
          "config": {
            "placeholder": "For small teams getting started."
          }
        },
        "features": {
          "kind": "list",
          "item": {
            "kind": "text"
          },
          "config": {
            "min": 1,
            "max": 8
          }
        },
        "featured": {
          "kind": "boolean",
          "config": {
            "label": "Featured plan",
            "default": false
          }
        },
        "cta": {
          "kind": "ref",
          "ref": "button"
        }
      }
    },
    "min": 2,
    "max": 4
  },
  "aiHint": {
    "purpose": "Help buyers compare plans and choose one.",
    "fields": [
      "Return the fields below, each wrapped in matching fenced tags.",
      "[eyebrow]\\nShort pricing label\\n[/eyebrow]",
      "[title]\\nPricing section headline\\n[/title]",
      "[intro]\\nShort buying guidance.\\n[/intro]",
      "[items]\\n- Plan name | price | description | feature 1; feature 2 | CTA label\\n[/items]"
    ]
  }
}
```

Supported field kinds:

| Kind | Use for |
| --- | --- |
| `text` | Plain text, labels, names, short descriptions |
| `richText` | Inline, basic, or full rich text content |
| `image` | CMS-managed image/media selection |
| `link` | Generic link field |
| `ref` with `button` | Shared button shape |
| `boolean` | True/false structural intent |
| `select` | A closed set of structural choices |
| `number` | Numeric content or configuration that is not pure styling |
| `date` / `datetime` | Dates and scheduled/event-like content |
| `geopoint` | Location coordinates |
| `embed` | External embeds |
| `table` | Structured tabular content |
| `relation` | References to existing pages or content |
| `group` | Named object of related fields |
| `list` | Repeated content |

## Design System Rules

Each formulacms site has one design-system token layer. It lives in
`app/globals.css` and defaults to shadcn Neutral values until the site owner
overrides it.

Use tokens for:

- Brand colors.
- Surface colors.
- Foreground and muted text.
- Type hierarchy.
- Section rhythm.
- Gutters.
- Stack gaps.
- Container widths.
- Radius scale.

Do not invent raw hex colors, one-off fonts, or arbitrary type ramps inside a
slice renderer. If a design needs a new reusable role, propose a token and
explain why.

Important distinction:

- **Geometry should stay faithful.** Grid shape, column count, alignment,
  media position, card composition, and responsive reflow define the design.
- **Theme values should bind to tokens.** Color, type, and global rhythm should
  be coherent across the site.

## Motion Rules

Motion should help the interface, not decorate it randomly.

Use motion for:

- Revealing hierarchy.
- Clarifying state changes.
- Supporting navigation or spatial continuity.
- Drawing attention to an important change.
- Making interactive controls feel responsive.

Avoid motion that:

- Delays the user.
- Makes content harder to read.
- Replays constantly without purpose.
- Ignores reduced-motion preferences.
- Requires a new animation library without clear benefit.

Implementation preference:

- CSS transitions or Tailwind utilities for simple hover, focus, opacity, and
  transform states.
- `motion` for coordinated, gesture-based, layout, scroll, or entrance
  animation.
- No new motion dependency without an escape-hatch rationale.

## Accessibility Rules

Accessibility is part of fidelity. A design is not fully implemented if it only
looks right.

Check:

- Logical heading order.
- Semantic landmarks where appropriate.
- Keyboard reachability.
- Visible focus states.
- Accessible names for buttons, links, and icon-only controls.
- Color contrast.
- Alt text or decorative image handling.
- Form labels, errors, and descriptions.
- Reduced-motion behavior for significant animation.
- Touch target size on mobile.

When the visual design omits an accessibility state, implement the state using
the closest existing system pattern and note it in review.

## Content And Localization Rules

Designs often show ideal copy. CMS content is rarely ideal.

Design and implementation should account for:

- Long headlines.
- Short headlines.
- Missing optional fields.
- Multiple CTA counts.
- Long names, prices, locations, and labels.
- Rich text with links or emphasis.
- Translated text expansion.
- Right-to-left layout for languages such as Arabic, Hebrew, or Persian.
- CJK and other non-Latin scripts (Chinese, Japanese, Korean, Thai), including
  taller line boxes, different word-break behavior, and no reliance on
  whitespace word boundaries.
- Empty lists.
- Image missing or still loading.
- Draft or unpublished content.

Avoid layouts that only work for one perfect sentence.

Build renderers direction-agnostic so they work in both LTR and RTL:

- Drive direction from the document/locale (`dir="rtl"` on the relevant
  ancestor), not per-renderer guesses.
- Prefer logical CSS and Tailwind utilities (`ms-`/`me-`, `ps-`/`pe-`,
  `start`/`end`, `text-start`/`text-end`) over physical `left`/`right`.
- Mirror directional iconography (arrows, chevrons) under RTL; leave
  direction-neutral and brand marks untouched.
- Keep numerals, code, and embedded LTR runs readable inside RTL text.

## Asset Rules

For images and media, specify:

- Intended aspect ratio.
- Crop behavior.
- Focal point.
- Minimum useful dimensions.
- Whether the image is decorative or meaningful.
- Alt-text guidance.
- Dark and light mode expectations if relevant.
- Safe areas for overlaid text.

Do not rely on screenshots as production assets unless the screenshot itself is
the content.

## Review Checklists

### Design Handoff Checklist

- Desktop and mobile views are present.
- Responsive changes are clear.
- Repeated items are labeled.
- Optional fields are identified.
- Long-content examples are considered.
- Interactive states are included when relevant.
- Motion intent is described when relevant.
- Brand-critical details are called out.
- Assets have aspect ratio and crop guidance.

### Implementation Checklist

- Existing slices and components were checked first.
- The output uses Tailwind v4 and site tokens.
- Standard UI uses shared components or shadcn/Radix.
- Motion uses CSS or the existing `motion` package.
- CMS fields store content and structural intent only.
- Repeated regions are modeled as lists.
- Renderer geometry preserves the design.
- Long, short, and missing content states were checked.
- Accessibility states are present.
- Typecheck and relevant verification commands pass.

### AI Agent Checklist

- Read the relevant local guides and ADRs before code changes.
- Search existing files before creating new abstractions.
- Treat provided code as design input, not automatic production code.
- Preserve structure and responsive intent.
- Normalize colors, type, and rhythm into tokens.
- Use existing primitives and helpers.
- Avoid new dependencies.
- Explain any escape hatch.
- Report uncertainty and assumptions.

## Common Use Cases

### Figma Section To Slice

Use the Figma frame or screenshot to identify content, repeated structures,
responsive behavior, and token mapping. Generate or author a typed slice and
renderer, then compare the rendered output against the source design.

### Designer Provides JSX

Use the JSX for hierarchy, repeated blocks, responsive clues, and interaction
intent. Rewrite it into the repo's component and slice conventions. Preserve the
design's layout geometry, but normalize UI controls, styling, and motion.

### Designer Provides CSS

Use the CSS to understand visual intent. Map reusable colors, type, rhythm, and
radius into tokens. Keep local CSS only for treatments Tailwind cannot express
cleanly.

### Screenshot-Only Design

Treat the screenshot as visual reference, not a complete specification. Ask for
or infer mobile behavior, repeated item rules, asset crop intent, and optional
content handling. Flag assumptions.

### Existing Page Redesign

Separate content migration from visual redesign. Preserve existing content
fields when they still match the new design. Create new slice types when the new
design meaningfully changes the structure.

### AI-Generated UI Review

Review the generated output against this guide. The common failures are raw
colors, arbitrary spacing, invented fields, inaccessible controls, generic
layouts, and pasted code that bypasses shared components.

## Conflict Resolution

When design and implementation seem to disagree, use this order:

1. Preserve user-facing intent.
2. Preserve content meaning and editability.
3. Preserve responsive behavior.
4. Preserve accessibility.
5. Preserve design-system coherence.
6. Preserve implementation simplicity.

If a design detail conflicts with the system, do not silently ignore it. Choose
one of these outcomes:

- Translate it into an existing token or component.
- Propose a new token or shared primitive.
- Use a local escape hatch with rationale.
- Ask for a design adjustment when the cost or risk is too high.

## Good Handoff Example

```md
Section: Pricing comparison

Intent:
Help buyers compare three plans and choose one.

Artifacts:
- Desktop Figma frame
- Mobile Figma frame
- JSX prototype

Structure:
- Eyebrow, heading, intro text
- Three pricing cards
- Each card has name, price, description, feature list, and CTA
- Middle card is visually emphasized

Responsive:
- Desktop: three columns
- Mobile: stacked cards, emphasized card first

CMS fields:
- Eyebrow optional
- Heading required
- Intro optional rich text
- Plans list, 2 to 4 items
- Features list per plan
- CTA per plan

Design-system notes:
- Use site brand for emphasized plan
- Use standard surface tokens for other cards
- Use shared button variants

Motion:
- No entrance animation required
- Button hover follows system default
```

## Short Version

Design can arrive in any useful form. Production code should leave in one
coherent form: typed, accessible, responsive, token-bound, and aligned with the
formulacms stack.

Designers own intent. Developers own implementation quality. AI agents assist
the translation. This document is the handshake between the three.
