"use client";

import { cn } from "cn";
import { EyeIcon, EyeOffIcon, RefreshCwIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { useDocsMoreFocus } from "@/components/docs-page-header";
import { FilterPills } from "@/components/filter-pills";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  deleteApiReference,
  markApiReferenceSeen,
  replaceApiReferenceSpec,
  setApiReferencePublished,
  setApiReferenceShown,
  syncApiReferenceNow,
} from "@/server/api-references";

/** An API reference's page in the app (docs/plan.md, A8): its header's actions and its Endpoints. */

type Group = { key: string; name: string; description: string; onHelpCenter: boolean };
type Operation = {
  key: string;
  slug: string;
  title: string;
  kind: string;
  path: string;
  group: string;
  alsoIn: string[];
  deprecated: boolean;
  /** Switched off itself; it's off the help center too while a group it's in is. */
  hidden: boolean;
  new: boolean;
};

/** A method's colour, in the app's tokens for the hues the help center's pages use (portal-api-operation.tsx): GET blue, POST green, PUT and PATCH amber, DELETE red; the rest (GraphQL's kinds too) muted. */
const METHOD_COLOURS: Record<string, string> = {
  GET: "text-kind-progress",
  POST: "text-kind-new",
  PUT: "text-kind-edit",
  PATCH: "text-kind-edit",
  DELETE: "text-destructive-foreground",
};

const SAVE_FAILED = { error: "Couldn't save that. Try again." };

/** The row of tabs under the page's header: Endpoints (with how many) and Settings. */
export function ApiReferenceTabs({ projectSlug, slug, endpoints }: { projectSlug: string; slug: string; endpoints: number }) {
  const base = `/app/${projectSlug}/docs/references/${slug}`;
  return (
    <FilterPills
      label="API reference"
      items={[
        { title: "Endpoints", href: base, count: endpoints },
        { title: "Settings", href: `${base}/settings` },
      ]}
    />
  );
}

/** What a new read of the spec did, for its toast: how many operations it added and removed, else whether anything changed. */
const toastChanges = (result: { added?: number; removed?: number; changed?: boolean }) =>
  toast.success([result.added && `${result.added} added`, result.removed && `${result.removed} removed`].filter(Boolean).join(", ") || (result.changed ? "Updated" : "No changes"));

/** The header's Sync now, where focus goes when the failed sync's banner (and its own Sync now) goes. */
const HEADER_SYNC = "api-reference-sync-now";

/**
 * "Sync now": a URL's or a repository's reference read again. A failed read says why in a toast, and the page's banner keeps saying it.
 * The banner's (`compact`) goes once a sync works: focus moves to the header's first, so it isn't lost. In the header
 * its words go in a narrow pane; elsewhere (the banner, Settings' Source) they stay.
 */
export function SyncNow({ projectSlug, slug, compact, inHeader }: { projectSlug: string; slug: string; compact?: boolean; inHeader?: boolean }) {
  const [pending, startTransition] = useTransition();
  const sync = () =>
    startTransition(async () => {
      const result = await syncApiReferenceNow(projectSlug, slug).catch(() => ({ error: "Couldn't sync. Try again." }) as Awaited<ReturnType<typeof syncApiReferenceNow>>);
      if (result.error) {
        toast.error(result.error);
      } else {
        if (compact) document.getElementById(HEADER_SYNC)?.focus();
        toastChanges(result);
      }
    });
  return (
    <Button
      id={inHeader ? HEADER_SYNC : undefined}
      type="button"
      variant="outline"
      size={compact ? "sm" : "default"}
      disabled={pending}
      focusableWhenDisabled
      onClick={sync}
      className={cn(inHeader && "@max-[44rem]/docs-page:w-8 @max-[44rem]/docs-page:px-0")}
    >
      <RefreshCwIcon className={cn(pending && "animate-spin")} />
      <span className={cn(inHeader && "@max-[44rem]/docs-page:sr-only")}>{pending ? "Syncing…" : "Sync now"}</span>
    </Button>
  );
}

/**
 * The header's button that reads the spec again. An uploaded file's is "Upload new version": pick the file, and the toast
 * says what it added and removed. A URL's or a repository's is "Sync now", read from where it lives.
 */
