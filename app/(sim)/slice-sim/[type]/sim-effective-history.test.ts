import { sliceProfile } from "@/test-utils/slice-profile"
import { expect, test } from "vitest"
import { getSchema } from "@tiptap/core"
import { Node as PMNode } from "@tiptap/pm/model"
import { createSampleSlice } from "@/lib/slices/sample"
import { extensionsForContract } from "@/lib/rich-text/extensions"
import { sampleFields, type SampleField } from "./sim-sample-state"
import { initialTweakState, reducer } from "./visual-tweak-reducer"

const fields = [
  sampleFields(createSampleSlice("hero-agency")).find(
    (field) => field.contract === "plain"
  )!,
  sampleFields(createSampleSlice("faq-simple")).find(
    (field) => field.path === "primary.body" && field.contract === "inline"
  )!,
  sampleFields(createSampleSlice("faq-simple")).find(
    (field) => field.path === "items.0.question"
  )!,
  sampleFields(createSampleSlice("faq-simple")).find(
    (field) => field.path === "items.0.answer"
  )!,
  sampleFields(createSampleSlice("hero-agency")).find(
    (field) =>
      field.path === "primary.description" && field.contract === "basic"
  )!,
]
function serializedSeed(field: SampleField): string {
  return field.contract === "plain"
    ? field.value
    : JSON.stringify(
        PMNode.fromJSON(
          getSchema(extensionsForContract(field.contract)),
          JSON.parse(field.value)
        ).toJSON(),
        null,
        2
      )
}
function changed(field: SampleField): string {
  return field.contract === "plain"
    ? `${field.value} Final`
    : field.value.replace(/"text":"([^"]+)"/, '"text":"$1 Final"')
}
for (const profileRow of fields) {
  test.each([profileRow])("$contract $path effective seed flush preserves redo across sparse undo/reset/preset", sliceProfile([]),
    (field) => {
      expect(field).toBeDefined()
      const action = (value: string) => ({
        kind: "sample" as const,
        path: field.path,
        value,
        field,
        selection: { path: field.path, from: 2, to: 2 },
        group: "editor",
      })
      for (const sparse of ["initial", "reset", "preset"]) {
        let state =
          sparse === "preset"
            ? reducer(initialTweakState, { kind: "preset", key: "other" })
            : sparse === "reset"
              ? reducer(reducer(initialTweakState, action(changed(field))), {
                  kind: "resetSamples",
                })
              : initialTweakState
        state = reducer(state, action(changed(field)))
        state = reducer(state, action(changed(field))) // mandatory unchanged flush
        state = reducer(state, { kind: "undo" })
        expect(state.samples[state.preset]?.[field.path]).toBeUndefined()
        const before = [
          state.past.length,
          state.future.length,
          state.reapplyNonce,
        ]
        state = reducer(state, action(serializedSeed(field)))
        expect([
          state.past.length,
          state.future.length,
          state.reapplyNonce,
        ]).toEqual(before)
        expect(state.selection?.from).toBe(2)
        state = reducer(state, { kind: "redo" })
        expect(state.samples[state.preset][field.path]).toBe(changed(field))
        state = reducer(state, { kind: "undo" })
        state = reducer(
          state,
          action(changed(field).replace("Final", "Actual new edit"))
        )
        expect(state.future).toHaveLength(0)
      }
    }
  )
}
test("canonical comparison preserves meaningful marks and body structure", sliceProfile([]), () => {
  const field = fields[3]
  const action = (value: string) => ({
    kind: "sample" as const,
    path: field.path,
    value,
    field,
    selection: null,
  })
  let state = reducer(initialTweakState, action(field.value))
  expect(state.past).toHaveLength(0)
  const marked = JSON.parse(field.value)
  marked.content[0].content[0].marks = [{ type: "bold" }]
  state = reducer(state, action(JSON.stringify(marked)))
  expect(state.past).toHaveLength(1)
  const list = {
    type: "doc",
    content: [
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "List" }] },
            ],
          },
        ],
      },
    ],
  }
  state = reducer(state, action(JSON.stringify(list)))
  const count = state.past.length
  state = reducer(
    state,
    action(
      JSON.stringify(
        {
          ...list,
          content: [{ ...list.content[0], attrs: { start: 1, type: null } }],
        },
        null,
        2
      )
    )
  )
  expect(state.past).toHaveLength(count)
  state = reducer(
    state,
    action(
      JSON.stringify({
        ...list,
        content: [{ ...list.content[0], attrs: { start: 2 } }],
      })
    )
  )
  expect(state.past).toHaveLength(count + 1)
})
