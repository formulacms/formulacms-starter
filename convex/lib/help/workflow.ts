import { lexer, type Token, type Tokens } from "marked"
import { readInstalledSliceDefinition } from "@/convex/lib/slices"
import { renderTemplate } from "../agents/registry"
import { INSTALLED_SLICE_TYPES } from "../slices"
import { HELP_CORPUS } from "./corpus"
import {
  intentEnumForPrompt,
  parseHelpAnswer,
  type ParsedHelpAnswer,
} from "./intents"

const MAX_HELP_OUTPUT_CHARS = 8_000

// Plain text for the chat. The chat prints the answer as text and must never
// render Markdown: a link inside the answer would be navigation the server did
// not validate. The system prompt asks the model for plain text, but a model
// does not always obey, so the server converts the answer deterministically.
// Built on the `marked` lexer, as convex/lib/richtext/build.ts does. In marked
// 18 the lexer returns unescaped text (an `&` stays `&`, an apostrophe stays
// `'`), so token `text` fields are safe to print as they are. The conversion
// never reorders text.

// `Token` is a union that includes the open-ended `Tokens.Generic`, so a
// property is read only after a guard has proved it is there.
const isList = (token: Token): token is Tokens.List => token.type === "list"
const isTable = (token: Token): token is Tokens.Table => token.type === "table"

/** Child tokens of a token, when it has some. */
function childTokens(token: Token): readonly Token[] | undefined {
  return "tokens" in token && Array.isArray(token.tokens)
    ? token.tokens
    : undefined
}

/** The token's own text, or its source when it has none. */
function textOf(token: Token): string {
  return "text" in token && typeof token.text === "string"
    ? token.text
    : token.raw
}

/** Inline tokens to text. A link keeps its text, never its target. */
function inline(tokens: readonly Token[] | undefined): string {
  if (!tokens) return ""
  let out = ""
  for (const token of tokens) {
    switch (token.type) {
      case "br":
        out += "\n"
        break
      case "image":
      case "codespan":
      case "escape":
      case "html":
        // Image: its alt text. HTML tags and entities stay as typed.
        out += textOf(token)
        break
      default: {
        const children = childTokens(token)
        out += children !== undefined ? inline(children) : textOf(token)
      }
    }
  }
  return out
}

function listText(list: Tokens.List): string {
  let number = typeof list.start === "number" ? list.start : 1
  return list.items
    .map((item) => {
      const marker = list.ordered ? `${number}. ` : "- "
      number += 1
      // The item's children stay in source order; later lines (a nested list,
      // a following paragraph) are indented under the marker.
      const text = blocks(item.tokens).replace(
        /\n(?=[^\n])/g,
        `\n${" ".repeat(marker.length)}`
      )
      return `${marker}${text}`
    })
    .join("\n")
}

function block(token: Token): string | null {
  if (isList(token)) return listText(token)
  if (isTable(token)) {
    return [token.header, ...token.rows]
      .map((row) => row.map((cell) => inline(cell.tokens)).join(" | "))
      .join("\n")
  }
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
      return null
    case "blockquote":
      return blocks(childTokens(token) ?? [])
    case "code":
      return textOf(token)
    default: {
      const children = childTokens(token)
      return children !== undefined ? inline(children) : textOf(token)
    }
  }
}

/** Block tokens to text: blocks stay on their own lines, and a blank line in
 *  the source stays a blank line. */
function blocks(tokens: readonly Token[]): string {
  let out = ""
  let blank = false
  for (const token of tokens) {
    if (token.type === "space") {
      blank = true
      continue
    }
    const text = block(token)
    if (text === null) continue
    if (out) out += blank ? "\n\n" : "\n"
    out += text.replace(/\n+$/, "")
    blank = false
  }
  return out
}

/** Plain text for the chat. Returns the input unchanged if the lexer throws. */
export function toPlainHelpText(text: string): string {
  try {
    return blocks(lexer(text)).trim()
  } catch {
    return text
  }
}

export interface HelpPromptInput {
  question: string
  route?: string
  systemPrompt: string
  userPromptTemplate: string
}

export interface HelpGenerationInput {
  system: string
  prompt: string
  sources: string[]
}

function buildContext(): string {
  const corpus = HELP_CORPUS.map(
    (entry) => `## ${entry.title}\n${entry.body}`
  ).join("\n\n")
  const slices = INSTALLED_SLICE_TYPES.map(
    (type) => `- ${type}: ${readInstalledSliceDefinition(type).aiHint.purpose}`
  ).join("\n")
  return `${corpus}\n\nBlock types currently available:\n${slices}`
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
}

function pickSources(question: string): string[] {
  const questionWords = new Set(tokenize(question))
  if (questionWords.size === 0) return []

  const titles: string[] = []
  for (const entry of HELP_CORPUS) {
    const entryWords = new Set(tokenize([entry.title, ...entry.tags].join(" ")))
    if ([...questionWords].some((word) => entryWords.has(word))) {
      titles.push(entry.title)
    }
  }
  return [...new Set(titles)]
}

export function buildHelpGenerationInput(
  input: HelpPromptInput
): HelpGenerationInput {
  const route = input.route ?? "admin"
  return {
    system: renderTemplate(input.systemPrompt, {
      route,
      intentEnum: intentEnumForPrompt(),
    }),
    prompt: renderTemplate(input.userPromptTemplate, {
      question: input.question.trim(),
      context: buildContext(),
      route,
    }),
    sources: pickSources(input.question),
  }
}

/** Validate and parse the workflow-owned output before it reaches any UI. */
export function parseHelpGenerationOutput(raw: string): ParsedHelpAnswer {
  if (raw.length > MAX_HELP_OUTPUT_CHARS) {
    throw new Error("Help answer is too long.")
  }
  const parsed = parseHelpAnswer(raw)
  // The chat prints text as it is, so strip Markdown the model added anyway.
  const answer = toPlainHelpText(parsed.answer)
  if (!answer.trim()) {
    throw new Error("Help answer is empty.")
  }
  return { ...parsed, answer }
}
