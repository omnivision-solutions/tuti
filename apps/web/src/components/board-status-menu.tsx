"use client";

import type { PostStatus } from "@tuti/db";
import { CheckIcon, ChevronDownIcon, ListFilterIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";

import { STATUS_ICONS, STATUS_TEXT } from "@/components/post-status-badge";
import { pillClass } from "@/components/filter-pills";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type StatusChoice = { label: string; count: number; href: string; status?: PostStatus; current: boolean; group: number };

/**
 * A board's status filter: a pill with a menu at the end of its sort row (what the list shows and how many), a menu of
 * links with each status's count (the ideas not done yet, each status that has any, every idea). `choices` in order;
 * a line between groups. `counted`: the button and the menu say how many too (not under a search or Mine, whose lists
 * aren't the board's counts).
 */
export function BoardStatusMenu({ choices, counted }: { choices: StatusChoice[]; counted: boolean }) {
  const current = choices.find((choice) => choice.current) ?? choices[0]!;
  const Icon = current.status ? STATUS_ICONS[current.status] : ListFilterIcon;
  const t = useTranslations("feedback");
  const lang = useLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={counted ? t("statusMenuCounted", { status: current.label, count: current.count }) : t("statusMenu", { status: current.label })}
        className={pillClass(false, "aria-expanded:bg-muted aria-expanded:text-foreground")}
      >
        <Icon aria-hidden className={cn(current.status && STATUS_TEXT[current.status])} />
        {current.label}
        {counted && <span className="tabular-nums">{current.count.toLocaleString(lang)}</span>}
        <ChevronDownIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-56 whitespace-nowrap">
        {choices.map((choice, i) => {
          const ChoiceIcon = choice.status ? STATUS_ICONS[choice.status] : ListFilterIcon;
          return (
            <Fragment key={choice.href}>
              {i > 0 && choice.group !== choices[i - 1]!.group && <DropdownMenuSeparator />}
              <DropdownMenuItem render={<Link href={choice.href} scroll={false} aria-current={choice.current ? "true" : undefined} />}>
                <ChoiceIcon aria-hidden className={cn(choice.status ? STATUS_TEXT[choice.status] : "text-muted-foreground")} />
                {choice.label}
                <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">{counted && choice.count.toLocaleString(lang)}</span>
                <CheckIcon aria-hidden className={choice.current ? "text-primary" : "invisible"} />
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
