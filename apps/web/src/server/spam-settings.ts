"use server";

import type { FormState } from "./form-state";
import { trySpamFilter, updateSpamSettings } from "./operations/spam";
import { asAdmin, call } from "./operations/run";

/** Settings → Spam (see the spam.* operations): the lists, the phrases and the box to try a message. */

const DENIED = "Only project owners and admins can change the spam filter";

/** Puts an address or a domain on the blocked list (`blocked`) or the allowed one. */
export async function listSpamSender(projectSlug: string, blocked: boolean, sender: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateSpamSettings, context, blocked ? { block: [String(sender)] } : { allow: [String(sender)] }));
}

/** Takes one off whichever list it's on. */
export async function removeSpamSender(projectSlug: string, sender: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateSpamSettings, context, { remove: [String(sender)] }));
}

/** Adds a phrase (`add`) or takes one out. */
export async function setSpamPhrase(projectSlug: string, phrase: string, add: boolean): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateSpamSettings, context, add ? { addPhrases: [String(phrase)] } : { removePhrases: [String(phrase)] }));
}

export type SpamTry = { error?: string; spam?: boolean; why?: string };

/** Tries a message against the filter (spam.try): what it would do with it, changing nothing. */
export async function trySpam(projectSlug: string, message: { sender: string; subject: string; text: string }): Promise<SpamTry> {
  let result: SpamTry = {};
  const state = await asAdmin(projectSlug, "Only project owners and admins can try the spam filter", async (context) => {
    const { spam, why } = await call(trySpamFilter, context, { sender: String(message?.sender ?? ""), subject: String(message?.subject ?? ""), text: String(message?.text ?? "") });
    result = { spam, why };
  });
  return state.error ? state : result;
}
