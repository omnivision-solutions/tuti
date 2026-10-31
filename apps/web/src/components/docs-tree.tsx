"use client";

import { cn } from "cn";
import { ChevronRightIcon, FileTextIcon, GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type DragEvent, type ReactNode, useContext, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { CollectionDialog, TabDialog } from "@/components/docs";
import { LucideIcon } from "@/components/icon-field";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ancestry, height, MAX_COLLECTION_DEPTH } from "@/lib/collection-tree";
import type { AccessChoices } from "@/server/docs-queries";
import { moveArticle, moveCollection, moveTab } from "@/server/docs";

export type TreeArticle = { slug: string; title: string; published: boolean };
export type TreeCollection = {
  slug: string;
  name: string;
  /** The collection it's in, or null at the top level. */
  parent: string | null;
  /** At the top level, the tab it's in (null without tabs). */
  tab: string | null;
  /** Its Lucide icon's name, if the installed Lucide has it. */
  icon: string | null;
  articles: TreeArticle[];
};
export type TreeTab = { slug: string; name: string };

type Kind = "tab" | "collection" | "article";
/** A row things can be dropped on: a tab, a collection, an article (in `collection`), or the articles in no collection. */
type Over = { kind: Kind | "uncollected"; slug: string; collection?: string | null };
type Where = "before" | "after" | "into";
/** A move: into collection `into` (null: the top level, or no collection), at the top level in `tab` (undefined: where it is). */
type Move = { kind: Kind; slug: string; name: string; into: string | null; tab?: string; position?: number };
type Drop = Move & { where: Where };
/** A place in a "Move to…" menu: a collection is indented by how deep it is (`depth`: 0 at the top level) and named with the ones it's in (`name`). */
type Place = { key: string; label: string; name?: string; depth?: number; disabled?: boolean; move: () => void };

const rowKey = (over: Over) => `${over.kind}:${over.slug}`;
/** Where `slug` goes among `siblings` (it may be one of them) to land just before or after `target`. */
const positionAt = (siblings: { slug: string }[], slug: string, target: string, where: Where) =>
  siblings.filter((s) => s.slug !== slug).findIndex((s) => s.slug === target) + (where === "after" ? 1 : 0);
const INDENT = ["", "pl-5", "pl-8", "pl-11", "pl-14"];

/** Where a new collection goes: in collection `parent`, else at the top level of tab `tab`. */
type NewCollection = { parent: string | null; tab?: string };
const DocsWorkspaceContext = createContext<{
  projectSlug: string;
  depthOf: (slug: string) => number;
  newCollection: (at: NewCollection) => void;
} | null>(null);

/**
 * "+" on a tab or a collection, and its page's "Add content": a new article (in collection `article`;
 * null: in none; false: none here) or a new collection (in `parent`, else in tab `tab`), unless
 * `parent` is as deep as collections go.
 */
