"use client";

import type { Doc } from "@tuti/content";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { IconField } from "@/components/icon-field";
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type GroupOption, WhoCanRead } from "@/components/who-can-read";
import { keepingFields } from "@/lib/forms";
import type { Access } from "@/lib/read-access";
import type { AccessChoices } from "@/server/docs-queries";
import type { FormState } from "@/server/form-state";
import type { DocsLanding } from "@/server/operations/docs";
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
  published: boolean;
};
type CollectionOption = { slug: string; name: string };

/** Writes a new article (`article` null) or edits one: title, collection and text (its settings are in ArticleSettings). */
export function ArticleForm({
  projectSlug,
  article,
  collections,
  mediaBaseUrl,
  defaultTitle,
  defaultCollection,
}: {
  projectSlug: string;
  article: Article | null;
  collections: CollectionOption[];
  mediaBaseUrl: string | null;
  /** A new article's title to start with (a question from the insights' gaps). */
  defaultTitle?: string;
  /** A new article's collection to start with (a collection's "New article"). */
  defaultCollection?: string | null;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveArticle(projectSlug, article?.slug ?? null, prev, formData);
    if (!result.error) {
      toast.success("Saved");
    }
    return result;
  }, {});
  const items = [{ value: null, label: "No collection" }, ...collections.map((c) => ({ value: c.slug, label: c.name }))];
  const [collection, setCollection] = useState<string | null>(article?.collection ?? defaultCollection ?? null);

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
          <Select name="collection" items={items} value={collection} onValueChange={(value) => setCollection(value as string | null)}>
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

export type { GroupOption };

type CollectionSettings = {
  slug: string;
  name: string;
  description: string;
  /** The collection it's in, or (at the top level) its tab: what it inherits from. */
  parent: string | null;
  tab: string | null;
  access: Access;
  groups: string[];
  icon: string | null;
  knownIcon: boolean;
};

/** A collection's name (with `error`, a refused save's), icon and description, as form fields; `collection` gives their values. */
function CollectionFields({ id, collection, error }: { id: string; collection?: CollectionSettings; error?: string }) {
  return (
    <>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`collection-name-${id}`}>Name</FieldLabel>
        <Input
          id={`collection-name-${id}`}
          name="name"
          defaultValue={collection?.name}
          placeholder="Getting started"
          required
          aria-invalid={error ? true : undefined}
        />
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <IconField defaultValue={collection?.icon ?? null} known={collection?.knownIcon ?? true} />
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
    </>
  );
}

/** A form's "Parent collection" picker (`parent`, empty for the top level), from `parents`. */
function ParentField({
  id,
  parents,
  value,
  onValueChange,
  defaultValue,
}: {
  id: string;
  parents: CollectionOption[];
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  defaultValue?: string | null;
}) {
  const items = [{ value: null, label: "None (top level)" }, ...parents.map((c) => ({ value: c.slug, label: c.name }))];
  return (
    <Field>
      <FieldLabel id={`${id}-parent-label`}>Parent collection</FieldLabel>
      <Select
        name="parent"
        items={items}
        {...(onValueChange ? { value, onValueChange: (next) => onValueChange(next as string | null) } : { defaultValue })}
      >
        <SelectTrigger className="w-full" aria-labelledby={`${id}-parent-label`}>
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
  );
}

