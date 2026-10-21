"use client";

import type { Doc } from "@tuti/content";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { RichEditor } from "@/components/rich-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type Listing, LISTING_DESCRIPTIONS, LISTING_LABELS, LISTINGS } from "@/lib/article-listing";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import {
  deleteArticle,
  deleteCollection,
  deleteTab,
  discardArticleChanges,
  dismissDocsGap,
  publishArticle,
  publishArticleChanges,
  restoreArticle,
  saveArticle,
  saveCollection,
  saveTab,
  unpublishArticle,
} from "@/server/docs";

type Article = {
  slug: string;
  title: string;
  content: Doc;
  collection: string | null;
  showUpdatedDate: boolean;
  listing: Listing;
  published: boolean;
};
type CollectionOption = { slug: string; name: string };

/** Writes a new article (`article` null) or edits one: title, collection, listing and text. */
export function ArticleForm({
  projectSlug,
  article,
  collections,
  mediaBaseUrl,
  defaultTitle,
}: {
  projectSlug: string;
  article: Article | null;
  collections: CollectionOption[];
  mediaBaseUrl: string | null;
  /** A new article's title to start with (a question from the insights' gaps). */
  defaultTitle?: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveArticle(projectSlug, article?.slug ?? null, prev, formData);
    if (!result.error) {
      toast.success("Saved");
    }
    return result;
  }, {});
  const items = [{ value: null, label: "No collection" }, ...collections.map((c) => ({ value: c.slug, label: c.name }))];
  const [listing, setListing] = useState<Listing>(article?.listing ?? "everywhere");

  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="article-title">Title</FieldLabel>
          <Input
            id="article-title"
            name="title"
            defaultValue={article?.title ?? defaultTitle}
            placeholder="What it helps with, e.g. Inviting your team"
            required
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "article-error" : undefined}
          />
          {state.error && <FieldError id="article-error">{state.error}</FieldError>}
        </Field>
        <Field>
          <FieldLabel id="article-collection-label">Collection</FieldLabel>
          <Select name="collection" items={items} defaultValue={article?.collection ?? null}>
            <SelectTrigger className="w-full sm:w-64" aria-labelledby="article-collection-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value ?? ""} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel id="article-listing-label">Listing</FieldLabel>
          <Select name="listing" items={LISTING_LABELS} value={listing} onValueChange={(value) => setListing(value as Listing)}>
            <SelectTrigger className="w-full sm:w-64" aria-labelledby="article-listing-label" aria-describedby="article-listing-description">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LISTINGS.map((value) => (
                <SelectItem key={value} value={value}>
                  {LISTING_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription id="article-listing-description">{LISTING_DESCRIPTIONS[listing]}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel id="article-body-label">Article</FieldLabel>
          <RichEditor
            profile="article"
            name="content"
            labelledBy="article-body-label"
            placeholder="Explain it step by step"
            initial={article?.content}
            uploads={mediaBaseUrl ? { projectSlug, mediaBaseUrl } : undefined}
          />
        </Field>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="showUpdatedDate"
            className="mt-1 size-4 accent-primary"
            defaultChecked={article?.showUpdatedDate ?? true}
          />
          <span>
            Show the updated date
            <span className="block text-sm text-muted-foreground">Readers see when you last changed it after it was published.</span>
          </span>
        </label>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {article?.published && (
            <p className="text-sm text-muted-foreground">Changes to the title, collection and text go live when you publish them.</p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : article ? "Save" : "Save draft"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** Publish (or take down) and delete an article; publishing and deleting ask first. */
export function ArticleActions({
  projectSlug,
  slug,
  title,
  published,
}: {
  projectSlug: string;
  slug: string;
  title: string;
  published: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const run = (action: typeof publishArticle, done: string) =>
    startTransition(async () => {
      const result = await action(projectSlug, slug);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(done);
      }
    });

  return (
    <div className="flex flex-wrap gap-2">
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="ghost" disabled={pending} />}>Delete</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {published ? "It's removed from your docs, and links to it stop working. " : ""}
              You can restore it from Recently deleted for 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={() => run(deleteArticle, "Deleted")}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {published ? (
        <Button variant="outline" disabled={pending} onClick={() => run(unpublishArticle, "Unpublished")}>
          Unpublish
        </Button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger render={<Button disabled={pending} />}>Publish</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Publish “{title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Anyone can read it in your portal&apos;s docs, and search engines can find it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={pending} onClick={() => run(publishArticle, "Published")}>
                Publish
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/**
 * Over a published article with unpublished changes: review them against the published version
 * (`diff`), publish them, or discard them.
 */
export function ArticleChanges({
  projectSlug,
  slug,
  savedAt,
  saved,
  diff,
}: {
  projectSlug: string;
  slug: string;
  /** When the changes were saved (ISO): they're published or discarded only if nobody saved more since. */
  savedAt: string;
  /** The same, for people ("5 minutes ago"). */
  saved: string;
  diff: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const [reviewing, setReviewing] = useState(false);
  const run = (action: typeof publishArticleChanges, done: string) =>
    startTransition(async () => {
      const result = await action(projectSlug, slug, savedAt);
      if (result.error) {
        toast.error(result.error);
      } else {
        setReviewing(false);
        toast.success(done);
      }
    });
  const publish = (
    <Button disabled={pending} onClick={() => run(publishArticleChanges, "Changes published")}>
      Publish changes
    </Button>
  );

  return (
    <Card role="region" aria-labelledby="article-changes-title">
      <CardHeader>
        <CardTitle id="article-changes-title">Unpublished changes</CardTitle>
        <CardDescription>Saved {saved}. Readers see the published version until you publish them.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap justify-end gap-2">
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="ghost" disabled={pending} />}>Discard changes</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard changes?</AlertDialogTitle>
              <AlertDialogDescription>
                The article goes back to the published version. The changes stay in its history, so you can restore them.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={pending} onClick={() => run(discardArticleChanges, "Changes discarded")}>
                Discard changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Dialog open={reviewing} onOpenChange={setReviewing}>
          <DialogTrigger render={<Button variant="outline" disabled={pending} />}>Review changes</DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review changes</DialogTitle>
              <DialogDescription>
                Against the published version: paragraphs taken out are struck through, new ones are highlighted.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto">{diff}</div>
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={() => setReviewing(false)}>
                Close
              </Button>
              {publish}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {publish}
      </CardContent>
    </Card>
  );
}

/** Makes an earlier version the current one (saved as a new version), then opens the article. */
export function RestoreVersionButton({
  projectSlug,
  slug,
  revision,
  published,
}: {
  projectSlug: string;
  slug: string;
  revision: string;
  published: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button disabled={pending} />}>Restore this version</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore this version?</AlertDialogTitle>
          <AlertDialogDescription>
            {published
              ? "It replaces the current text as unpublished changes: readers see it once you publish them."
              : "It replaces the draft's current text."}{" "}
            The current version stays in the history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await restoreArticle(projectSlug, slug, revision);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success("Version restored");
                  router.push(`/app/${projectSlug}/docs/${result.slug}`);
                }
              })
            }
          >
            Restore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Brings a deleted article back as a draft (`revision` is its newest version, which says which article). */
export function RestoreDeletedButton({ projectSlug, slug, revision, title }: { projectSlug: string; slug: string; revision: string; title: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      aria-label={`Restore “${title}”`}
      onClick={() =>
        startTransition(async () => {
          const result = await restoreArticle(projectSlug, slug, revision);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Restored “${title}” as a draft`);
          }
        })
      }
    >
      Restore
    </Button>
  );
}

/** Adds a collection (at the top level or in one of `parents`), or (with `collection`) renames one and changes its description. */
export function CollectionDialog({
  projectSlug,
  collection,
  parents = [],
  tabs = [],
}: {
  projectSlug: string;
  collection?: { slug: string; name: string; description: string; groups: string[] };
  /** The top-level collections a new one can go in (collections go 2 levels deep at most). */
  parents?: CollectionOption[];
  /** The tabs a new top-level one can go in, the first by default. */
  tabs?: CollectionOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveCollection(projectSlug, collection?.slug ?? null, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success(collection ? "Collection saved" : "Collection added");
    }
    return result;
  }, {});
  const id = collection?.slug ?? "new";
  const parentItems = [{ value: null, label: "None (top level)" }, ...parents.map((c) => ({ value: c.slug, label: c.name }))];
  const tabItems = tabs.map((s) => ({ value: s.slug, label: s.name }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={collection ? "ghost" : "outline"} size="sm" />}>
        {collection ? "Edit" : "New collection"}
      </DialogTrigger>
      <DialogContent>
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>{collection ? "Edit collection" : "New collection"}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="my-4">
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor={`collection-name-${id}`}>Name</FieldLabel>
              <Input
                id={`collection-name-${id}`}
                name="name"
                defaultValue={collection?.name}
                placeholder="Getting started"
                required
                aria-invalid={state.error ? true : undefined}
              />
              {state.error && <FieldError>{state.error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor={`collection-description-${id}`}>Description</FieldLabel>
              <Textarea
                id={`collection-description-${id}`}
                name="description"
                rows={2}
                maxLength={300}
                defaultValue={collection?.description}
                placeholder="Optional, shown in your docs"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`collection-groups-${id}`}>Only for groups</FieldLabel>
              <Input
                id={`collection-groups-${id}`}
                name="groups"
                defaultValue={collection?.groups.join(", ")}
                placeholder="Everyone (e.g. enterprise, beta)"
                autoComplete="off"
              />
              <FieldDescription>
                Leave empty for everyone who can read your docs. With groups, only your team and people your app signs in with
                one of them (the groups in its sign-in token) see it, its articles and the collections in it.
              </FieldDescription>
            </Field>
            {!collection && parents.length > 0 && (
              <Field>
                <FieldLabel id="collection-parent-label">Parent collection</FieldLabel>
                <Select name="parent" items={parentItems} defaultValue={null}>
                  <SelectTrigger className="w-full" aria-labelledby="collection-parent-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {parentItems.map((item) => (
                      <SelectItem key={item.value ?? ""} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {!collection && tabItems.length > 0 && (
              <Field>
                <FieldLabel id="collection-tab-label">Section</FieldLabel>
                <Select name="tab" items={tabItems} defaultValue={tabItems[0].value}>
                  <SelectTrigger className="w-full" aria-labelledby="collection-tab-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tabItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {parentItems.length > 1 && <FieldDescription>A collection inside another is in that one&apos;s section.</FieldDescription>}
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {collection ? "Save" : "Add collection"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteCollectionButton({
  projectSlug,
  slug,
  name,
  hasChildren = false,
}: {
  projectSlug: string;
  slug: string;
  name: string;
  /** It has collections in it, which move up to the top level. */
  hasChildren?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its articles stay, without a collection.{hasChildren && " The collections in it move up to the top level."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteCollection(projectSlug, slug);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${name} deleted`);
                }
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Adds a tab (`tab` undefined) or renames one. The first one takes the collections there
 * are, which the dialog says.
 */
export function TabDialog({ projectSlug, tab, first = false }: { projectSlug: string; tab?: CollectionOption; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveTab(projectSlug, tab?.slug ?? null, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success(tab ? "Section saved" : "Section added");
    }
    return result;
  }, {});
  const id = tab?.slug ?? "new";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={tab ? "ghost" : "outline"} size="sm" aria-label={tab ? `Rename ${tab.name}` : undefined} />}>
        {tab ? "Rename" : "New section"}
      </DialogTrigger>
      <DialogContent>
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>{tab ? "Rename section" : "New section"}</DialogTitle>
            {!tab && (
              <DialogDescription>
                Sections are tabs at the top of your docs, each with its own collections
                {first ? ". Your collections go in this first one, and you can move them to the next ones." : "."}
              </DialogDescription>
            )}
          </DialogHeader>
          <FieldGroup className="my-4">
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor={`tab-name-${id}`}>Name</FieldLabel>
              <Input
                id={`tab-name-${id}`}
                name="name"
                defaultValue={tab?.name}
                placeholder="Guides"
                maxLength={40}
                required
                aria-invalid={state.error ? true : undefined}
              />
              {state.error && <FieldError>{state.error}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {tab ? "Save" : "Add section"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteTabButton({
  projectSlug,
  tab,
  movesTo,
}: {
  projectSlug: string;
  tab: CollectionOption;
  /** The tab its collections go to (null: it's the last one). */
  movesTo: string | null;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} aria-label={`Delete ${tab.name}`} />}>
        Delete
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {tab.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {movesTo
              ? `Its collections move to ${movesTo}, with their articles.`
              : "It's the last section, so your docs go back to one page with all your collections."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteTab(projectSlug, tab.slug);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${tab.name} deleted`);
                }
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Dismiss" on a gap in the insights: hides the question until someone asks it again. */
export function DismissGapButton({ projectSlug, question }: { projectSlug: string; question: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await dismissDocsGap(projectSlug, question);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Dismissed");
          }
        })
      }
    >
      Dismiss
    </Button>
  );
}
