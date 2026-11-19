"use server"

import type { HelpChatAnswer, HelpQuestionArgs } from "./help-ai-actions"

// The Help chat's server action, in a module with no runtime imports: the
// browser bundle and every screen that renders the chat get only the action
// reference. The Help runtime loads on the server when a question is asked.

/** Answers a Help question when a local tool answers Help (ADR-0057). */
export async function askHelp(args: HelpQuestionArgs): Promise<HelpChatAnswer> {
  const actions = await import("./help-ai-actions")
  return actions.askHelp(args)
}
