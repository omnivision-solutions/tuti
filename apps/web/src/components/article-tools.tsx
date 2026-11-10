"use client";

import { cn } from "cn";

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
      <div className="docs-tools-heading flex items-center justify-between p-[20px_18px_10px] [&_h2]:[font:600_17px_var(--font-sans)]">
        {desktop ? <h2>{active}</h2> : <SheetTitle tabIndex={-1} className="outline-none">{active === "Settings" ? "Article settings" : active}</SheetTitle>}
        <Button variant="ghost" size="icon-sm" aria-label="Collapse article tools" title="Collapse article tools" onClick={() => select(null)}>
          <PanelRightCloseIcon />
        </Button>
      </div>
      <nav aria-label="Article tool panels" className={cn(
        "docs-tool-tabs flex gap-0.5 p-[0_12px_12px] [&_button]:gap-1.25 [&_button]:h-7.5 [&_button]:p-[0_7px] [&_button]:text-[13px]",
        "[&_button]:text-muted-foreground [&_button]:rounded-none [&_button]:[border-bottom:2px_solid_transparent] [&_button]:pb-1.5",
        "[&_button[aria-pressed='true']]:bg-transparent [&_button[aria-pressed='true']]:text-primary",
        "[&_button[aria-pressed='true']]:border-b-primary [&_svg]:w-3.75 [&_svg]:h-3.75",
      )}>
        {Object.entries(TOOLS).map(([name, Icon]) => (
          <Button key={name} variant="ghost" size="sm" aria-pressed={active === name} onClick={() => select(name as Tool)}>
            <Icon />
            {name}
          </Button>
        ))}
      </nav>
      <div className={cn(
        "docs-tools-scroll min-h-0 flex-1 overflow-auto p-[0_18px_24px] [scrollbar-width:thin] [&_>_[data-slot='card']]:p-[0_0_18px]",
        "[&_>_[data-slot='card']]:gap-3.5 [&_>_[data-slot='card']]:border-0 [&_>_[data-slot='card']]:rounded-none",
        "[&_>_[data-slot='card']]:shadow-none [&_>_[data-slot='card']]:ring-0 [&_>_[data-slot='card']]:bg-transparent [&_>_[data-slot='card']]:overflow-visible",
        "[&_[data-slot='card']]:p-[0_0_18px] [&_[data-slot='card']]:gap-3.5 [&_[data-slot='card']]:border-0 [&_[data-slot='card']]:rounded-none",
        "[&_[data-slot='card']]:shadow-none [&_[data-slot='card']]:ring-0 [&_[data-slot='card']]:bg-transparent [&_[data-slot='card']]:overflow-visible",
        "[&_[data-slot='card-header']]:p-0 [&_[data-slot='card-header']]:flex [&_[data-slot='card-header']]:flex-col",
        "[&_[data-slot='card-header']]:items-start [&_[data-slot='card-content']]:p-0 [&_[data-slot='card-title']]:text-[15px]",
        "[&_[data-slot='card-description']]:text-[13px] [&_fieldset_>_label]:border-0 [&_fieldset_>_label]:p-[4px_0]",
        "[&_fieldset_>_label]:bg-transparent [&_[data-slot='field-label']]:text-[13px] [&_form]:text-[13px] [&_[aria-label='Versions']]:gap-1",
        "[&_[aria-label='Versions']_li]:pb-1.5 [&_[aria-label='Versions']_[data-slot='avatar']]:w-6.5",
        "[&_[aria-label='Versions']_[data-slot='avatar']]:h-6.5 [&_[aria-label='Versions']_[data-slot='avatar']]:z-[1]",
        "[&_[aria-label='Versions']_[data-slot='badge']]:text-[12px] [&_[aria-label='Versions']_>_li]:relative",
        "[&_[aria-label='Versions']_>_li]:pb-4.25 [&_[aria-label='Versions']_>_li:not(:last-child)::before]:[content:'']",
        "[&_[aria-label='Versions']_>_li:not(:last-child)::before]:absolute [&_[aria-label='Versions']_>_li:not(:last-child)::before]:top-9.5",
        "[&_[aria-label='Versions']_>_li:not(:last-child)::before]:bottom-0 [&_[aria-label='Versions']_>_li:not(:last-child)::before]:left-3.25",
        "[&_[aria-label='Versions']_>_li:not(:last-child)::before]:border-l",
        "[&_[aria-label='Versions']_>_li:not(:last-child)::before]:border-border [&_[aria-label='Versions']_a[aria-current]]:text-foreground",
        "[&_[aria-label='Versions']_a_>_span:last-child_>_span:first-child]:font-semibold",
      )}>
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
      <div className="docs-editor-layout flex gap-3 min-w-0 h-full flex-1" data-tools-open={Boolean(active && desktop)}>
        {children}
        {desktop ? (
          active && (
            <aside aria-label="Article tools" className="docs-tools docs-surface relative shrink-0 w-82.5 flex flex-col overflow-hidden max-xl:w-75 min-w-0 min-h-0 rounded-[14px] bg-docs-surface shadow-[0_1px_3px_color-mix(in_oklch,_var(--foreground)_3.5%,_transparent),_0_0_0_1px_var(--docs-edge)]">
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
            <SheetContent initialFocus={() => document.querySelector<HTMLElement>(".docs-tools-sheet [data-slot=sheet-title]")} overlayClassName="bg-(--docs-overlay) supports-backdrop-filter:backdrop-blur-none" side="bottom" showCloseButton={false} className={cn(
              "docs-tools-sheet [inset:auto_8px_8px]! h-[min(72dvh,_720px)]! max-h-[85dvh] border border-border rounded-[16px] gap-0 bg-docs-surface",
              "[&::before]:[content:''] [&::before]:shrink-0 [&::before]:w-8 [&::before]:h-1 [&::before]:rounded-[4px] [&::before]:bg-input",
              "[&::before]:m-[8px_auto_0] [&[data-tool='History']]:top-59.5! [&[data-tool='History']]:h-auto! [&[data-tool='Verify']]:top-49.75!",
              "[&[data-tool='Verify']]:h-auto! [&_.docs-tools-heading]:pt-2.25 [&_.docs-tools-heading]:pb-1.5 [&_.docs-tool-tabs]:pb-2.25",
              "[&_.docs-tools-scroll]:p-[2px_20px_20px]",
              "[&_.docs-tools-scroll_[aria-label='Versions']_a_>_span:last-child_>_span:first-child]:text-[13px]",
              "[&_.docs-tools-scroll_[aria-label='Versions']_a_>_span:last-child_>_span:last-child]:text-[11.5px]",
              "[&_.docs-version-diff_[data-slot='button']]:h-6.75 [&_.docs-version-diff_[data-slot='button']]:text-[11.5px]",
              "[&_.docs-verify-again]:top-5.5 [&_.docs-version-diff_button]:h-6.75 [&_.docs-version-diff_button]:text-[11.5px]",
            )} data-tool={active}>
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
    <div data-article-tools role="toolbar" aria-label="Article tools" className="docs-tool-icons flex gap-0.75 ml-auto [&[data-open='true']]:hidden max-lg:[&[data-open='true']]:flex max-sm:gap-0" data-open={Boolean(tools.active)}>
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
