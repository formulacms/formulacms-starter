# Slice Type reuse triage

Use this review before creating a Slice Type. The shipped catalog contains
examples, not a closed set of allowed designs.

## Reuse only an exact contract

Reuse a registered Slice Type unchanged only when all of these match:

1. the editorial job and meaning;
2. the field structure, optionality, and repetition limits;
3. the intended responsive composition; and
4. the renderer behavior editors are expected to control.

Visual similarity alone is not enough. Do not add fields or conditional modes
to an existing Slice Type merely to absorb a different design.

## Review a presentation when only the renderer differs

An alternative visual composition may retain the exact unchanged editorial
contract. The source authoring classifier calls this `new-presentation` and
names the registered type and current contract digest. That digest identifies
input; it does not prove compatibility or approve a renderer. Classification
writes no fields, defaults, renderer or candidate. Adding even an optional
editorial field requires a new sibling/type.

Production authoring contribution bindings remain null. Local development keeps
the Slice catalog, editor and simulator; candidate preview and acceptance
runtime remains excluded from this distribution. Classification does not enable
candidate tools or grant source acceptance.

## Create a new type when the editorial contract differs

When editorial meaning, fields, optionality or repetition differs, create a new
code-first Slice Type with its own
descriptor, validator, renderer, registry entry, sample, and reviewed tests.
Keep editor-controlled meaning in typed fields and styling choices in tokens or
CSS.

Follow the [content-model authoring guide](content-model-authoring.md) for the
complete generation and verification workflow.