/** A Save button at the end of a form on a page, off while it saves. */
function SaveButton({ pending }: { pending: boolean }) {
  return (
    <div className="flex justify-end">
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

/** A collection page's Settings: its name, icon, description and the collection it's in (`parents`: where it can go). */
export function CollectionSettingsForm({
  projectSlug,
  collection,
  parents,
}: {
  projectSlug: string;
  collection: CollectionSettings;
  parents: CollectionOption[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveCollection(projectSlug, collection.slug, prev, formData);
    if (!result.error) {
      toast.success("Collection saved");
    }
    return result;
  }, {});
  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <CollectionFields id={collection.slug} collection={collection} error={state.error} />
        <ParentField id={`collection-${collection.slug}`} parents={parents} defaultValue={collection.parent} />
        <SaveButton pending={pending} />
      </FieldGroup>
    </form>
  );
}

/** A tab's or a collection's page's Access: who can read it (`inherit`: what the level above lets read). */
export function AccessForm({
  projectSlug,
  kind,
  slug,
  groups,
  inherit,
  access,
  defaultGroups,
}: {
  projectSlug: string;
  kind: "tab" | "collection";
  slug: string;
  groups: GroupOption[];
  inherit: { label: string; description: string };
  access: Access;
  defaultGroups: string[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await (kind === "tab" ? saveTab : saveCollection)(projectSlug, slug, prev, formData);
    if (!result.error) {
      toast.success(kind === "tab" ? "Tab saved" : "Collection saved");
    }
    return result;
  }, {});
  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <WhoCanRead id={`${kind}-access-${slug}`} projectSlug={projectSlug} groups={groups} inherit={inherit} defaultAccess={access} defaultGroups={defaultGroups} />
        {state.error && <FieldError>{state.error}</FieldError>}
        <SaveButton pending={pending} />
      </FieldGroup>
    </form>
  );
}

/**
 * Adds a collection (at the top level or in one of `parents`), or (with `collection`) renames one and
 * changes its description, icon and who can read it. Opened by its own button, or (with `open`) by its owner.
 */
export function CollectionDialog({
  projectSlug,
  collection,
  parents = [],
  tabs = [],
  access,
  open: openProp,
  onOpenChange,
  defaultParent = null,
  defaultTab,
}: {
  projectSlug: string;
  collection?: CollectionSettings;
  /** For "Who can read": the project's groups, and what each tab and collection lets read. */
  access: AccessChoices;
  /** The collections a new one can go in (the ones less than 5 levels deep), named with the ones they're in. */
  parents?: CollectionOption[];
  /** The tabs a new top-level one can go in, the first by default. */
  tabs?: CollectionOption[];
  /** Opened and closed by its owner (a "+" menu), which has no button for it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where a new one goes to start with: in collection `defaultParent`, else at the top level of tab `defaultTab`. */
  defaultParent?: string | null;
  defaultTab?: string;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveCollection(projectSlug, collection?.slug ?? null, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success(collection ? "Collection saved" : "Collection added");
    }
    return result;
  }, {});
  const id = collection?.slug ?? "new";
  const tabItems = tabs.map((s) => ({ value: s.slug, label: s.name }));
  // A new one's place, as picked: it inherits from there.
  const [parent, setParent] = useState<string | null>(defaultParent);
  const [tab, setTab] = useState<string | null>(defaultTab ?? tabItems[0]?.value ?? null);
  const above = collection ? (collection.parent ?? collection.tab) : (parent ?? tab);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {openProp === undefined && (
        <DialogTrigger render={<Button variant={collection ? "ghost" : "outline"} size="sm" />}>
          {collection ? "Edit" : "New collection"}
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>{collection ? "Edit collection" : "New collection"}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="my-4">
            <CollectionFields id={id} collection={collection} error={state.error} />
            {!collection && parents.length > 0 && <ParentField id="collection" parents={parents} value={parent} onValueChange={setParent} />}
            {!collection && tabItems.length > 0 && (
              <Field>
                <FieldLabel id="collection-tab-label">Tab</FieldLabel>
                <Select name="tab" items={tabItems} value={tab} onValueChange={(value) => setTab(value as string | null)}>
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
                {parents.length > 0 && <FieldDescription>A collection inside another is in that one&apos;s tab.</FieldDescription>}
              </Field>
            )}
            <WhoCanRead
              id={`collection-access-${id}`}
              projectSlug={projectSlug}
              groups={access.groups}
              inherit={{ label: "Inherit", description: access.inherits[above ?? ""] ?? access.inherits[""]! }}
              defaultAccess={collection?.access}
              defaultGroups={collection?.groups}
            />
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
  /** It has collections in it, which move up a level. */
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
            Its articles stay, without a collection.{hasChildren && " The collections in it move up a level, in its place."}
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

/** What a tab's path shows (see tabs.update), as the tab's settings offer it, with a sketch of each. */
const LANDING_CHOICES: { value: DocsLanding; name: string; description: string; sketch: ReactNode }[] = [
  {
    value: "overview",
    name: "Overview",
    description: "Search and a card per collection",
    sketch: (
      <>
        <span className="h-2 w-full rounded-sm bg-background" />
        <span className="grid grid-cols-3 gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-5 rounded-sm border border-primary/40 bg-background" />
          ))}
        </span>
      </>
    ),
  },
  {
    value: "first",
    name: "First item",
    description: "Follows the tab's order",
    sketch: (
      <span className="flex h-full gap-1.5">
        <span className="flex w-1/4 flex-col gap-1">
          <span className="h-1.5 rounded-sm bg-primary/60" />
          <span className="h-1.5 rounded-sm bg-background" />
          <span className="h-1.5 rounded-sm bg-background" />
        </span>
        <span className="flex flex-1 flex-col gap-1">
          <span className="h-2 w-2/3 rounded-sm bg-foreground/30" />
          <span className="h-1.5 rounded-sm bg-background" />
          <span className="h-1.5 w-5/6 rounded-sm bg-background" />
        </span>
      </span>
    ),
  },
  {
    value: "page",
    name: "A page you choose",
    description: "Any article or collection here",
    sketch: (
      <span className="flex h-full gap-1.5">
        <span className="flex w-1/4 flex-col gap-1">
          <span className="h-1.5 rounded-sm bg-background" />
          <span className="h-1.5 rounded-sm bg-background" />
          <span className="h-1.5 rounded-sm bg-primary/60" />
        </span>
        <span className="flex flex-1 flex-col gap-1">
          <span className="h-2 w-2/3 rounded-sm bg-foreground/30" />
          <span className="h-1.5 rounded-sm bg-background" />
          <span className="h-1.5 w-5/6 rounded-sm bg-background" />
        </span>
      </span>
    ),
  },
];

