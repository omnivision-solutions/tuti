"use client";

import { createContext, useContext } from "react";

import type { DocsAnswer } from "@/server/operations/docs-ask";

/** The portal's docs assistant (components/docs-assistant.tsx), where AI answers become a conversation. */
export type DocsAssistant = {
  /** Opens the assistant and asks `question`, following up on the conversation in it (`fresh`: a question of its own, as a new message in Messages is). */
  ask: (question: string, options?: { fresh?: boolean }) => void;
  /** Opens it as it was. */
  open: () => void;
  /** Opens it with a question already answered elsewhere (/docs?q=), to follow up on. */
  continueWith: (question: string, answer: DocsAnswer) => void;
};

export const DocsAssistantContext = createContext<DocsAssistant | null>(null);

/**
 * Where the assistant is asked from, for the team's reporting and the reader's cookie: the portal itself where the panel is
 * the portal's own (its page around it on the same origin, as the portal's tag puts it), else the widget on a customer's site.
 */
export function askedFrom(): "portal" | "widget" {
  try {
    return window.parent !== window && window.parent.location.origin === window.location.origin ? "portal" : "widget";
  } catch {
    // Another origin's page around it: reading its address isn't allowed.
    return "widget";
  }
}

/** The assistant, where the portal has one (AI answers on); null elsewhere (the widget). */
export const useDocsAssistant = () => useContext(DocsAssistantContext);
