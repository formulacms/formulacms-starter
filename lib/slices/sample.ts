/**
 * Sample-data synthesizer re-export.
 *
 * The implementation lives at `convex/lib/slices/sample.ts` so server actions
 * (contentWriter) can use it as the editorial-fallback base when the model
 * returns missing labeled blocks. The Next.js side keeps importing from here.
 */
export {
  createSampleSlice,
  createSampleRelationCards,
  hasCuratedPreview,
} from "@/convex/lib/slices/sample"
