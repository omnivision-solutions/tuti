"use server";

import type { SpamRuleField, SpamRuleMatcher } from "@/lib/spam-rules";

import type { FormState } from "./form-state";
import { trySpamFilter, updateSpamSettings } from "./operations/spam";
import { asAdmin, call } from "./operations/run";

/** Settings → Spam (see the spam.* operations): the block rules, the allowed list, the guidance and the box to try a message. */

const DENIED = "Only project owners and admins can change the spam filter";

/** Adds a block rule: a field, a matcher and a value. */
export async function addSpamRule(projectSlug: string, rule: { field: string; matcher: string; value: string; appliesTo?: string }): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) =>
    call(updateSpamSettings, context, { addRules: [{ field: String(rule?.field) as SpamRuleField, matcher: String(rule?.matcher) as SpamRuleMatcher, value: String(rule?.value ?? ""), appliesTo: rule?.appliesTo === "strangers" ? "strangers" : "everyone" }] }),
  );
}

/** Removes a block rule by its ID. */
export async function removeSpamRule(projectSlug: string, id: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateSpamSettings, context, { removeRules: [String(id)] }));
}

/** Puts an address or a domain on the allowed list. */
export async function allowSpamSender(projectSlug: string, sender: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateSpamSettings, context, { allow: [String(sender)] }));
}

/** Takes one off the allowed list. */
export async function removeSpamSender(projectSlug: string, sender: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateSpamSettings, context, { remove: [String(sender)] }));
}

/** Sets the team's guidance for the models (empty clears it). */
export async function setSpamGuidance(projectSlug: string, guidance: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(updateSpamSettings, context, { guidance: String(guidance ?? "") }));
}

export type SpamTry = { error?: string; spam?: boolean; aiCheck?: boolean; why?: string };

/** Tries a message against the filter (spam.try): what it would do with it, changing nothing. */
/** "Kim Lee <kim@acme.example>" as its name and address; a bare address as itself. */
function parseFrom(from: string) {
  const named = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(from);
  return named ? { name: named[1]!.trim(), sender: named[2]!.trim() } : { name: "", sender: from.trim() };
}

export async function trySpam(projectSlug: string, message: { from: string; to?: string; subject: string; text: string }): Promise<SpamTry> {
  let result: SpamTry = {};
  const state = await asAdmin(projectSlug, "Only project owners and admins can try the spam filter", async (context) => {
    const { spam, aiCheck, why } = await call(trySpamFilter, context, {
      ...parseFrom(String(message?.from ?? "")),
      to: String(message?.to ?? "").trim() ? [String(message.to).trim()] : [],
      subject: String(message?.subject ?? ""),
      text: String(message?.text ?? ""),
    });
    result = { spam, aiCheck, why };
  });
  return state.error ? state : result;
}
