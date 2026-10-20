"use client";

import { cn } from "cn";
import { ArrowDownIcon, ArrowUpIcon, FolderInputIcon, GripVerticalIcon } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { CollectionDialog, DeleteCollectionButton } from "@/components/help";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { moveArticle, moveCollection } from "@/server/help";

type StructureArticle = { slug: string; title: string; published: boolean };
type StructureCollection = {
  slug: string;
  name: string;
  description: string;
  /** The collection it's in, or null at the top level. */
  parent: string | null;
  articles: StructureArticle[];
};

type Kind = "collection" | "article";
/** A row things can be dropped on: a collection, an article (in `collection`), or the articles in no collection. */
type Over = { kind: Kind | "uncollected"; slug: string; collection?: string | null };
type Where = "before" | "after" | "into";
type Move = { kind: Kind; slug: string; name: string; into: string | null; position?: number };
type Drop = Move & { where: Where };

const rowKey = (over: Over) => `${over.kind}:${over.slug}`;
/** Where `slug` goes among `siblings` (it may be one of them) to land just before or after `target`. */
const positionAt = (siblings: { slug: string }[], slug: string, target: string, where: Where) =>
  siblings.filter((s) => s.slug !== slug).findIndex((s) => s.slug === target) + (where === "after" ? 1 : 0);
const otherButton = (id: string) => (id.endsWith("-up") ? id.replace(/-up$/, "-down") : id.replace(/-down$/, "-up"));

