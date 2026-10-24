"use client";

import { createContext, useContext } from "react";

import type { DocsAnswer } from "@/server/operations/docs-ask";

/** The portal's docs assistant (components/docs-assistant.tsx), where AI answers become a conversation. */
export type DocsAssistant = {
  /** Opens the assistant and asks `question`, following up on the conversation in it. */
  ask: (question: string) => void;
  /** Opens it as it was. */
  open: () => void;
  /** Opens it with a question already answered elsewhere (/docs?q=), to follow up on. */
  continueWith: (question: string, answer: DocsAnswer) => void;
};

export const DocsAssistantContext = createContext<DocsAssistant | null>(null);

/** The assistant, where the portal has one (AI answers on); null elsewhere (the widget). */
export const useDocsAssistant = () => useContext(DocsAssistantContext);
