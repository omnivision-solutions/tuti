"use client";

import { useEffect, useMemo, useRef } from "react";

import { keepTurn } from "@/components/docs-assistant";
import { type DocsAssistant, DocsAssistantContext } from "@/components/docs-assistant-context";
import { usePortalSlug } from "@/components/portal-base";

type Tuti = { open: (options: { ask: string | true; returnFocus?: HTMLElement | null }) => void };

/**
 * The portal's Ask AI (the header's search, "Still stuck?", a search's "Ask a follow-up"): the project's widget's assistant,
 * which the portal loads for it (its launcher hidden where the team turned the widget off on the portal). Its panel is on
 * the portal's own address, so it has the reader's sign-in and this tab's conversation. A follow-up keeps the search's
 * answer as the conversation's latest turn (`viewer`'s, signed out: null), for the assistant to go on from. Closing the
 * panel gives focus back to what opened it, or, from the search dialog (gone by then), to what had it before.
 */
export function PortalAssistant({ viewer, children }: { viewer: string | null; children: React.ReactNode }) {
  const slug = usePortalSlug();
  const outsideDialogs = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const keep = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !event.target.closest('[role="dialog"], #tuti-widget')) {
        outsideDialogs.current = event.target;
      }
    };
    document.addEventListener("focusin", keep);
    return () => document.removeEventListener("focusin", keep);
  }, []);
  const assistant = useMemo<DocsAssistant>(() => {
    const open = (ask: string | true) => {
      const focused = document.activeElement;
      const returnFocus = focused instanceof HTMLElement && !focused.closest('[role="dialog"], #tuti-widget') ? focused : outsideDialogs.current;
      const tuti = (window as { Tuti?: Tuti }).Tuti;
      if (tuti) {
        tuti.open({ ask, returnFocus });
        return;
      }
      // Its script still loading: as soon as it's there.
      document
        .querySelector("script[data-on-portal]")
        ?.addEventListener("load", () => (window as { Tuti?: Tuti }).Tuti?.open({ ask, returnFocus }), { once: true });
    };
    return {
      ask: (question) => open(question.trim() || true),
      open: () => open(true),
      continueWith: (question, answer) => {
        keepTurn(slug, viewer, question, answer);
        open(true);
      },
    };
  }, [slug, viewer]);
  return <DocsAssistantContext.Provider value={assistant}>{children}</DocsAssistantContext.Provider>;
}