export function ApiReferenceSync({
  projectSlug,
  slug,
  source,
  maxBytes,
  inHeader = true,
}: {
  projectSlug: string;
  slug: string;
  source: string;
  maxBytes: number;
  /** In the page's header its words go in a narrow pane; elsewhere (Settings' Source) they stay. */
  inHeader?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  if (source === "url" || source === "github") {
    return <SyncNow projectSlug={projectSlug} slug={slug} inHeader={inHeader} />;
  }
  if (source !== "upload") {
    return null;
  }
  const upload = (file: File) => {
    if (file.size > maxBytes) {
      toast.error("This file is over 5 MB, the most an API reference reads.");
      return;
    }
    const data = new FormData();
    data.set("spec", file);
    startTransition(async () => {
      const result = await replaceApiReferenceSpec(projectSlug, slug, data).catch(() => ({ error: "Couldn't upload that file. Try again." }) as Awaited<ReturnType<typeof replaceApiReferenceSpec>>);
      if (result.error) {
        toast.error(result.error);
      } else {
        toastChanges(result);
      }
    });
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        aria-label="New version of the spec"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // The same file picked again is a change too.
          event.currentTarget.value = "";
          if (file) upload(file);
        }}
      />
      <Button type="button" variant="outline" disabled={pending} focusableWhenDisabled onClick={() => input.current?.click()} className={cn(inHeader && "@max-[44rem]/docs-page:w-8 @max-[44rem]/docs-page:px-0")}>
        <UploadIcon />
        <span className={cn(inHeader && "@max-[44rem]/docs-page:sr-only")}>Upload new version</span>
      </Button>
    </>
  );
}

/** A URL's last sync failed: why, and when one last worked (the pages are as that one left them), with Sync now. */
export function ApiReferenceSyncError({ projectSlug, slug, error, lastSynced }: { projectSlug: string; slug: string; error: string; lastSynced: string }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-3.5 py-2.5 text-sm">
      <p className="min-w-0 flex-1 basis-64">
        <span className="font-medium">Sync failed.</span> {error} <span className="text-muted-foreground">Last synced {lastSynced}: the pages are as it left them.</span>
      </p>
      <SyncNow projectSlug={projectSlug} slug={slug} compact />
    </div>
  );
}

