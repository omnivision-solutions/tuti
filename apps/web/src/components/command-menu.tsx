"use client";

import { FileTextIcon, InboxIcon, LoaderCircleIcon, MessagesSquareIcon, SearchIcon, UserIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { type AppSearchResult, searchApp } from "@/server/app-search";

/** A page or an action the menu offers, matched by its title as it's typed. */
export type CommandItem = { title: string; group: "Pages" | "Settings" | "Actions"; href: string; external?: boolean };

/** Opens the menu from anywhere in the app (the sidebar's Search button): ⌘K / Ctrl K does too. */
export const OPEN_COMMAND_MENU = "tuti:command-menu";

const SEARCH_DELAY_MS = 150;

const KIND: Record<AppSearchResult["kind"], { group: string; icon: LucideIcon }> = {
  post: { group: "Posts", icon: InboxIcon },
  conversation: { group: "Conversations", icon: MessagesSquareIcon },
  article: { group: "Articles", icon: FileTextIcon },
  user: { group: "Users", icon: UserIcon },
};

type Option = { key: string; group: string; title: string; meta?: string; href: string; external?: boolean; icon: LucideIcon };

/**
 * ⌘K in the app: jump to a page, a settings page, a post, a conversation, an article or a user by name, or
 * run an action (New article, Draft release notes, New post). `items` are this person's (Settings pages by
 * their role); posts and the rest come from `searchApp`, which finds only what the project's team sees.
 */
export function CommandMenu({ projectSlug, items }: { projectSlug: string; items: CommandItem[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((was) => !was);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_MENU, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_MENU, onOpen);
    };
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <Menu projectSlug={projectSlug} items={items} onClose={() => setOpen(false)} />}
    </Dialog>
  );
}

function Menu({ projectSlug, items, onClose }: { projectSlug: string; items: CommandItem[]; onClose: () => void }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<AppSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const latest = useRef(0);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Searched once typing pauses; answers to older queries are ignored.
  const search = (value: string) => {
    clearTimeout(timer.current);
    const asked = ++latest.current;
    if (value.trim().length < 2) {
      setFound([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      const result = await searchApp(projectSlug, value);
      if (asked === latest.current) {
        setFound(result.results ?? []);
        setSearching(false);
      }
    }, SEARCH_DELAY_MS);
  };

  const q = query.trim().toLowerCase();
  const options: Option[] = [
    ...items
      .filter((item) => !q || item.title.toLowerCase().includes(q) || item.group.toLowerCase().includes(q))
      .map((item) => ({ key: `${item.group}:${item.href}`, group: item.group, title: item.title, href: item.href, external: item.external, icon: item.group === "Actions" ? ZapIcon : SearchIcon })),
    ...found.map((result) => ({ key: `${result.kind}:${result.href}`, group: KIND[result.kind].group, title: result.title, meta: result.meta, href: result.href, icon: KIND[result.kind].icon })),
  ];
  const current = Math.min(active, Math.max(options.length - 1, 0));

  const go = (option: Option) => {
    onClose();
    if (option.external) {
      window.open(option.href, "_blank", "noopener");
    } else {
      router.push(option.href);
    }
  };

  return (
    <DialogContent showCloseButton={false} className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
      <DialogTitle className="sr-only">Go to or do</DialogTitle>
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={options[current] ? `${listId}-${current}` : undefined}
          aria-label="Search the project"
          placeholder="Search posts, conversations, articles, users, settings…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            search(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current + 1) % Math.max(options.length, 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current - 1 + options.length) % Math.max(options.length, 1));
            } else if (event.key === "Enter" && options[current]) {
              event.preventDefault();
              go(options[current]);
            }
          }}
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {searching && <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>
      <ul id={listId} role="listbox" aria-label="Results" className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1">
        {options.length === 0 && !searching && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query.trim()}”.</li>}
        {options.map((option, i) => (
          <li key={option.key} role="presentation">
            {(i === 0 || options[i - 1]!.group !== option.group) && (
              <div role="presentation" className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {option.group}
              </div>
            )}
            <div
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              onMouseMove={() => setActive(i)}
              onClick={() => go(option)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", i === current && "bg-muted")}
            >
              <option.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{option.title}</span>
              {option.meta && <span className="shrink-0 text-xs text-muted-foreground">{option.meta}</span>}
            </div>
          </li>
        ))}
      </ul>
    </DialogContent>
  );
}
