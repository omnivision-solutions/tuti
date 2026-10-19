"use client";

import type { Doc } from "@tuti/content";
import { type FormEvent, startTransition, useActionState, useState, useTransition } from "react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/server/form-state";
import { deleteArticle, deleteCollection, publishArticle, saveArticle, saveCollection, unpublishArticle } from "@/server/help";

/**
 * Runs a form's action without React's reset of the form afterwards (which `<form action>` does
 * even when the save is refused), so a rejected save keeps what was typed.
 */
const keepingFields = (action: (formData: FormData) => void) => (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  startTransition(() => action(formData));
};

type Article = { slug: string; title: string; content: Doc; collection: string | null };
type CollectionOption = { slug: string; name: string };

/** Writes a new article (`article` null) or edits one: title, collection and text. */
export function ArticleForm({
  projectSlug,
  article,
  collections,
  mediaBaseUrl,
}: {
  projectSlug: string;
  article: Article | null;
  collections: CollectionOption[];
  mediaBaseUrl: string | null;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveArticle(projectSlug, article?.slug ?? null, prev, formData);
    if (!result.error) {
      toast.success("Saved");
    }
    return result;
  }, {});
  const items = [{ value: null, label: "No collection" }, ...collections.map((c) => ({ value: c.slug, label: c.name }))];

  return (
    <form onSubmit={keepingFields(action)}>
      <FieldGroup>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="article-title">Title</FieldLabel>
          <Input
            id="article-title"
            name="title"
            defaultValue={article?.title}
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
        <Button type="submit" disabled={pending} className="self-end">
          {pending ? "Saving…" : article ? "Save" : "Save draft"}
        </Button>
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
              {published ? "It's removed from your help center, and links to it stop working." : "The draft is gone for good."}
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
                Anyone can read it in your portal&apos;s help center, and search engines can find it.
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

/** Adds a collection, or (with `collection`) renames one and changes its description. */
export function CollectionDialog({
  projectSlug,
  collection,
}: {
  projectSlug: string;
  collection?: { slug: string; name: string; description: string };
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={collection ? "ghost" : "outline"} size="sm" />}>
        {collection ? "Edit" : "New collection"}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={keepingFields(action)}>
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
                placeholder="Optional, shown in your help center"
              />
            </Field>
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

export function DeleteCollectionButton({ projectSlug, slug, name }: { projectSlug: string; slug: string; name: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>Its articles stay, without a collection.</AlertDialogDescription>
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
