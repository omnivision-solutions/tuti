"use client";

import { focusClearOfFade, SCROLLING_ROW, showMore, wheelSideways } from "@tuti/ui/scrolling-row";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon, LayoutListIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef } from "react";

import { pillClass } from "@/components/filter-pills";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * A board's switcher (where its rail's boards don't show): a pill named after the board, a menu of Feedback's overview
 * (`allHref`) and every board with its ideas not done yet, the open one marked.
 */
export function BoardSwitcher({
  name,
  nameLang,
  allHref,
  boards,
  className,
}: {
  name: string;
  /** The language its name is in (docs/plan.md L14): the page's where it's translated, else the team's. */
  nameLang?: string;
  allHref: string;
  boards: { name: string; lang?: string; href: string; count: number; current: boolean }[];
  className?: string;
}) {
  const t = useTranslations("feedback");
  const lang = useLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t("boardMenu", { board: name })} className={pillClass(false, className)}>
        <LayoutListIcon aria-hidden />
        <span lang={nameLang} className="truncate">
          {name}
        </span>
        <ChevronDownIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-56">
        <DropdownMenuItem render={<Link href={allHref} />}>
          {t("allBoards")}
        </DropdownMenuItem>
        {boards.map((board) => (
          <DropdownMenuItem key={board.href} render={<Link href={board.href} aria-current={board.current ? "page" : undefined} />}>
            <span lang={board.lang}>{board.name}</span>
            <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">{board.count.toLocaleString(lang)}</span>
            <CheckIcon aria-hidden className={board.current ? "text-primary" : "invisible"} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A board header's pills (the switcher, the sorts, the status menu). Below `lg` they wrap (nothing off-screen); from `lg`
 * one row that scrolls sideways, faded at the end with more, and starts at its start.
 */
export function BoardPillRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = ref.current!;
    const update = () => showMore(row);
    const wheel = wheelSideways(row);
    const observer = new ResizeObserver(update);
    observer.observe(row);
    row.addEventListener("scroll", update, { passive: true });
    // A mouse's wheel scrolls it sideways; a pill reached with Tab comes clear of the fade.
    row.addEventListener("wheel", wheel, { passive: false });
    row.addEventListener("focusin", focusClearOfFade);
    return () => {
      observer.disconnect();
      row.removeEventListener("scroll", update);
      row.removeEventListener("wheel", wheel);
      row.removeEventListener("focusin", focusClearOfFade);
    };
  }, []);
  return (
    <div ref={ref} className={cn("flex items-center gap-x-1.5 gap-y-2 max-lg:flex-wrap max-sm:-mx-4 max-sm:px-4", SCROLLING_ROW)}>
      {children}
    </div>
  );
}
