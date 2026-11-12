import {
  boolean,
  group,
  image,
  link,
  list,
  richText,
  select,
  text,
} from "@/convex/lib/slices/primitives"
import type { Infer } from "convex/values"
import type { SliceRenderContext } from "@/lib/slices/links"
import { bindSliceFields, Buttons, RichText, Text } from "./index"

const descriptor = {
  primary: group({
    heading: richText({ profile: "inline" }),
    nested: group({
      caption: text().optional(),
      body: richText({ profile: "basic" }),
      full: richText({ profile: "full" }).optional().public(),
    }),
  }),
  items: list(
    group({
      title: richText({ profile: "inline" }).optional().public(),
      body: richText({ profile: "full" }).public(),
    }),
    { max: 4 }
  ),
}
const slice = {
  id: "compile-fixture",
  primary: { heading: "{}", nested: { caption: "", body: "{}", full: "{}" } },
  items: [{ title: "{}", body: "{}" }],
}
const fields = bindSliceFields(descriptor, slice)
const index = 0
const indexedHeading: `items[${number}].title` = `items[${index}].title`
function dynamicIndexedHeading(i: number) {
  return <RichText fields={fields} fieldPath={`items[${i}].title`} as="h3" />
}
const customButtonListDescriptor = {
  primary: group({
    actions: list(
      group({
        id: text({ editorial: false }).optional(),
        label: text(),
        link: link(),
        variant: select({
          options: ["primary", "secondary", "outline", "ghost", "link"],
          default: "primary",
        }).optional(),
        withIcon: boolean({ default: false }),
        icon: image().optional(),
        enabled: boolean({ default: true }),
        trackingId: text({ editorial: false }).optional(),
      })
    ),
  }),
}
type CustomButtonListItem = Infer<
  typeof customButtonListDescriptor.primary.config.fields.actions.config.item.validator
>
const customButtonListValue: CustomButtonListItem[] = [
  {
    id: "custom-action",
    label: "Continue",
    link: { type: "external", url: "/next" },
    variant: "primary",
    withIcon: false,
    enabled: true,
    trackingId: "campaign-1",
  },
]
void customButtonListValue
const customButtonFields = bindSliceFields(customButtonListDescriptor, {
  primary: { actions: customButtonListValue },
})

const valid = (
  <>
    <RichText fields={fields} fieldPath="primary.heading" as="h2" />
    <RichText fields={fields} fieldPath="primary.nested.body" />
    <RichText fields={fields} fieldPath="primary.nested.full" />
    <RichText fields={fields} fieldPath="items[0].title" as="h3" />
    <RichText fields={fields} fieldPath="items[0].body" />
    <Text fields={fields} fieldPath="primary.nested.caption" />
    <RichText fields={fields} fieldPath={indexedHeading} />
    {dynamicIndexedHeading(index)}
    <Buttons
      fields={customButtonFields}
      fieldPath="primary.actions"
      ctx={{} as SliceRenderContext}
    />
  </>
)
void valid

// @ts-expect-error Unknown descriptor field must not widen the descriptor.
const unknownPath = <RichText fields={fields} fieldPath="primary.missing" />
void unknownPath
// prettier-ignore
// @ts-expect-error A missing nested field must not widen through group inference.
const unknownNestedPath = <RichText fields={fields} fieldPath="primary.nested.missing" />
void unknownNestedPath
// @ts-expect-error Text accepts only text leaves.
const wrongKind = <Text fields={fields} fieldPath="primary.heading" />
void wrongKind
// @ts-expect-error List indices use bracket notation in typed paths.
const dottedListIndex = <RichText fields={fields} fieldPath="items.0.title" />
void dottedListIndex
// @ts-expect-error A rich-text list child is not a text path.
const wrongListChild = <Text fields={fields} fieldPath="items[0].title" />
void wrongListChild
// prettier-ignore
// @ts-expect-error Basic-profile rich text cannot be selected as a heading.
const basicHeading = <RichText fields={fields} fieldPath="primary.nested.body" as="h3" />
void basicHeading
// prettier-ignore
// @ts-expect-error Full-profile rich text cannot be selected as a heading.
const fullHeading = <RichText fields={fields} fieldPath="primary.nested.full" as="h3" />
void fullHeading
// prettier-ignore
// @ts-expect-error Text fields cannot be rendered with a heading host.
const textHeading = <Text fields={fields} fieldPath="primary.nested.caption" as="h2" />
void textHeading
// prettier-ignore
// @ts-expect-error Buttons accepts only the shared button-list value shape.
const wrongButtons = <Buttons fields={fields} fieldPath="items" ctx={{} as SliceRenderContext} />
void wrongButtons

const wrongCustomButtonList = {
  primary: group({
    actions: list(
      group({
        id: text({ editorial: false }).optional(),
        label: boolean({ default: false }),
        link: link(),
        variant: select({
          options: ["primary", "secondary", "outline", "ghost", "link"],
          default: "primary",
        }).optional(),
        withIcon: boolean({ default: false }),
        icon: image().optional(),
        enabled: boolean({ default: true }),
      })
    ),
  }),
}
const wrongCustomButtonFields = bindSliceFields(wrongCustomButtonList, {
  primary: {
    actions: [
      {
        id: "custom-action",
        label: false,
        link: { type: "external", url: "/next" },
        variant: "primary",
        withIcon: false,
        enabled: true,
      },
    ],
  },
})
// prettier-ignore
// @ts-expect-error A Boolean label is incompatible with ButtonField[].
const wrongCustomButtons = <Buttons fields={wrongCustomButtonFields} fieldPath="primary.actions" ctx={{} as SliceRenderContext} />
void wrongCustomButtons
