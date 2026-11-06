"use client";

import { useMemo } from "react";

import { keepTurn } from "@/components/docs-assistant";
import { type DocsAssistant, DocsAssistantContext } from "@/components/docs-assistant-context";
import { usePortalSlug } from "@/components/portal-base";

type Tuti = { open: (options: { ask: string | true }) => void };

/** Opens the widget's assistant (Tuti.open({ ask })): now, or once the portal's widget script has loaded. */
function openAssistant(ask: string | true) {
  const tuti = (window as { Tuti?: Tuti }).Tuti;
  if (tuti) {
    tuti.open({ ask });
    return;
  }
  document
    .querySelector("script[data-on-portal]")
    ?.addEventListener("load", () => (window as { Tuti?: Tuti }).Tuti?.open({ ask }), { once: true });
}

/**
 * The portal's Ask AI (the header's search, "Still stuck?", a search's "Ask a follow-up"): the project's widget's assistant,
 * which the portal loads for it (its launcher hidden where the team turned the widget off on the portal). Its panel is on
 * the portal's own address, so it has the reader's sign-in and this tab's conversation. A follow-up keeps the search's
 * answer as the conversation's latest turn (`viewer`'s, signed out: null), for the assistant to go on from.
 */
export function PortalAssistant({ viewer, children }: { viewer: string | null; children: React.ReactNode }) {
  const slug = usePortalSlug();
  const assistant = useMemo<DocsAssistant>(
    () => ({
      ask: (question) => openAssistant(question.trim() || true),
      open: () => openAssistant(true),
      continueWith: (question, answer) => {
        keepTurn(slug, viewer, question, answer);
        openAssistant(true);
      },
    }),
    [slug, viewer],
  );
  return <DocsAssistantContext.Provider value={assistant}>{children}</DocsAssistantContext.Provider>;
}