/** Up and down buttons, and a "Move to…" menu of the other places it can go. */
function MoveButtons({
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
  places: { label: string; move: () => void }[];
}) {
  return (
    <>
      <Button id={`${id}-up`} variant="ghost" size="icon-sm" aria-label={`Move ${name} up`} disabled={disabled || !up} onClick={up}>
        <ArrowUpIcon aria-hidden />
      </Button>
      <Button id={`${id}-down`} variant="ghost" size="icon-sm" aria-label={`Move ${name} down`} disabled={disabled || !down} onClick={down}>
        <ArrowDownIcon aria-hidden />
      </Button>
      {/* Nowhere else to go: a gap, so the buttons line up with the other rows'. */}
      {places.length === 0 && <span aria-hidden className="size-7" />}
      {places.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Move ${name} to…`} disabled={disabled} />}>
            <FolderInputIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-48">
            {places.map((place) => (
              <DropdownMenuItem key={place.label} onClick={place.move}>
                {place.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

/** One row: a drag handle (if it can be dragged), its text, and its buttons; `drop` marks where a drop would land. */
function Row({
  draggable,
  drop,
  handlers,
  children,
  actions,
}: {
  draggable: boolean;
  drop: Where | undefined;
  handlers: object;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      {...handlers}
      draggable={draggable}
      data-drop={drop}
      className={cn(
        "flex flex-col gap-1 rounded-lg py-1.5 sm:flex-row sm:items-center sm:gap-2",
        "data-[drop=after]:shadow-[inset_0_-2px_0_0_var(--color-primary)] data-[drop=before]:shadow-[inset_0_2px_0_0_var(--color-primary)]",
        "data-[drop=into]:bg-accent data-[drop=into]:ring-2 data-[drop=into]:ring-primary",
        draggable && "cursor-grab",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <GripVerticalIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", !draggable && "invisible")} />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-1 pl-6 sm:pl-0">{actions}</div>}
    </div>
  );
}

/**
 * The help center's structure for the team: collections (2 levels deep at most), each with its
 * articles and then the collections in it, and the articles in no collection, in the order readers
 * see them. Rows are dragged into place, or moved with each row's buttons (up, down, and "Move to…"
 * another collection), which work from the keyboard. A drop or a button is one move, applied at once
 * on the server under the project's lock.
 */
export function HelpStructure({
  projectSlug,
  collections,
  uncollected,
}: {
  projectSlug: string;
  /** Each top-level collection, then the ones in it. */
  collections: StructureCollection[];
  uncollected: StructureArticle[];
}) {
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<{ kind: Kind; slug: string } | null>(null);
  const [target, setTarget] = useState<{ key: string; where: Where } | null>(null);
  // The button to focus again once the moved row is back: it's disabled (so it loses focus) while the move runs.
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    const id = refocus.current;
    refocus.current = null;
    if (!id) {
      return;
    }
    const button = document.getElementById(id);
    const other = document.getElementById(otherButton(id));
    // At the top or the bottom now, its own button is disabled, so the other one gets focus.
    (button instanceof HTMLButtonElement && button.disabled && other ? other : button)?.focus();
  }, [collections, uncollected]);

  const childrenOf = (parent: string | null) => collections.filter((c) => c.parent === parent);
  const articlesIn = (collection: string | null) =>
    collection === null ? uncollected : (collections.find((c) => c.slug === collection)?.articles ?? []);
  const label = (c: StructureCollection) => {
    const parent = collections.find((p) => p.slug === c.parent);
    return parent ? `${parent.name} › ${c.name}` : c.name;
  };

  const move = ({ kind, slug, name, into, position }: Move, focus?: string) => {
    refocus.current = focus ?? null;
    startTransition(async () => {
      const result =
        kind === "collection" ? await moveCollection(projectSlug, slug, into, position) : await moveArticle(projectSlug, slug, into, position);
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
    if (dragging.kind === "collection") {
      const dragged = collections.find((c) => c.slug === dragging.slug);
      const row = over.kind === "collection" ? collections.find((c) => c.slug === over.slug) : undefined;
      if (!dragged || !row) {
        return null;
      }
      const base = { kind: dragging.kind, slug: dragged.slug, name: dragged.name };
      // Only a collection with none in it goes inside another: into a top-level one (its middle), or next to one inside.
      const flat = childrenOf(dragged.slug).length === 0;
      if (row.parent === null && flat && y > 0.25 && y < 0.75) {
        return { ...base, into: row.slug, where: "into" };
      }
      if (row.parent !== null && !flat) {
        return null;
      }
      return { ...base, into: row.parent, position: positionAt(childrenOf(row.parent), dragged.slug, row.slug, side), where: side };
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
        // eslint-disable-next-line react-hooks/refs -- runs on drop, not during render (handlers() only builds the row's event handlers)
        move(drop);
      }
    },
  });
  const dropAt = (over: Over) => (target?.key === rowKey(over) ? target.where : undefined);

  const articleRows = (articles: StructureArticle[], collection: string | null, name: string) =>
    articles.length > 0 && (
      <ul aria-label={name}>
        {articles.map((article, index) => {
          const id = `move-article-${article.slug}`;
          const over: Over = { kind: "article", slug: article.slug, collection };
          const base = { kind: "article" as const, slug: article.slug, name: article.title };
          const places = [
            ...collections.filter((c) => c.slug !== collection).map((c) => ({ label: label(c), move: () => move({ ...base, into: c.slug }) })),
            ...(collection === null ? [] : [{ label: "No collection", move: () => move({ ...base, into: null }) }]),
          ];
          return (
            <li key={article.slug}>
              <Row
                draggable={!pending}
                drop={dropAt(over)}
                handlers={handlers(over)}
                actions={
                  <MoveButtons
                    id={id}
                    name={article.title}
                    disabled={pending}
                    up={index > 0 ? () => move({ ...base, into: collection, position: index - 1 }, `${id}-up`) : undefined}
                    down={index < articles.length - 1 ? () => move({ ...base, into: collection, position: index + 1 }, `${id}-down`) : undefined}
                    places={places}
                  />
                }
              >
                <span className="text-sm break-words">{article.title}</span>
                {!article.published && <span className="text-xs text-muted-foreground">Draft</span>}
              </Row>
            </li>
          );
        })}
      </ul>
    );

  const collectionRows = (siblings: StructureCollection[], name: string): ReactNode =>
    siblings.length > 0 && (
      <ul aria-label={name}>
        {siblings.map((collection, index) => {
          const id = `move-collection-${collection.slug}`;
          const over: Over = { kind: "collection", slug: collection.slug };
          const inside = childrenOf(collection.slug);
          const base = { kind: "collection" as const, slug: collection.slug, name: collection.name };
          const places = [
            ...(collection.parent === null ? [] : [{ label: "Top level", move: () => move({ ...base, into: null }) }]),
            ...(inside.length > 0
              ? []
              : childrenOf(null)
                  .filter((c) => c.slug !== collection.slug && c.slug !== collection.parent)
                  .map((c) => ({ label: `Into ${c.name}`, move: () => move({ ...base, into: c.slug }) }))),
          ];
          const count = collection.articles.length;
          return (
            <li key={collection.slug}>
              <Row
                draggable={!pending}
                drop={dropAt(over)}
                handlers={handlers(over)}
                actions={
                  <>
                    <MoveButtons
                      id={id}
                      name={collection.name}
                      disabled={pending}
                      up={index > 0 ? () => move({ ...base, into: collection.parent, position: index - 1 }, `${id}-up`) : undefined}
                      down={
                        index < siblings.length - 1 ? () => move({ ...base, into: collection.parent, position: index + 1 }, `${id}-down`) : undefined
                      }
                      places={places}
                    />
                    <CollectionDialog projectSlug={projectSlug} collection={collection} />
                    <DeleteCollectionButton projectSlug={projectSlug} slug={collection.slug} name={collection.name} hasChildren={inside.length > 0} />
                  </>
                }
              >
                <span className="text-sm font-medium break-words">{collection.name}</span>
                <span className="text-xs text-muted-foreground">{`${count} ${count === 1 ? "article" : "articles"}`}</span>
              </Row>
              {(count > 0 || inside.length > 0) && (
                <div className="ml-2 border-l pl-3">
                  {articleRows(collection.articles, collection.slug, `Articles in ${collection.name}`)}
                  {collectionRows(inside, `Collections in ${collection.name}`)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );

  const uncollectedRow: Over = { kind: "uncollected", slug: "" };
  return (
    <div className="flex flex-col gap-2" aria-busy={pending}>
      {collectionRows(childrenOf(null), "Collections")}
      {(uncollected.length > 0 || dragging?.kind === "article") && (
        <div>
          <Row draggable={false} drop={dropAt(uncollectedRow)} handlers={handlers(uncollectedRow)}>
            <span className="text-sm font-medium text-muted-foreground">Not in a collection</span>
          </Row>
          <div className="ml-2 border-l pl-3">{articleRows(uncollected, null, "Articles in no collection")}</div>
        </div>
      )}
    </div>
  );
}