export function AddContentMenu({
  label,
  parent,
  tab,
  article,
}: {
  /** The tree's "+" button's name ("Add to Billing"); without one, the page's "Add content" button. */
  label?: string;
  parent: string | null;
  tab?: string;
  article: string | null | false;
}) {
  const workspace = useContext(DocsWorkspaceContext)!;
  const nests = parent === null || workspace.depthOf(parent) < MAX_COLLECTION_DEPTH;
  const href = `/app/${workspace.projectSlug}/docs/new${article ? `?collection=${encodeURIComponent(article)}` : ""}`;
  return (
    <DropdownMenu>
      {label ? (
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} className="text-muted-foreground" />}>
          <PlusIcon aria-hidden />
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          <PlusIcon aria-hidden />
          Add content
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        {article !== false && <DropdownMenuItem render={<Link href={href} />}>New article</DropdownMenuItem>}
        {nests && <DropdownMenuItem onClick={() => workspace.newCollection({ parent, tab })}>New collection</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A row's handle: dragging its row moves it, and its menu moves it up, down, or to another place (from the keyboard too). */
function MoveMenu({
  id,
  name,
  disabled,
  up,
  down,
  places,
}: {
  id: string;
  name: string;
  disabled: boolean;
  up?: () => void;
  down?: () => void;
  places: Place[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id={id}
        // Its menu opens on a click rather than as it's pressed, so pressing it and moving drags the row (an open menu would take the drop).
        onPointerDown={(event) => event.preventBaseUIHandler()}
        onMouseDown={(event) => event.preventBaseUIHandler()}
        render={<Button variant="ghost" size="icon-xs" aria-label={`Move ${name}`} disabled={disabled} className="cursor-grab text-muted-foreground" />}
      >
        <GripVerticalIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuItem onClick={up} disabled={!up}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem onClick={down} disabled={!down}>
          Move down
        </DropdownMenuItem>
        {places.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to…</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-auto min-w-48">
              {places.map((place) => (
                <DropdownMenuItem
                  key={place.key}
                  onClick={place.move}
                  disabled={place.disabled}
                  aria-label={place.name}
                  className={cn("break-words", INDENT[place.depth ?? 0])}
                >
                  {place.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One row: what it is (a link to its page) and, on hover or focus, its buttons; `drop` marks where a drop would land. */
function Row({
  draggable,
  drop,
  handlers,
  children,
  actions,
  className,
}: {
  draggable: boolean;
  drop: Where | undefined;
  handlers: object;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      {...handlers}
      draggable={draggable}
      data-drop={drop}
      className={cn(
        "group/row flex min-h-8 items-center gap-0.5 rounded-md pr-1 text-sm hover:bg-accent/60 has-[a[aria-current=page]]:bg-accent",
        "data-[drop=after]:shadow-[inset_0_-2px_0_0_var(--color-primary)] data-[drop=before]:shadow-[inset_0_2px_0_0_var(--color-primary)]",
        "data-[drop=into]:bg-accent data-[drop=into]:ring-2 data-[drop=into]:ring-primary",
        className,
      )}
    >
      {children}
      {actions && (
        <div className="flex shrink-0 items-center opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 lg:opacity-0">
          {actions}
        </div>
      )}
    </div>
  );
}

const rowLink =
  "flex min-w-0 flex-1 items-center gap-2 py-1.5 break-words rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:font-medium";

/**
 * The team's docs beside a tab's, a collection's and an article's page in the app: each tab with its collections
 * (5 levels deep at most, each with its articles, then the collections in it) and the articles in none
 * (on the first tab), in the order readers see them, then "New tab" and "Recently deleted". A tab or a
 * collection opens its page, an article its editor; the page's own row is marked and its branch open.
 *
 * It's a nested list of links (`nav` › `ul` › `li`), each collection with a button that opens or
 * closes it (`aria-expanded`), rather than an ARIA tree: links and buttons work with Tab, Enter and
 * a screen reader as they are. Rows are dragged into place, or moved from their handle's menu (up,
 * down, "Move to…"), which works from the keyboard. A drop or a menu item is one move, applied at
 * once on the server under the project's lock. "+" on a tab or a collection adds an article or a
 * collection there. On phones it's a "Browse docs" disclosure above the page.
 */
export function DocsWorkspace({
  projectSlug,
  tabs,
  collections,
  uncollected,
  access,
  parents,
  deleted,
  children,
}: {
  projectSlug: string;
  tabs: TreeTab[];
  /** Each top-level collection (by tab), then the ones in it. */
  collections: TreeCollection[];
  uncollected: TreeArticle[];
  /** For a new collection's "Who can read" and where it can go (collections less than 5 levels deep, named with the ones they're in). */
  access: AccessChoices;
  parents: { slug: string; name: string }[];
  /** How many articles were deleted lately (they can be restored from the Docs home). */
  deleted: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const base = `/app/${projectSlug}/docs`;
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<{ kind: Kind; slug: string } | null>(null);
  const [target, setTarget] = useState<{ key: string; where: Where } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Where "New collection" adds one, while its dialog is open.
  const [adding, setAdding] = useState<NewCollection | null>(null);
  // The handle to focus again once the move is done, moved or refused: it's disabled while the move runs
  // (some browsers then drop its focus), and its row may have moved.
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    const id = refocus.current;
    if (pending || !id) {
      return;
    }
    refocus.current = null;
    document.getElementById(id)?.focus();
  }, [pending, tabs, collections, uncollected]);

  // The tree by slug, for the checks the server makes too.
  const tree = collections.map((c) => ({ id: c.slug, parentId: c.parent, name: c.name }));
  // Each collection's chain up to its top-level one, once per render (rows and menus ask often, drags re-render).
  const chains = new Map(tree.map((c) => [c.id, ancestry(tree, c.id)]));
  /** How deep collection `slug` is: 1 at the top level. */
  const depthOf = (slug: string) => chains.get(slug)?.length ?? 0;
  /** Whether collection `slug` is collection `of` or one inside it. */
  const within = (slug: string, of: string) => chains.get(slug)?.some((c) => c.id === of) ?? false;

  // The page shown: /tabs/<slug>, /collections/<slug>, or an article's /<slug> (and its /history).
  const [at, slug] = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1).split("/") : [];
  const current =
    at === "tabs" || at === "collections"
      ? { kind: at === "tabs" ? "tab" : "collection", slug: slug ?? "" }
      : at && at !== "new" && at !== "insights"
        ? { kind: "article", slug: at }
        : null;
  const currentCollection =
    current?.kind === "collection" ? current.slug : current?.kind === "article" ? (collections.find((c) => c.articles.some((a) => a.slug === current.slug))?.slug ?? null) : null;
  const branch = (chains.get(currentCollection ?? "") ?? []).map((c) => c.id);
  // Open: the current page's branch, and the ones opened since; a new page opens its branch too.
  const [open, setOpen] = useState(() => new Set(branch));
  const [shown, setShown] = useState(pathname);
  if (shown !== pathname) {
    setShown(pathname);
    setBrowsing(false);
    if (branch.some((c) => !open.has(c))) {
      setOpen(new Set([...open, ...branch]));
    }
  }
  const toggle = (slug: string) => setOpen((was) => new Set(was.has(slug) ? [...was].filter((s) => s !== slug) : [...was, slug]));

  const childrenOf = (parent: string | null) => collections.filter((c) => c.parent === parent);

  /** The collections next to `c`: in its parent, or at the top level of its tab. */
  const siblingsOf = (c: TreeCollection) => (c.parent === null ? childrenOf(null).filter((s) => s.tab === c.tab) : childrenOf(c.parent));
  const articlesIn = (collection: string | null) => (collection === null ? uncollected : (collections.find((c) => c.slug === collection)?.articles ?? []));
  /** A collection as a "Move to…" place: indented, and named with the ones it's in ("Billing › Invoices"). */
  const placeOf = (c: TreeCollection) => ({
    key: c.slug,
    label: c.name,
    name: (chains.get(c.slug) ?? [])
      .map((p) => p.name)
      .reverse()
      .join(" › "),
    depth: depthOf(c.slug) - 1,
  });

  const move = ({ kind, slug, name, into, tab, position }: Move, focus?: string) => {
    refocus.current = focus ?? null;
    startTransition(async () => {
      const result =
        kind === "tab"
          ? await moveTab(projectSlug, slug, position ?? tabs.length)
          : kind === "collection"
            ? await moveCollection(projectSlug, slug, into, position, tab)
            : await moveArticle(projectSlug, slug, into, position);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${name} moved`);
      }
    });
  };

  /** Where the dragged row would land on row `over`, if it can go there. */
  function dropFor(event: DragEvent, over: Over): Drop | null {
    if (!dragging || (dragging.kind === over.kind && dragging.slug === over.slug)) {
      return null;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    const side: Where = y < 0.5 ? "before" : "after";
    if (dragging.kind === "tab") {
      const dragged = tabs.find((s) => s.slug === dragging.slug);
      if (!dragged || over.kind !== "tab") {
        return null;
      }
      return { kind: "tab", slug: dragged.slug, name: dragged.name, into: null, position: positionAt(tabs, dragged.slug, over.slug, side), where: side };
    }
    if (dragging.kind === "collection") {
      const dragged = collections.find((c) => c.slug === dragging.slug);
      if (!dragged) {
        return null;
      }
      const base = { kind: dragging.kind, slug: dragged.slug, name: dragged.name };
      // On a tab: last at its top level.
      if (over.kind === "tab") {
        return { ...base, into: null, tab: over.slug, where: "into" };
      }
      const row = over.kind === "collection" ? collections.find((c) => c.slug === over.slug) : undefined;
      // Not on itself or one inside it: there's nowhere there for it to go.
      if (!row || within(row.slug, dragged.slug)) {
        return null;
      }
      // On a collection's middle: inside it (the server says if that's too deep).
      if (y > 0.25 && y < 0.75) {
        return { ...base, into: row.slug, where: "into" };
      }
      return {
        ...base,
        into: row.parent,
        tab: row.parent === null ? (row.tab ?? undefined) : undefined,
        position: positionAt(siblingsOf(row), dragged.slug, row.slug, side),
        where: side,
      };
    }
    const dragged = [...collections.flatMap((c) => c.articles), ...uncollected].find((a) => a.slug === dragging.slug);
    if (!dragged) {
      return null;
    }
    const base = { kind: dragging.kind, slug: dragged.slug, name: dragged.title };
    if (over.kind === "article") {
      const collection = over.collection ?? null;
      return { ...base, into: collection, position: positionAt(articlesIn(collection), dragged.slug, over.slug, side), where: side };
    }
    if (over.kind === "tab") {
      return null;
    }
    // On a collection, or on "Not in a collection": last there.
    return { ...base, into: over.kind === "uncollected" ? null : over.slug, where: "into" };
  }

  /** The drag and drop handlers for row `over`. */
  const handlers = (over: Over) => ({
    onDragStart: (event: DragEvent) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", over.slug);
      setDragging({ kind: over.kind as Kind, slug: over.slug });
    },
    onDragEnd: () => {
      setDragging(null);
      setTarget(null);
    },
    onDragOver: (event: DragEvent) => {
      const drop = dropFor(event, over);
      if (!drop) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (target?.key !== rowKey(over) || target.where !== drop.where) {
        setTarget({ key: rowKey(over), where: drop.where });
      }
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setTarget(null);
      }
    },
    onDrop: (event: DragEvent) => {
      const drop = dropFor(event, over);
      event.preventDefault();
      event.stopPropagation();
      setDragging(null);
      setTarget(null);
      if (drop) {
        move(drop);
      }
    },
  });
  const dropAt = (over: Over) => (target?.key === rowKey(over) ? target.where : undefined);

  const articleRows = (articles: TreeArticle[], collection: string | null) =>
    articles.map((article) => {
      const index = articles.indexOf(article);
      const id = `move-article-${article.slug}`;
      const over: Over = { kind: "article", slug: article.slug, collection };
      const moving = { kind: "article" as const, slug: article.slug, name: article.title };
      const places = [
        ...collections.filter((c) => c.slug !== collection).map((c) => ({ ...placeOf(c), move: () => move({ ...moving, into: c.slug }, id) })),
        ...(collection === null ? [] : [{ key: "", label: "No collection", move: () => move({ ...moving, into: null }, id) }]),
      ];
      return (
        <li key={article.slug}>
          <Row
            draggable={!pending}
            drop={dropAt(over)}
            handlers={handlers(over)}
            className="pl-6"
            actions={
              <MoveMenu
                id={id}
                name={article.title}
                disabled={pending}
                up={index > 0 ? () => move({ ...moving, into: collection, position: index - 1 }, id) : undefined}
                down={index < articles.length - 1 ? () => move({ ...moving, into: collection, position: index + 1 }, id) : undefined}
                places={places}
              />
            }
          >
            <Link
              href={`${base}/${article.slug}`}
              aria-current={current?.kind === "article" && current.slug === article.slug ? "page" : undefined}
              className={rowLink}
            >
              <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className={cn("min-w-0", !article.published && "text-muted-foreground")}>{article.title}</span>
              {!article.published && <span className="shrink-0 rounded-sm border px-1 text-[0.625rem] leading-4 text-muted-foreground uppercase">Draft</span>}
            </Link>
          </Row>
        </li>
      );
    });

  const collectionRows = (siblings: TreeCollection[], label: string): ReactNode => {
    const visible = siblings;
    return (
      visible.length > 0 && (
        <ul aria-label={label}>
          {visible.map((collection) => {
            const index = siblings.indexOf(collection);
            const id = `move-collection-${collection.slug}`;
            const over: Over = { kind: "collection", slug: collection.slug };
            const inside = childrenOf(collection.slug);
            const moving = { kind: "collection" as const, slug: collection.slug, name: collection.name };
            // Every collection, but the ones it's in already or can't go in: itself, one inside it, or too deep for the ones in it.
            const levels = height(tree, collection.slug);
            const places: Place[] = [
              ...(collection.parent === null ? [] : [{ key: "", label: "Top level", move: () => move({ ...moving, into: null }, id) }]),
              ...(collection.parent === null
                ? tabs.filter((s) => s.slug !== collection.tab).map((s) => ({ key: `tab:${s.slug}`, label: `Tab: ${s.name}`, move: () => move({ ...moving, into: null, tab: s.slug }, id) }))
                : []),
              ...collections.map((c) => ({
                ...placeOf(c),
                move: () => move({ ...moving, into: c.slug }, id),
                disabled: c.slug === collection.parent || within(c.slug, collection.slug) || depthOf(c.slug) + levels > MAX_COLLECTION_DEPTH,
              })),
            ];
            const expanded = open.has(collection.slug);
            const empty = collection.articles.length === 0 && inside.length === 0;
            return (
              <li key={collection.slug}>
                <Row
                  draggable={!pending}
                  drop={dropAt(over)}
                  handlers={handlers(over)}
                  actions={
                    <>
                      <AddContentMenu label={`Add to ${collection.name}`} parent={collection.slug} article={collection.slug} />
                      <MoveMenu
                        id={id}
                        name={collection.name}
                        disabled={pending}
                        up={index > 0 ? () => move({ ...moving, into: collection.parent, position: index - 1 }, id) : undefined}
                        down={index < siblings.length - 1 ? () => move({ ...moving, into: collection.parent, position: index + 1 }, id) : undefined}
                        places={places}
                      />
                    </>
                  }
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={collection.name}
                    disabled={empty}
                    onClick={() => toggle(collection.slug)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:invisible"
                  >
                    <ChevronRightIcon aria-hidden className={cn("size-4 transition-transform", expanded && "rotate-90")} />
                  </button>
                  <Link
                    href={`${base}/collections/${collection.slug}`}
                    aria-current={current?.kind === "collection" && current.slug === collection.slug ? "page" : undefined}
                    className={rowLink}
                  >
                    {collection.icon && <LucideIcon name={collection.icon} className="text-muted-foreground" />}
                    <span className="min-w-0">{collection.name}</span>
                  </Link>
                </Row>
                {expanded && !empty && (
                  <div className="ml-3 border-l pl-1">
                    {collection.articles.length > 0 && <ul aria-label={`Articles in ${collection.name}`}>{articleRows(collection.articles, collection.slug)}</ul>}
                    {collectionRows(inside, `Collections in ${collection.name}`)}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )
    );
  };

  // The articles in no collection: under the first tab, where readers find them. While an article is dragged, a row to drop it there.
  const uncollectedRows = () => {
    const over: Over = { kind: "uncollected", slug: "" };
    return (
      <>
        {uncollected.length > 0 && <ul aria-label="Articles in no collection">{articleRows(uncollected, null)}</ul>}
        {dragging?.kind === "article" && (
          <Row draggable={false} drop={dropAt(over)} handlers={handlers(over)} className="pl-6">
            <span className="py-1.5 text-muted-foreground">Not in a collection</span>
          </Row>
        )}
      </>
    );
  };

  const sectionHeader = "flex min-w-0 flex-1 items-center py-1.5 pl-2 text-xs font-semibold tracking-wide uppercase text-muted-foreground";
  const tabSections = tabs
    .map((tab, index) => {
      const top = childrenOf(null).filter((c) => c.tab === tab.slug);
      const id = `move-tab-${tab.slug}`;
      const over: Over = { kind: "tab", slug: tab.slug };
      const moving = { kind: "tab" as const, slug: tab.slug, name: tab.name, into: null };
      return (
        <li key={tab.slug} className="flex flex-col gap-0.5">
          <Row
            draggable={!pending}
            drop={dropAt(over)}
            handlers={handlers(over)}
            actions={
              <>
                <AddContentMenu
                  label={`Add to ${tab.name}`}
                 
                  parent={null}
                  tab={tab.slug}
                  // An article in no collection is on the first tab; on another, a new one starts in its first collection.
                  article={index === 0 ? null : (top[0]?.slug ?? false)}
                />
                <MoveMenu
                  id={id}
                  name={tab.name}
                  disabled={pending}
                  up={index > 0 ? () => move({ ...moving, position: index - 1 }, id) : undefined}
                  down={index < tabs.length - 1 ? () => move({ ...moving, position: index + 1 }, id) : undefined}
                  places={[]}
                />
              </>
            }
          >
            <Link
              href={`${base}/tabs/${tab.slug}`}
              aria-current={current?.kind === "tab" && current.slug === tab.slug ? "page" : undefined}
              className={cn(rowLink, sectionHeader, "aria-[current=page]:text-foreground")}
            >
              {tab.name}
            </Link>
          </Row>
          {collectionRows(top, `Collections in ${tab.name}`)}
          {index === 0 && uncollectedRows()}
        </li>
      );
    })
    .filter(Boolean);

  const footerLink = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60";
  return (
    <DocsWorkspaceContext value={{ projectSlug, depthOf, newCollection: setAdding }}>
      <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t lg:flex-row">
        {/* Beside a tab's, a collection's or an article's page, to go between them; the docs' home shows them all itself. */}
        {current && (
          <aside className="border-b lg:w-72 lg:shrink-0 lg:border-r lg:border-b-0">
            <button
              type="button"
              aria-expanded={browsing}
              aria-controls="docs-tree"
              onClick={() => setBrowsing(!browsing)}
              className="flex w-full items-center gap-2 px-6 py-3 text-sm font-medium lg:hidden"
            >
              <ChevronRightIcon aria-hidden className={cn("size-4 transition-transform", browsing && "rotate-90")} />
              Browse docs
            </button>
            <div id="docs-tree" className={cn("flex-col gap-4 p-3 lg:sticky lg:top-12 lg:flex lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto", browsing ? "flex" : "hidden")}>
              {/* Back to the docs' home, which shows them all. */}
              <h2 className="px-2 pt-1 font-heading font-semibold">
                <Link href={base} className="hover:underline">
                  Docs
                </Link>
              </h2>
              <nav aria-label="Docs" aria-busy={pending} className="flex flex-col">
                {tabs.length > 0 ? (
                  <ul aria-label="Tabs" className="flex flex-col gap-3">
                    {tabSections}
                  </ul>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <Row draggable={false} drop={undefined} handlers={{}} actions={<AddContentMenu label="Add to your docs" parent={null} article={null} />}>
                      <span className={sectionHeader}>Collections</span>
                    </Row>
                    {collectionRows(childrenOf(null), "Collections")}
                    {uncollectedRows()}
                  </div>
                )}
              </nav>
              <div className="flex flex-col gap-0.5 border-t pt-2">
                <TabDialog projectSlug={projectSlug} first={tabs.length === 0 && collections.length > 0} />
                {deleted > 0 && (
                  <Link href={`${base}#recently-deleted`} className={footerLink}>
                    <Trash2Icon aria-hidden className="size-4 text-muted-foreground" />
                    Recently deleted
                  </Link>
                )}
              </div>
            </div>
          </aside>
        )}
        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-1 flex-col gap-6 p-6">{children}</div>
      </div>
      {adding && (
        <CollectionDialog
          projectSlug={projectSlug}
          parents={parents}
          tabs={tabs}
          access={access}
          open
          onOpenChange={(next) => {
            if (!next) {
              // Its parent opens, to show it.
              if (adding.parent) {
                setOpen((was) => new Set([...was, adding.parent!]));
              }
              setAdding(null);
            }
          }}
          defaultParent={adding.parent}
          defaultTab={adding.tab}
        />
      )}
    </DocsWorkspaceContext>
  );
}