/** A tab, with its settings: what its path shows and the pages it can show (its collections and articles). */
export type TabSettings = CollectionOption & {
  landing: DocsLanding;
  landingPage: string | null;
  /** Who can read it, with its groups' keys (for access "groups"). */
  access: Access;
  groups: string[];
  pages: { collections: CollectionOption[]; articles: { slug: string; title: string; published: boolean }[] };
};

/**
 * A tab's address (`home`: the first tab's is /docs) and what its path shows, as form fields
 * (`landing`, and `landingPage` for a page picked from the tab's).
 */
function TabLandingFields({ id, tab, home }: { id: string; tab: TabSettings; home: boolean }) {
  const [landing, setLanding] = useState(tab.landing);
  const pageItems = [
    ...tab.pages.collections.map((c) => ({ value: c.slug, label: c.name })),
    ...tab.pages.articles.map((a) => ({ value: a.slug, label: a.published ? a.title : `${a.title} (draft)` })),
  ];
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`tab-address-${id}`}>Address</FieldLabel>
        <Input id={`tab-address-${id}`} readOnly value={home ? "/docs" : `/docs/${tab.slug}`} className="font-mono" />
        <FieldDescription>{home ? "Your docs' home: the first tab is at /docs." : "It follows the name."}</FieldDescription>
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Landing page</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {LANDING_CHOICES.map((choice) => (
            <label
              key={choice.value}
              className="flex cursor-pointer flex-col gap-2 rounded-xl border p-3 transition-colors has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-2 has-focus-visible:ring-ring"
            >
              <input
                type="radio"
                name="landing"
                value={choice.value}
                checked={landing === choice.value}
                onChange={() => setLanding(choice.value)}
                className="sr-only"
              />
              <span aria-hidden className="flex h-14 flex-col gap-1.5 rounded-md bg-muted p-2">
                {choice.sketch}
              </span>
              <span className="text-sm font-medium">{choice.name}</span>
              <span className="text-xs text-muted-foreground">{choice.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {landing === "page" && (
        <Field>
          <FieldLabel id={`tab-page-${id}`}>Page</FieldLabel>
          {pageItems.length > 0 ? (
            <Select name="landingPage" items={pageItems} defaultValue={tab.landingPage}>
              <SelectTrigger className="w-full" aria-labelledby={`tab-page-${id}`}>
                <SelectValue placeholder="Pick an article or collection" />
              </SelectTrigger>
              <SelectContent>
                {tab.pages.collections.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Collections</SelectLabel>
                    {pageItems.slice(0, tab.pages.collections.length).map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {tab.pages.articles.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Articles</SelectLabel>
                    {pageItems.slice(tab.pages.collections.length).map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          ) : (
            <FieldDescription>This tab has no articles or collections yet.</FieldDescription>
          )}
          <FieldDescription>Readers who can&apos;t read it (a draft, or a collection for some groups) get the overview.</FieldDescription>
        </Field>
      )}
    </>
  );
}

/** A tab page's Settings: its name, address and landing page (`home`: it's the first tab). */
export function TabSettingsForm({ projectSlug, tab, home }: { projectSlug: string; tab: TabSettings; home: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveTab(projectSlug, tab.slug, prev, formData);
    if (!result.error) {
      toast.success("Tab saved");
    }
    return result;
  }, {});
  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`tab-name-${tab.slug}`}>Name</FieldLabel>
          <Input id={`tab-name-${tab.slug}`} name="name" defaultValue={tab.name} placeholder="Guides" maxLength={40} required />
        </Field>
        <TabLandingFields id={tab.slug} tab={tab} home={home} />
        {state.error && <FieldError>{state.error}</FieldError>}
        <SaveButton pending={pending} />
      </FieldGroup>
    </form>
  );
}

/**
 * Adds a tab (`tab` undefined; the first one takes the collections there are, which the dialog
 * says), or a tab's settings: its name, its address (`home`: the first tab's is /docs), what
 * its path shows and who can read it (`access`: the project's groups to pick from).
 */
export function TabDialog({
  projectSlug,
  tab,
  first = false,
  home = false,
  access,
}: {
  projectSlug: string;
  tab?: TabSettings;
  first?: boolean;
  home?: boolean;
  access?: AccessChoices;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveTab(projectSlug, tab?.slug ?? null, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success(tab ? "Tab saved" : "Tab added");
    }
    return result;
  }, {});
  const id = tab?.slug ?? "new";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {tab ? (
        <DialogTrigger render={<Button variant="ghost" size="sm" aria-label={`Settings for ${tab.name}`} />}>Settings</DialogTrigger>
      ) : (
        <DialogTrigger render={<Button variant="ghost" size="sm" className="justify-start font-normal" />}>
          <PlusIcon aria-hidden className="text-muted-foreground" />
          New tab
        </DialogTrigger>
      )}
      <DialogContent className={tab && "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"}>
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>{tab ? "Tab settings" : "New tab"}</DialogTitle>
            {!tab && (
              <DialogDescription>
                Tabs sit at the top of your docs, each with its own collections
                {first ? ". Your collections go in this first one, and you can move them to the next ones." : "."}
              </DialogDescription>
            )}
          </DialogHeader>
          <FieldGroup className="my-4">
            <Field data-invalid={state.error && !tab ? true : undefined}>
              <FieldLabel htmlFor={`tab-name-${id}`}>Name</FieldLabel>
              <Input
                id={`tab-name-${id}`}
                name="name"
                defaultValue={tab?.name}
                placeholder="Guides"
                maxLength={40}
                required
                aria-invalid={state.error && !tab ? true : undefined}
              />
              {state.error && !tab && <FieldError>{state.error}</FieldError>}
            </Field>
            {tab && (
              <>
                <TabLandingFields id={id} tab={tab} home={home} />
                {access && (
                  <WhoCanRead
                    id={`tab-access-${id}`}
                    projectSlug={projectSlug}
                    groups={access.groups}
                    inherit={{ label: "Inherit", description: access.inherits[""]! }}
                    defaultAccess={tab.access}
                    defaultGroups={tab.groups}
                  />
                )}
                {state.error && <FieldError>{state.error}</FieldError>}
              </>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {tab ? "Save" : "Add tab"}
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
              ? `Its collections move to ${movesTo}, with their articles. They keep who can read them.`
              : "It's the last tab, so your docs go back to one page with all your collections. They keep who can read them."}
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
