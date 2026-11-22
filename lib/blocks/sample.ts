/**
 * Sample-data synthesizer re-export.
 *
 * The implementation lives at `convex/lib/blocks/sample.ts` so server actions
 * (contentWriter) can use it as the editorial-fallback base when the model
 * returns missing labeled blocks. The Next.js side keeps importing from here.
 */
export {
  createSampleBlock,
  createSampleRelationCards,
  hasCuratedPreview,
} from "@/convex/lib/blocks/sample"