/** Under the header's More actions: "Unpublish" or "Publish", and "Delete" (the page then goes back to Docs: there's no reference to show). */
export function ApiReferenceMore({ projectSlug, slug, name, published }: { projectSlug: string; slug: string; name: string; published: boolean }) {
  const moreFocus = useDocsMoreFocus();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const run = (action: () => Promise<{ error?: string }>, done: string) =>
    startTransition(async () => {
      const result = await action().catch(() => SAVE_FAILED);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(done);
      }
    });
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <DropdownMenuItem disabled={pending} onClick={() => run(() => setApiReferencePublished(projectSlug, slug, !published), published ? `${name} unpublished` : `${name} published`)}>
        {published ? <EyeOffIcon /> : <EyeIcon />}
        {published ? "Unpublish" : "Publish"}
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" disabled={pending} onClick={() => setOpen(true)}>
        <Trash2Icon />
        Delete
      </DropdownMenuItem>
      <AlertDialogContent closeDisabled={pending} finalFocus={moreFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>Its pages leave the help center, and what you switched off here is forgotten. This can’t be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} focusableWhenDisabled onClick={() => run(() => deleteApiReference(projectSlug, slug), `${name} deleted`)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Endpoints: each group and its operations, with a switch for the help center that saves at once. What a new spec added
 * is New for this visit: opening the page marks it seen, so it's gone on the next one, not while the team looks.
 */
export function ApiReferenceEndpoints({
  projectSlug,
  slug,
  state,
  published,
  groups,
  operations,
  unreadable,
}: {
  projectSlug: string;
  slug: string;
  /** Its Draft or Published badge. */
  state: ReactNode;
  /** A draft has nothing on the help center yet: its count says what will be. */
  published: boolean;
  /** In the team's order. */
  groups: Group[];
  operations: Operation[];
  /** How many things the reader couldn't read. */
  unreadable: number;
}) {
  // Switches clicked, over what the page was given, until a page drawn after their save. A save answers before the page
  // it brings is drawn: dropped then, a switch would show the old page meanwhile (a group back on, its switches live).
  // `page`: the page drawn as the save answered; the next one is as saved (or as a teammate changed it since).
  const [clicked, setClicked] = useState<Record<string, { on: boolean; saved?: boolean; page?: Group[] }>>({});
  const [query, setQuery] = useState("");
  const onPage = new Map<string, boolean>([
    ...groups.map((group) => [`group ${group.key}`, group.onHelpCenter] as const),
    ...operations.map((operation) => [`operation ${operation.key}`, !operation.hidden] as const),
  ]);
  const saved = Object.entries(clicked).filter(([, choice]) => choice.saved);
  const caughtUp = saved.filter(([id, choice]) => (choice.page && choice.page !== groups) || (onPage.get(id) ?? choice.on) === choice.on).map(([id]) => id);
  if (caughtUp.length > 0 || saved.some(([, choice]) => !choice.page)) {
    setClicked((now) =>
      Object.fromEntries(
        Object.entries(now)
          .filter(([id]) => !caughtUp.includes(id))
          .map(([id, choice]) => [id, choice.saved && !choice.page ? { ...choice, page: groups } : choice]),
      ),
    );
  }
  const groupOn = (group: Group) => clicked[`group ${group.key}`]?.on ?? group.onHelpCenter;
  const offGroups = new Set(groups.filter((group) => !groupOn(group)).map((group) => group.key));
  /** The group that keeps it off the help center, if one of its groups is off. */
  const offGroupOf = (operation: Operation) => groups.find((group) => offGroups.has(group.key) && [operation.group, ...operation.alsoIn].includes(group.key));
  const inOffGroup = (operation: Operation) => offGroupOf(operation) !== undefined;
  const ownOn = (operation: Operation) => clicked[`operation ${operation.key}`]?.on ?? !operation.hidden;
  const shown = (operation: Operation) => ownOn(operation) && !inOffGroup(operation);

  // What's New this visit, each with whether it arrived off the help center: kept while the page is open, though marked seen.
  const [fresh, setFresh] = useState(() => new Map<string, boolean>());
  const arrived = operations.filter((operation) => operation.new && !fresh.has(operation.key));
  if (arrived.length > 0) {
    setFresh(new Map([...fresh, ...arrived.map((operation) => [operation.key, !shown(operation)] as const)]));
  }
  // Seen: the ones this page shows, by their keys (what a teammate's upload adds meanwhile is still new). As text, so the effect runs when they change.
  const unseen = JSON.stringify(operations.filter((operation) => operation.new).map((operation) => operation.key));
  useEffect(() => {
    if (unseen !== "[]") {
      // Not saved: they're New again on the next visit.
      void markApiReferenceSeen(projectSlug, slug, JSON.parse(unseen) as string[]).catch(() => undefined);
    }
  }, [unseen, projectSlug, slug]);

  // Each switch's saves, one after another, and how often it was clicked: the last click is what's saved, whatever order
  // the answers would have come in, and its choice shows until that save has answered.
  const saves = useRef(new Map<string, { last: Promise<void>; clicks: number }>());
  const change = (what: "operation" | "group", key: string, on: boolean) => {
    const id = `${what} ${key}`;
    setClicked((now) => ({ ...now, [id]: { on } }));
    const queue = saves.current.get(id) ?? { last: Promise.resolve(), clicks: 0 };
    saves.current.set(id, queue);
    const click = ++queue.clicks;
    queue.last = queue.last.then(async () => {
      // Clicked again while the save before was on its way: that click's save is the one to send.
      if (queue.clicks !== click) return;
      const result = await setApiReferenceShown(projectSlug, slug, what, key, on).catch(() => SAVE_FAILED);
      if (result.error) {
        toast.error(result.error);
      }
      if (queue.clicks !== click) return;
      // Saved: kept until the page has it. Refused: back as it was.
      setClicked((now) => {
        const rest = { ...now };
        if (result.error) {
          delete rest[id];
        } else {
          rest[id] = { on, saved: true };
        }
        return rest;
      });
    });
  };

  const addedHidden = operations.filter((operation) => fresh.get(operation.key) && !shown(operation));
  // Only while its box is there: a new version with fewer operations takes the box away.
  const words = operations.length > 20 ? query.trim().toLowerCase() : "";
  const matches = (operation: Operation) => !words || operation.path.toLowerCase().includes(words) || operation.title.toLowerCase().includes(words);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
        {state}
        <span>
          {operations.filter(shown).length} of {operations.length} on the help center{!published && " when published"}
        </span>
        {unreadable > 0 && <span>{unreadable === 1 ? "1 thing couldn’t be read" : `${unreadable} things couldn’t be read`}</span>}
      </div>
      {addedHidden[0] && (
        <p role="status" className="rounded-lg bg-highlight px-3.5 py-2.5 text-sm text-highlight-foreground">
          {addedHidden.length === 1 ? "1 new endpoint was added hidden." : `${addedHidden.length} new endpoints were added hidden.`}{" "}
          {/* Its row is in the list: not filtered out by a search. */}
          <a href={`#endpoint-${addedHidden[0].slug}`} onClick={() => setQuery("")} className="font-medium underline underline-offset-2">
            {addedHidden.length === 1 ? "Review it below." : "Review them below."}
          </a>
        </p>
      )}
      {operations.length > 20 && <Input type="search" aria-label="Search endpoints" placeholder="Search endpoints" value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="max-w-sm" />}
      {/* Always there with the search, so a screen reader hears it fill. */}
      {operations.length > 20 && (
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {words && !operations.some(matches) && `No endpoints match “${query.trim()}”.`}
        </p>
      )}
      {groups.map((group) => {
        const rows = operations.filter((operation) => operation.group === group.key && matches(operation));
        // Without rows of its own it's still a group with a switch: one that's only an operation's second tag takes that operation off too.
        if (rows.length === 0 && (words || !operations.some((operation) => operation.alsoIn.includes(group.key)))) return null;
        const description = group.description.trim().split("\n")[0];
        return (
          <section key={group.key} aria-label={group.name}>
            <div className="flex items-center gap-3 border-b pb-2.5">
              <div className="min-w-0 flex-1">
                <h2 className="font-heading text-base font-semibold break-words">{group.name}</h2>
                {description && <p className="truncate text-sm text-muted-foreground">{description}</p>}
              </div>
              <Switch aria-label={`${group.name}: on the help center`} checked={groupOn(group)} onChange={(event) => change("group", group.key, event.currentTarget.checked)} />
            </div>
            <ul hidden={rows.length === 0}>
              {rows.map((operation) => (
                <li key={operation.key} id={`endpoint-${operation.slug}`} className="flex items-center gap-3 border-b py-2.5 last:border-b-0">
                  {/* A narrow pane: the method and path on one line, the title under them, the switch at the right. */}
                  <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="flex min-w-0 items-baseline gap-2 @max-[36rem]/docs-page:basis-full">
                      <span className={cn("min-w-13 shrink-0 font-mono text-xs font-semibold", METHOD_COLOURS[operation.kind] ?? "text-muted-foreground")}>{operation.kind}</span>
                      <code className="min-w-0 font-mono text-[13px] break-all">{operation.path}</code>
                    </span>
                    <span className="min-w-0 text-sm break-words text-muted-foreground">{operation.title}</span>
                    {operation.deprecated && <Badge variant="outline">Deprecated</Badge>}
                    {fresh.has(operation.key) && <Badge variant="highlight">New</Badge>}
                    {offGroupOf(operation) && (
                      <span id={`off-endpoint-${operation.slug}`} className="basis-full text-xs text-muted-foreground">
                        Off while {offGroupOf(operation)?.name} is off
                      </span>
                    )}
                  </div>
                  {/* Greyed while a group it's in is off, with the reason in the row: its own choice is kept for when the group is
                      back. Still reached by Tab (`aria-disabled`, not `disabled`), so its reason is read out; clicks do nothing. */}
                  <Switch
                    aria-label={`${operation.title} (${operation.kind} ${operation.path}): on the help center`}
                    checked={ownOn(operation)}
                    aria-disabled={inOffGroup(operation) || undefined}
                    aria-describedby={inOffGroup(operation) ? `off-endpoint-${operation.slug}` : undefined}
                    className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                    onChange={(event) => !inOffGroup(operation) && change("operation", operation.key, event.currentTarget.checked)}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
