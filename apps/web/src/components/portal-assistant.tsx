"use client";

import { useEffect, useMemo, useRef } from "react";

import { type DocsAssistant, DocsAssistantContext } from "@/components/docs-assistant-context";
import { usePortalHref } from "@/components/portal-base";
import type { DocsAnswer } from "@/server/operations/docs-ask";

type Turn = { question: string; answer: DocsAnswer };
type Tuti = { open: (options: { ask: string | true; turn?: Turn; returnFocus?: HTMLElement | null }) => void };

/**
 * The portal's Ask AI (the header's search, "Still stuck?", a search's "Ask a follow-up"): the project's widget's assistant,
 * which the portal loads for it (its launcher hidden where the team turned the widget off on the portal). Its panel is on
 * the portal's own address, so it has the reader's sign-in and this tab's conversation. A follow-up hands it the search's
 * question and answer, for the assistant to go on from. Closing the
 * panel gives focus back to what opened it, or, from the search dialog (gone by then), to what had it before.
 */
export function PortalAssistant({ children }: { children: React.ReactNode }) {
  const at = usePortalHref();
  const outsideDialogs = useRef<HTMLElement | null>(null);
  // An ask still waiting for the widget: only the latest one waits.
  const waiting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    // `stay`: without the widget, nowhere else to go (a search's follow-up: the reader is on the search, with its answer).
    const open = (ask: string | true, stay = false, turn?: Turn) => {
      const focused = document.activeElement;
      const returnFocus = focused instanceof HTMLElement && !focused.closest('[role="dialog"], #tuti-widget') ? focused : outsideDialogs.current;
      const since = Date.now();
      const from = window.location.href;
      clearTimeout(waiting.current);
      const attempt = () => {
        const tuti = (window as { Tuti?: Tuti }).Tuti;
        if (tuti) {
          tuti.open({ ask, turn, returnFocus });
          return;
        }
        // Its script maybe still loading (the page's load waits for it), or done already (loaded or failed, its events
        // gone by): looked for again until it's there, the page has loaded, or 5 seconds have passed.
        if (document.querySelector("script[data-on-portal]") && document.readyState !== "complete" && Date.now() - since < 5_000) {
          waiting.current = setTimeout(attempt, 100);
          return;
        }
        // No widget after all (its script failed, or an older copy took the page): the docs' search, with its AI answer;
        // not if the reader has gone on to another page meanwhile.
        if (stay || window.location.href !== from) {
          return;
        }
        window.location.assign(at(ask === true ? "/docs" : `/docs?${new URLSearchParams({ q: ask })}`));
      };
      attempt();
    };
    return {
      ask: (question) => open(question.trim() || true),
      open: () => open(true),
      continueWith: (question, answer) => open(true, true, { question, answer }),
    };
  }, [at]);
  return <DocsAssistantContext.Provider value={assistant}>{children}</DocsAssistantContext.Provider>;
}
