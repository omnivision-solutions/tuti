"use client";

import type { Doc, MediaUrls } from "@tuti/content";
import { editedSections } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useActionState, useContext, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { IconField } from "@/components/icon-field";
import { BARE_TITLE, RichEditor } from "@/components/rich-editor";
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
import { afterOwnSave } from "@/lib/article-saves";
import { keepingFields } from "@/lib/forms";
import { previewUrl } from "@/lib/portal-base";
import type { Access, WithoutAccess } from "@/lib/read-access";
import type { AccessChoices } from "@/server/docs-queries";
import type { ArticleSaveState, NewestVersion as NewestVersionData } from "@/server/docs";
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
  published: boolean;
  /** The newest version as the editor opened (its id from articles.revisions): saves say they were made on it. */
  revision: string | null;
};
type CollectionOption = { slug: string; name: string };
/** An article's collection and "Show the updated date": in its Settings panel. */
export type ArticlePlace = { collection: string | null; showUpdatedDate: boolean };

const ARTICLE_FORM = "article-form";
const ArticleEditorContext = createContext<{
  pending: boolean;
  setPending: (pending: boolean) => void;
  /** A new article's: picked in the panel, sent by its form's "Save draft" (a saved article's panel saves its own). */
  place: ArticlePlace;
  setPlace: (place: ArticlePlace) => void;
  collections: CollectionOption[];
} | null>(null);

/**
 * An article's editor: what ArticleSaveButton (in the top bar) and ArticleSettings (its panel) share
 * with its ArticleForm (below it): whether it's saving, the collections, and a new article's place.
 */
