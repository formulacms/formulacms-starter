/**
 * Runtime APIs a public slice renderer may never reach for, shared by the two
 * gates that both have to refuse them:
 *
 * - the **pre-write** boundary in `persist.ts`, which sees only the JSX body a
 *   model emitted and rejects it before anything is scaffolded to disk;
 * - the **post-write** `verify-slice` gate, which sees the finished file.
 *
 * They were two hand-maintained tables and had already drifted: the pre-write
 * list knew about `useState`/`useEffect`/`useRef` but not `useReducer`,
 * `useActionState`, or any of the Convex hooks, so a body using those passed the
 * cheap check and only died after a full scaffold + write + typecheck + verify,
 * costing a rollback for a failure that was knowable up front.
 *
 * One table, both importers — the same arrangement `renderer-heading-rule.ts`
 * already uses for the heading invariant, and for the same reason: a rule that
 * only one gate knows is a rule that can be bypassed.
 *
 * Rules that depend on the *shape* of the input stay with their gate: whole-file
 * concerns (`"use client"`, import statements, design-token fidelity) live in
 * `verify.ts`, and body-fragment concerns (no top-level exports, no function
 * declarations, no event handlers) live in `persist.ts`.
 */

export interface RendererRule {
  re: RegExp
  msg: string
}

export const RENDERER_UNSAFE_RULES: RendererRule[] = [
  {
    re: /\b(?:useState|useEffect|useRef|useReducer|useActionState|useQuery|useMutation|useAction|useConvex|useConvexAuth)\s*\(/,
    msg: "client hook — public slice renderers must remain Server Components unless an interaction island is deliberately split out",
  },
  {
    re: /\b(?:memo|useMemo|useCallback)\s*\(/,
    msg: "client re-render optimization — generated public slice renderers should be static Server Components, not memoized client work",
  },
  {
    re: /\b(?:Date\.now|Math\.random)\s*\(/,
    msg: "non-deterministic render value — public slices must render stable HTML from CMS data",
  },
  {
    re: /\b(?:window|document|localStorage|sessionStorage|navigator)\b/,
    msg: "browser global — public slice renderers must not depend on browser-only APIs",
  },
  {
    re: /\bdangerouslySetInnerHTML\b/,
    msg: "raw HTML injection — use <RichTextContent /> for rich text",
  },
  {
    re: /<img\b/i,
    msg: "raw <img> — use <SliceImage /> so media behavior, crops, dimensions, and accessibility stay centralized",
  },
  {
    re: /\bstyle\s*=\s*\{\s*\{/,
    msg: "inline style object — use design tokens, standard utilities, or an approved helper preset",
  },
]
