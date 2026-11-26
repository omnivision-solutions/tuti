"use client";

import type { Messages } from "@tuti/shared/messages";
import { type MessageKeys, type NestedKeyOf, useTranslations } from "next-intl";

export type MessageKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

/**
 * One of the portal's messages (`id`, "feedback.sample"), in the page's language, for server components
 * shared with the app and the widget (StatusLabel, CommentList): they can't use next-intl's hooks, and outside the portal
 * the root layout's English provider answers.
 */
export function T({ id, values }: { id: MessageKey; values?: Record<string, string | number> }) {
  const t = useTranslations();
  // ponytail: values typed loosely; next-intl checks the message's own arguments where the hooks are used directly.
  return t(id, values as never);
}
