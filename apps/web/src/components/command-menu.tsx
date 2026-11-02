"use client";

import {
  BookOpenIcon,
  ContactRoundIcon,
  GitPullRequestIcon,
  HouseIcon,
  InboxIcon,
  LoaderCircleIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  PaintbrushIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { COMMAND_MENU_NAVIGATE, MAX_QUERY, OPEN_COMMAND_MENU } from "@/lib/command-menu-event";
import { cn } from "@/lib/utils";
import { type AppSearchResult, searchApp } from "@/server/app-search";

// The sidebar's icon for each part of the app, so every option says where it leads.
const SECTION_ICONS = {
  home: HouseIcon,
  inbox: MessagesSquareIcon,
  feedback: InboxIcon,
  changelog: MegaphoneIcon,
  docs: BookOpenIcon,
  autopilot: GitPullRequestIcon,
  users: ContactRoundIcon,
  customize: PaintbrushIcon,
  settings: SettingsIcon,
};
type Section = keyof typeof SECTION_ICONS;

/** A page or an action the menu offers, matched by its title as it's typed. */
export type CommandItem = { title: string; group: "Actions" | "Pages" | "Settings"; section: Section; href: string; external?: boolean };

const SEARCH_DELAY_MS = 150;

const KIND: Record<AppSearchResult["kind"], { group: string; section: Section }> = {
  post: { group: "Posts", section: "feedback" },
  conversation: { group: "Conversations", section: "inbox" },
  article: { group: "Docs", section: "docs" },
  collection: { group: "Docs", section: "docs" },
  user: { group: "Users", section: "users" },
};

type Option = { key: string; group: string; title: string; meta?: string; href: string; external?: boolean; section: Section; found?: boolean };

// The last few posts, conversations, articles and users opened from the menu, in this browser, shown before anything is typed.
const RECENT_MAX = 5;
const recentKey = (projectSlug: string) => `tuti:command-menu:recent:${projectSlug}`;
const readRecent = (projectSlug: string): Option[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recentKey(projectSlug)) ?? "[]");
    return Array.isArray(stored) ? stored.filter((option: Option) => typeof option?.href === "string" && Object.hasOwn(SECTION_ICONS, option.section)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
};
const remember = (projectSlug: string, option: Option) => {
  try {
    const recent = [option, ...readRecent(projectSlug).filter((other) => other.href !== option.href)].slice(0, RECENT_MAX);
    localStorage.setItem(recentKey(projectSlug), JSON.stringify(recent));
  } catch {
    // Storage off or full: the menu just doesn't remember.
  }
};

/**
 * ⌘K in the app: jump to a page, a settings page, a post, a conversation, an article or a user by name, or
 * run an action (New article, New changelog entry, New post). `items` are this person's (Settings pages by
 * their role); posts and the rest come from `searchApp`, which finds only what the project's team sees.
 */
export function CommandMenu({ projectSlug, items }: { projectSlug: string; items: CommandItem[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Taken already (in an editor, ⌘K adds a link).
      if (event.defaultPrevented) {
        return;
      }
      // `key` is missing on the keydowns browsers send when they autofill a form.
      if (event.key?.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
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
  const [recent] = useState(() => readRecent(projectSlug));
  const latest = useRef(0);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Searched once typing pauses; answers to older queries are ignored.
  const search = (value: string) => {
    clearTimeout(timer.current);
    const asked = ++latest.current;
    // What was found for an older query goes at once: Enter mustn't open it.
    setFound([]);
    if (value.trim().length < 2) {
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const result = await searchApp(projectSlug, value);
        if (asked === latest.current) {
          setFound(result.results ?? []);
        }
      } catch {
        // Offline, say: nothing found this time; typing again tries again.
      } finally {
        if (asked === latest.current) {
          setSearching(false);
        }
      }
    }, SEARCH_DELAY_MS);
  };

  const q = query.trim().toLowerCase();
  const offered = items
    .filter((item) => !q || item.title.toLowerCase().includes(q) || item.group.toLowerCase().includes(q))
    .map((item) => ({ key: `${item.group}:${item.href}`, group: item.group, title: item.title, href: item.href, external: item.external, section: item.section }));
  // Before anything is typed: the actions, then what was opened lately, then the pages.
  const options: Option[] = [
    ...offered.filter((option) => option.group === "Actions"),
    ...(q ? [] : recent.map((option) => ({ ...option, key: `Recent:${option.href}`, group: "Recent" }))),
    ...offered.filter((option) => option.group !== "Actions"),
    ...found.map((result) => ({ key: `${result.kind}:${result.href}`, group: KIND[result.kind].group, title: result.title, meta: result.meta, href: result.href, section: KIND[result.kind].section, found: true })),
  ];
  const current = Math.min(active, Math.max(options.length - 1, 0));
  // The arrow keys move past the list's fold, and typing or new results replace the list: keep the active option in sight.
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, current, query, found]);

  const go = (option: Option) => {
    onClose();
    if (option.found || option.group === "Recent") {
      // Without its meta: a vote count or "Draft" would go stale.
      remember(projectSlug, { key: option.key, group: option.group, title: option.title, href: option.href, section: option.section });
    }
    if (option.external) {
      window.open(option.href, "_blank", "noopener");
    } else if (window.dispatchEvent(new CustomEvent(COMMAND_MENU_NAVIGATE, { detail: option.href, cancelable: true }))) {
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
          maxLength={MAX_QUERY}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            search(event.target.value);
          }}
          onKeyDown={(event) => {
            // Keys that finish composing text (an input method's Enter) are the input method's.
            if (event.nativeEvent.isComposing) {
              return;
            }
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
        {options.map((option, i) => {
          const Icon = SECTION_ICONS[option.section];
          return (
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
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {/* The meta (an email, say) goes under the title when both don't fit; long ones wrap. */}
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-2">
                  <span className="min-w-0 break-words">{option.title}</span>
                  {option.meta && <span className="min-w-0 text-xs break-all text-muted-foreground">{option.meta}</span>}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </DialogContent>
  );
}
