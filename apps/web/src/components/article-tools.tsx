"use client";

import { HistoryIcon, PanelRightCloseIcon, SettingsIcon, ShieldCheckIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from "react";

import { ARTICLE_SENTENCE_JUMP, focusArticleSentence } from "@/components/article-sentence-jump";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

const TOOLS = {
  Settings: SettingsIcon,
  History: HistoryIcon,
  Verify: ShieldCheckIcon,
};
type Tool = keyof typeof TOOLS;
const ToolsContext = createContext<{
  active: Tool | null;
  select: (tool: Tool | null) => void;
} | null>(null);
const subscribe = (changed: () => void) => {
  const query = matchMedia("(min-width: 1024px)");
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};

/** One card beside the article; on phones the same tools open in a sheet. Query links remain shareable. */
export function ArticleTools({
  children,
  settings,
  history,
  verify,
  historyNote,
}: {
  children: ReactNode;
  settings: ReactNode;
  history: ReactNode;
  verify: ReactNode;
  historyNote: string;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const desktop = useSyncExternalStore(
    subscribe,
    () => matchMedia("(min-width: 1024px)").matches,
    () => true,
  );
  const active = search.has("history") ? "History" : search.has("verify") ? "Verify" : search.has("settings") ? "Settings" : null;
  const restoreFocus = useRef<Tool | null>(null);
  const jumpAfterClose = useRef<string | null>(null);
  const select = (tool: Tool | null) => {
    if (!tool) restoreFocus.current = active;
    const next = new URLSearchParams(search);
    for (const key of ["settings", "history", "verify", "revision"]) next.delete(key);
    if (tool) next.set(tool.toLowerCase(), "");
    router.replace(`${pathname}${next.size ? `?${next.toString().replace(/(settings|history|verify)=(?=&|$)/g, "$1")}` : ""}`, { scroll: false });
  };
  useEffect(() => {
    if (!active && restoreFocus.current) {
      document.querySelector<HTMLButtonElement>(`[data-article-tools] button[aria-label="${restoreFocus.current}"]`)?.focus();
      restoreFocus.current = null;
    }
  }, [active]);
  useEffect(() => {
    if (!desktop || !active) return;
    const escape = (event: KeyboardEvent) => {
      const overlayOpen = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="listbox"]')).some(
        (overlay) => overlay.getClientRects().length > 0,
      );
      if (event.key === "Escape" && !overlayOpen) select(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  useEffect(() => {
    if (desktop || !active) return;
    const jump = (event: Event) => {
      event.preventDefault();
      jumpAfterClose.current = (event as CustomEvent<string>).detail;
      select(null);
      restoreFocus.current = null;
    };
    window.addEventListener(ARTICLE_SENTENCE_JUMP, jump);
    return () => window.removeEventListener(ARTICLE_SENTENCE_JUMP, jump);
  });
  const content = active && (
    <>
      <div className="docs-tools-heading">
        {desktop ? <h2>{active}</h2> : <SheetTitle>{active === "Settings" ? "Article settings" : active}</SheetTitle>}
        <Button variant="ghost" size="icon-sm" aria-label="Collapse article tools" title="Collapse article tools" onClick={() => select(null)}>
          <PanelRightCloseIcon />
        </Button>
      </div>
      <nav aria-label="Article tool panels" className="docs-tool-tabs">
        {Object.entries(TOOLS).map(([name, Icon]) => (
          <Button key={name} variant="ghost" size="sm" aria-pressed={active === name} onClick={() => select(name as Tool)}>
            <Icon />
            {name}
          </Button>
        ))}
      </nav>
      <div className="docs-tools-scroll">
        {active === "Settings" ? (
          <section aria-label="Article settings">{settings}</section>
        ) : active === "History" ? (
          <>
            <p className="mb-4 text-xs text-muted-foreground">{historyNote}</p>
            {history}
          </>
        ) : (
          verify
        )}
      </div>
    </>
  );
  return (
    <ToolsContext value={{ active, select }}>
      <div className="docs-editor-layout" data-tools-open={Boolean(active && desktop)}>
        {children}
        {desktop ? (
          active && (
            <aside aria-label="Article tools" className="docs-tools docs-surface">
              {content}
            </aside>
          )
        ) : (
          <Sheet
            onOpenChangeComplete={(open) => {
              if (!open && jumpAfterClose.current) {
                focusArticleSentence(jumpAfterClose.current);
                jumpAfterClose.current = null;
              }
            }}
            open={Boolean(active)}
            onOpenChange={(open) => !open && select(null)}
          >
            <SheetContent side="bottom" showCloseButton={false} className="docs-tools-sheet" data-tool={active}>
              {content}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </ToolsContext>
  );
}

/** In the formatting row only while the card is closed, so all the room returns to the text. */
export function ArticleToolButtons() {
  const tools = useContext(ToolsContext);
  if (!tools) return null;
  return (
    <div data-article-tools role="toolbar" aria-label="Article tools" className="docs-tool-icons" data-open={Boolean(tools.active)}>
      {Object.entries(TOOLS).map(([name, Icon]) => (
        <Button
          key={name}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={name}
          title={name}
          aria-expanded={tools.active === name}
          onClick={() => tools.select(name as Tool)}
        >
          <Icon />
        </Button>
      ))}
    </div>
  );
}