export function ArticleEditor({
  collections,
  defaultCollection = null,
  children,
}: {
  collections: CollectionOption[];
  /** A new article's collection to start with (a collection's "New article"). */
  defaultCollection?: string | null;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [place, setPlace] = useState<ArticlePlace>({ collection: defaultCollection, showUpdatedDate: true });
  return <ArticleEditorContext value={{ pending, setPending, place, setPlace, collections }}>{children}</ArticleEditorContext>;
}

/**
 * An article's place as a form sends it (`showUpdatedDate` "on" or "off"). With `loaded` (what the
 * form opened with), only what was changed since: what someone else saved meanwhile stays.
 */
export function PlaceFields({ place, loaded }: { place: ArticlePlace; loaded?: ArticlePlace }) {
  return (
    <>
      {place.collection !== loaded?.collection && <input type="hidden" name="collection" value={place.collection ?? ""} />}
      {place.showUpdatedDate !== loaded?.showUpdatedDate && (
        <input type="hidden" name="showUpdatedDate" value={place.showUpdatedDate ? "on" : "off"} />
      )}
    </>
  );
}

/** The ArticleEditor around it. */
export function useArticleEditor() {
  const editor = useContext(ArticleEditorContext);
  if (!editor) {
    throw new Error("useArticleEditor needs an ArticleEditor around it");
  }
  return editor;
}

/** The article's Save in the top bar, from tablet width up: it submits the ArticleForm below. */
export function ArticleSaveButton() {
  const { pending } = useArticleEditor();
  return (
    <Button type="submit" form={ARTICLE_FORM} disabled={pending} className="phonebar:hidden">
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

/** Writes a new article (`article` null) or edits one: title and text (its collection and settings are in ArticleSettings). */
export function ArticleForm({
  projectSlug,
  article,
  mediaUrls,
  defaultTitle,
}: {
  projectSlug: string;
  article: Article | null;
  mediaUrls: MediaUrls | null;
  /** A new article's title to start with (a question from the insights' gaps). */
  defaultTitle?: string;
}) {
  // The text shown (`opened`) and the version its saves are made on (`base`), kept while it has edits not saved,
  // whatever is saved meanwhile (Autopilot's edit landing, a teammate's save): what was typed is never replaced, and its
  // save says the version it was made on. With nothing unsaved, a newer saved version starts the form afresh (`shown`).
  // After its own save the next is made on that one, even if more was typed while it saved (that stays too).
  const [opened, setOpened] = useState(article);
  const [base, setBase] = useState(article?.revision ?? null);
  const [shown, setShown] = useState(0);
  const [dirty, setDirty] = useState(false);
  // The text as it last had the article (as opened, or as it last sent): its save says which sections its user changed
  // since, so only those go in (the rest staying as they are now, whoever changed them).
  const [had, setHad] = useState<Doc | null>(article?.content ?? null);
  // The title as typed, and whether its user changed it since it opened or last saved.
  const [title, setTitle] = useState(article?.title ?? defaultTitle ?? "");
  const [titleChanged, setTitleChanged] = useState(false);
  // Title changes counted: one made while a save runs keeps it changed after it.
  const titleChanges = useRef(0);
  // After its own save merged Autopilot's edits in while more was typed: the version saved, which the next save saw.
  const [seenSaved, setSeenSaved] = useState<NewestVersionData | null>(null);
  // The version that save left: its own, for the next save to say (edits landing after it are layered on, not "someone's").
  const [own, setOwn] = useState<string | null>(null);
  // Changes made, counted: one made while a save runs keeps the form unsaved after it.
  const changes = useRef(0);
  const changed = () => {
    changes.current++;
    setDirty(true);
  };
  const newer = article !== null && article.revision !== base;
  // (Set as it renders, as React has it for state that follows a prop.)
  if (newer && !dirty) {
    setOpened(article);
    setBase(article.revision);
    setShown(shown + 1);
    setTitle(article.title);
    setTitleChanged(false);
    setHad(article.content);
    setSeenSaved(null);
    setOwn(null);
  }
  const [state, action, pending] = useActionState<ArticleSaveState, FormData>(async (prev, formData) => {
    const before = changes.current;
    const titleBefore = titleChanges.current;
    const sent = formData.get("content");
    const text: Doc = sent ? (JSON.parse(String(sent)) as Doc) : { type: "doc", content: [] };
    if (had) {
      formData.set("edited", JSON.stringify(editedSections(had, text)));
    }
    const result = await saveArticle(projectSlug, article?.slug ?? null, prev, formData);
    // A save that changed nothing (no new version) leaves the editor as it was: its version, what it had, its own.
    const unchanged = result.saved?.newVersion === false;
    if (!result.error) {
      // What it sent is what it has now, for its next save to say what changed since.
      if (!unchanged) {
        setHad(text);
      }
      // The title it sent is saved: not changed any more, unless typed in again while it saved.
      if (titleChanges.current === titleBefore) {
        setTitleChanged(false);
      }
      if (changes.current === before) {
        setDirty(false);
      } else if (result.saved && !unchanged) {
        // Typed while it saved: kept, its next save made on what it matches (afterOwnSave).
        const next = afterOwnSave(base, result.saved);
        setBase(next.base);
        // Seen only as it's shown beside the text (NewestVersion below).
        setSeenSaved(next.show && result.saved.version ? result.saved.version : null);
        setOwn(next.own);
      }
      toast.success("Saved");
    }
    return result;
  }, {});
  // The top bar's Save (ArticleSaveButton) says when it's saving too.
  const { setPending, place } = useArticleEditor();
  useEffect(() => setPending(pending), [setPending, pending]);

  return (
    <form id={ARTICLE_FORM} {...keepingFields(action)} onInput={changed}>
      {/* A new article's place, from the Settings panel (a saved one's panel saves it). */}
      {!article && <PlaceFields place={place} />}
      {/* The version this text was made on, and after a refusal the newest one shown beside it: the next save (merged
          by hand) goes on top of that, keeping Autopilot's edits to other parts. */}
      {opened && <input type="hidden" name="revision" value={base ?? ""} />}
      {(state.newest ?? seenSaved)?.revision && <input type="hidden" name="seen" value={(state.newest ?? seenSaved)!.revision!} />}
      {own && <input type="hidden" name="own" value={own} />}
      <FieldGroup key={shown}>
        {/* Written as it's published: the title, then the text, no boxes. */}
        <div className="flex flex-col gap-1">
          {/* A saved article's title is sent only once changed here (since it opened or last saved): one left alone keeps
              whatever it's renamed to meanwhile, and a change back to how it opened still counts. */}
          {(!opened || titleChanged) && <input type="hidden" name="title" value={title} />}
          <input
            aria-label="Title"
            value={title}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
              setTitleChanged(true);
              titleChanges.current++;
            }}
            placeholder="What it helps with, e.g. Inviting your team"
            required
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "article-error" : undefined}
            className={`${BARE_TITLE} text-3xl`}
          />
          {state.error && <FieldError id="article-error">{state.error}</FieldError>}
          {newer && dirty && !state.newest && !seenSaved && (
            <p className="text-sm text-muted-foreground">It was saved since you opened it. Your text is kept: save it to see whether anything needs merging.</p>
          )}
        </div>
        {state.newest ? <NewestVersion newest={state.newest} /> : seenSaved && <NewestVersion newest={seenSaved} merged />}
        <RichEditor
          bare
          profile="article"
          name="content"
          label="Article"
          placeholder="Explain it step by step. Type / for headings, lists and more"
          initial={opened?.content}
          // Every change counts, pasted or formatted too (they fire no input event).
          onChange={changed}
          uploads={mediaUrls ? { projectSlug, mediaUrls } : undefined}
        />
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {article?.published && (
            <p className="text-sm text-muted-foreground">Changes to the title, collection and text go live when you publish them.</p>
          )}
          {/* An article's page has Save in the top bar from tablet width up (ArticleSaveButton); a new one keeps it here. */}
          <Button type="submit" disabled={pending} className={cn(article && "topbar:hidden")}>
            {pending ? "Saving…" : article ? "Save" : "Save draft"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/**
 * The article's newest version beside the teammate's own text, after it changed since they opened it (Autopilot's edit
 * to the same part, or someone's save): their text stays in the editor, never replaced; they merge what they need by
 * hand, then save on top of it.
 */
function NewestVersion({ newest, merged = false }: { newest: NewestVersionData; merged?: boolean }) {
  return (
    <section aria-labelledby="newest-version" className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-4">
      <h2 id="newest-version" className="text-base font-semibold">
        {merged
          ? newest.byAutopilot
            ? "Saved, with Autopilot's edit to another part"
            : "Saved, with a change since to another part"
          : newest.byAutopilot
            ? "The newest version, with Autopilot's edit"
            : "The newest version, saved since you opened it"}
      </h2>
      <p className="text-sm text-muted-foreground">
        {merged
          ? `Your save kept ${newest.byAutopilot ? "Autopilot's edit" : "a change saved since"} to another part, as saved here. What you typed while it saved is below, without it: Save again and yours is kept where you changed it, the rest as saved.`
          : "Your text below is as you left it. Copy what you need from this into it, then Save: yours is kept where you both changed it, and the rest of the newest version stays."}
      </p>
      {/* Scrolls: focusable, so it scrolls from the keyboard too. */}
      <div tabIndex={0} role="region" aria-label="Its text" className="max-h-96 overflow-y-auto rounded-lg border bg-background p-3">
        <p className="mb-2 font-semibold">{newest.title}</p>
        <RichText doc={newest.content} mediaUrls={newest.mediaUrls} className="rich-text text-sm" />
      </div>
    </section>
  );
}

/** Publish (or take down) and delete an article; publishing and deleting ask first. */
export function ArticleActions({
  projectSlug,
  slug,
  title,
  published,
  part,
}: {
  projectSlug: string;
  slug: string;
  title: string;
  published: boolean;
  /** Delete (behind the top bar's "More actions"), or Publish / Unpublish (in the bar). */
  part: "delete" | "publish";
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

  if (part === "delete") {
    return (
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
    );
  }
  return published ? (
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
  const [open, setOpen] = useState(false);
  // Restoring it takes out Autopilot's edits waiting in the changes: said, then restored (dismissing them) only if asked again.
  const [takesOut, setTakesOut] = useState<{ message: string; edits: string[] } | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
          setTakesOut(null);
        }
      }}
    >
      <AlertDialogTrigger render={<Button disabled={pending} />}>Restore this version</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore this version?</AlertDialogTitle>
          {/* Announced when it changes to what the version takes out (the button's name changes with it). */}
          <AlertDialogDescription aria-live="polite">
            {takesOut?.message ?? (
              <>
                {published
                  ? "It replaces the current text as unpublished changes: readers see it once you publish them."
                  : "It replaces the draft's current text."}{" "}
                The current version stays in the history.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            disabled={pending}
            focusableWhenDisabled
            onClick={() =>
              startTransition(async () => {
                // The edits named, and only those: one landing meanwhile is named again.
                const result = await restoreArticle(projectSlug, slug, revision, takesOut?.edits ?? []);
                if (result.confirm) {
                  setTakesOut(result.confirm);
                } else if (result.error) {
                  toast.error(result.error);
                } else {
                  setOpen(false);
                  toast.success("Version restored");
                  router.push(`/app/${projectSlug}/docs/${result.slug}`);
                }
              })
            }
          >
            {takesOut ? "Restore and dismiss" : "Restore"}
          </Button>
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
  /** The collection it's in, or null at the top level. */
  parent: string | null;
  /** Its Lucide icon's name, and whether the installed Lucide has it. */
  icon: string | null;
  knownIcon: boolean;
};

/** A collection's name (with `error`, a refused save's), icon and description, as form fields; `collection` gives their values. */
function CollectionFields({ id, collection, error, onIconChange }: { id: string; collection?: CollectionSettings; error?: string; onIconChange?: () => void }) {
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
      <IconField defaultValue={collection?.icon ?? null} known={collection?.knownIcon ?? true} onChange={onIconChange} />
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
}: {
  id: string;
  parents: CollectionOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
}) {
  const items = [{ value: null, label: "None (top level)" }, ...parents.map((c) => ({ value: c.slug, label: c.name }))];
  return (
    <Field>
      <FieldLabel id={`${id}-parent-label`}>Parent collection</FieldLabel>
      <Select name="parent" items={items} value={value} onValueChange={(next) => onValueChange(next as string | null)}>
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

/**
 * A collection's settings page: its name, icon, description and the collection it's in (`parents`: where it can
 * go), then who can read it (as AccessForm's; "Inherit" says what the parent picked lets read, or its tab `tab`), all saved by one Save.
 */
export function CollectionSettingsForm({
  projectSlug,
  collection,
  parents,
  access,
  path,
  tab,
  level,
}: {
  projectSlug: string;
  collection: CollectionSettings;
  parents: CollectionOption[];
  access: AccessChoices;
  path: string;
  tab: string | null;
  level: { access: Access; groups: string[]; noAccess: WithoutAccess };
}) {
  const [parent, setParent] = useState(collection.parent);
  const above = parent ?? tab ?? "";
  // The fields the person changed here since the form opened or last saved: a save sends only those (one set back
  // as it was too), never one left alone, so it doesn't undo a change made elsewhere; a refresh keeps what's typed.
  const touched = useRef(new Set<string>());
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const sent = new Set(touched.current);
    // Groups go with "Specific groups": both, or neither.
    if (sent.has("access") || sent.has("groups")) {
      sent.add("access").add("groups");
    }
    for (const key of ["name", "description", "icon", "parent", "access", "groups", "noAccess"]) {
      if (!sent.has(key)) {
        formData.delete(key);
      }
    }
    // Cleared as it's sent, so a field changed while it saves is marked anew; back if it fails.
    sent.forEach((key) => touched.current.delete(key));
    const result = await saveCollection(projectSlug, collection.slug, prev, formData);
    if (result.error) {
      sent.forEach((key) => touched.current.add(key));
    } else {
      toast.success("Collection saved");
    }
    return result;
  }, {});
  return (
    <form
      {...keepingFields(action)}
      onChange={(event) => {
        // A field the person typed in or picked (by its name; the icon and the parent say so themselves).
        const name = (event.target as Element).getAttribute("name");
        if (name) {
          touched.current.add(name);
        }
      }}
      className="flex flex-col gap-6"
    >
      <Card role="region" aria-labelledby="collection-details-title">
        <CardHeader>
          <CardTitle id="collection-details-title">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <CollectionFields id={collection.slug} collection={collection} error={state.error} onIconChange={() => touched.current.add("icon")} />
            <ParentField
              id={`collection-${collection.slug}`}
              parents={parents}
              value={parent}
              onValueChange={(next) => {
                touched.current.add("parent");
                setParent(next);
              }}
            />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card role="region" aria-labelledby="collection-access-title">
        <CardHeader>
          <CardTitle id="collection-access-title">Access</CardTitle>
        </CardHeader>
        <CardContent>
          <WhoCanRead
            id={`collection-access-${collection.slug}`}
            projectSlug={projectSlug}
            groups={access.groups}
            inherit={{ label: "Inherit", description: access.inherits[above] ?? access.inherits[""]!, shows: access.shows[above] ?? "hide" }}
            defaultAccess={level.access}
            defaultGroups={level.groups}
            defaultNoAccess={level.noAccess}
            preview={previewUrl(access, path)}
          />
        </CardContent>
      </Card>
      <SaveButton pending={pending} />
    </form>
  );
}

/**
 * A tab's page's Access: who can read it and what people without access see, with "Preview as a reader"
 * (`path`: its page in the portal). `above` is the level it inherits from ("" for a tab), `level` what it has now.
 */
export function AccessForm({
  projectSlug,
  slug,
  path,
  access,
  above,
  level,
}: {
  projectSlug: string;
  slug: string;
  path: string;
  access: AccessChoices;
  above: string;
  level: { access: Access; groups: string[]; noAccess: WithoutAccess };
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveTab(projectSlug, slug, prev, formData);
    if (!result.error) {
      toast.success("Tab saved");
    }
    return result;
  }, {});
  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <WhoCanRead
          id={`tab-access-${slug}`}
          projectSlug={projectSlug}
          groups={access.groups}
          inherit={{ label: "Inherit", description: access.inherits[above] ?? access.inherits[""]!, shows: access.shows[above] ?? "hide" }}
          defaultAccess={level.access}
          defaultGroups={level.groups}
          defaultNoAccess={level.noAccess}
          preview={previewUrl(access, path)}
        />
        {state.error && <FieldError>{state.error}</FieldError>}
        <SaveButton pending={pending} />
      </FieldGroup>
    </form>
  );
}


/**
 * Adds a collection, at the top level (of a tab, with tabs) or in one of `parents`: the dialog a
 * "+" menu opens (`open`), starting where it was opened.
 */
export function CollectionDialog({
  projectSlug,
  parents,
  tabs,
  access,
  open,
  onOpenChange,
  defaultParent,
  defaultTab,
}: {
  projectSlug: string;
  /** For "Who can read": the project's groups, and what each tab and collection lets read. */
  access: AccessChoices;
  /** The collections a new one can go in (the ones less than 5 levels deep), named with the ones they're in. */
  parents: CollectionOption[];
  /** The tabs a new top-level one can go in, the first by default. */
  tabs: CollectionOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where it goes to start with: in collection `defaultParent`, else at the top level of tab `defaultTab`. */
  defaultParent: string | null;
  defaultTab?: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveCollection(projectSlug, null, prev, formData);
    if (!result.error) {
      onOpenChange(false);
      toast.success("Collection added");
    }
    return result;
  }, {});
  const tabItems = tabs.map((s) => ({ value: s.slug, label: s.name }));
  // Its place, as picked: it inherits from there.
  const [parent, setParent] = useState<string | null>(defaultParent);
  const [tab, setTab] = useState<string | null>(defaultTab ?? tabItems[0]?.value ?? null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
          </DialogHeader>
          <FieldGroup className="my-4">
            <CollectionFields id="new" error={state.error} />
            {parents.length > 0 && <ParentField id="collection" parents={parents} value={parent} onValueChange={setParent} />}
            {tabItems.length > 0 && (
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
              id="collection-access-new"
              projectSlug={projectSlug}
              groups={access.groups}
              inherit={{ label: "Inherit", description: access.inherits[parent ?? tab ?? ""] ?? access.inherits[""]!, shows: access.shows[parent ?? tab ?? ""] ?? "hide" }}
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Add collection
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
    description: "A card per collection",
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

/** "New tab": adds one, after the others (`first`: the first one, which takes the collections there are, as the dialog says). */
export function TabDialog({ projectSlug, first = false }: { projectSlug: string; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveTab(projectSlug, null, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success("Tab added");
    }
    return result;
  }, {});
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" className="justify-start font-normal" />}>
        <PlusIcon aria-hidden className="text-muted-foreground" />
        New tab
      </DialogTrigger>
      <DialogContent>
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>New tab</DialogTitle>
            <DialogDescription>
              Tabs sit at the top of your docs, each with its own collections
              {first ? ". Your collections go in this first one, and you can move them to the next ones." : "."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-4">
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor="tab-name-new">Name</FieldLabel>
              <Input id="tab-name-new" name="name" placeholder="Guides" maxLength={40} required aria-invalid={state.error ? true : undefined} />
              {state.error && <FieldError>{state.error}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Add tab
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

/** "Dismiss" on a gap or a failed search in the insights: hides the question (from Home too) until someone asks it again. */
export function DismissGapButton({ projectSlug, question }: { projectSlug: string; question: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Dismiss “${question}”`}
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
