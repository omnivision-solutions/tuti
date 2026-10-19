"use client";

import type { Doc } from "@tuti/content";
import { useActionState, useState, useTransition } from "react";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  deleteChangelogEntry,
  draftChangelogEntry,
  publishChangelogEntry,
  saveChangelogEntry,
  unpublishChangelogEntry,
} from "@/server/changelog";
import type { FormState } from "@/server/form-state";

export const TAG_LABELS = { new: "New", improved: "Improved", fixed: "Fixed", breaking: "Breaking" } as const;
export type TagName = keyof typeof TAG_LABELS;

type Entry = { number: number; title: string; content: Doc; tags: TagName[]; posts: number[]; published: boolean };
type PostOption = { number: number; title: string; status: string };

/** Writes a new entry (`entry` null) or edits one: title, tags, text and the posts it completes. */
export function ChangelogForm({
  projectSlug,
  entry,
  posts,
  mediaBaseUrl,
}: {
  projectSlug: string;
  entry: Entry | null;
  /** Posts it can complete: planned, in progress, done, and the ones it already lists. */
  posts: PostOption[];
  mediaBaseUrl: string | null;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveChangelogEntry(projectSlug, entry?.number ?? null, prev, formData);
    if (!result.error) {
      toast.success("Saved");
    }
    return result;
  }, {});

  return (
    <form action={action}>
      <FieldGroup>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="entry-title">Title</FieldLabel>
          <Input
            id="entry-title"
            name="title"
            defaultValue={entry?.title}
            placeholder="What shipped, in a few words"
            required
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "entry-error" : undefined}
          />
          {state.error && <FieldError id="entry-error">{state.error}</FieldError>}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Tags</legend>
          <div className="flex flex-wrap gap-4">
            {(Object.keys(TAG_LABELS) as TagName[]).map((tag) => (
              <label key={tag} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="tags" value={tag} defaultChecked={entry?.tags.includes(tag)} className="size-4 accent-primary" />
                {TAG_LABELS[tag]}
              </label>
            ))}
          </div>
        </fieldset>
        <Field>
          <FieldLabel id="entry-body-label">What changed</FieldLabel>
          <RichEditor
            profile="changelog"
            name="content"
            labelledBy="entry-body-label"
            placeholder="What's new for people, and how to use it"
            initial={entry?.content}
            uploads={mediaBaseUrl ? { projectSlug, mediaBaseUrl } : undefined}
          />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Posts it completes</legend>
          {entry?.published ? (
            <>
              <p className="text-sm text-muted-foreground">Unpublish the entry to change these.</p>
              <ul className="flex flex-col gap-1 text-sm">
                {posts
                  .filter((post) => entry.posts.includes(post.number))
                  .map((post) => (
                    <li key={post.number}>
                      #{post.number} {post.title}
                    </li>
                  ))}
              </ul>
            </>
          ) : (
            <>
              <input type="hidden" name="postsEditable" value="1" />
              <p className="text-sm text-muted-foreground">Publishing marks them Completed and tells the people who asked.</p>
              {posts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No planned, in-progress or completed posts yet.</p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
                  {posts.map((post) => (
                    <li key={post.number}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="posts"
                          value={post.number}
                          defaultChecked={entry?.posts.includes(post.number)}
                          className="size-4 accent-primary"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          #{post.number} {post.title}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{post.status}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </fieldset>
        <Button type="submit" disabled={pending} className="self-end">
          {pending ? "Saving…" : entry ? "Save" : "Save draft"}
        </Button>
      </FieldGroup>
    </form>
  );
}

const DRAFTED = "Drafted with AI";

/**
 * Draft with AI, publish (or take down) and delete an entry. An AI draft replaces
 * the text and publishing emails people, so they ask first, like deleting.
 */
export function ChangelogEntryActions({
  projectSlug,
  number,
  title,
  published,
  postCount,
  canDraftWithAi,
}: {
  projectSlug: string;
  number: number;
  title: string;
  published: boolean;
  /** How many posts it completes. */
  postCount: number;
  /** AI is set up on this server and the entry is a draft. */
  canDraftWithAi: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState("");
  const run = (action: typeof publishChangelogEntry, done: string) =>
    startTransition(async () => {
      setRunning(done);
      const result = await action(projectSlug, number);
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
              It&apos;s removed from the changelog{published ? " on your portal" : ""}. Posts keep their status.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={() => run(deleteChangelogEntry, "Deleted")}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {canDraftWithAi && (
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="outline" disabled={pending} />}>
            {pending && running === DRAFTED ? "Drafting…" : "Draft with AI"}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace the text with an AI draft?</AlertDialogTitle>
              <AlertDialogDescription>
                AI writes release notes from the entry&apos;s pull requests and the posts it completes. They replace
                the text now, including changes you haven&apos;t saved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={pending} onClick={() => run(draftChangelogEntry, DRAFTED)}>
                Replace the text
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {published ? (
        <Button variant="outline" disabled={pending} onClick={() => run(unpublishChangelogEntry, "Unpublished")}>
          Unpublish
        </Button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger render={<Button disabled={pending} />}>Publish</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Publish “{title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                It appears on your portal&apos;s changelog.
                {postCount > 0 &&
                  ` ${postCount === 1 ? "The post it completes becomes" : `The ${postCount} posts it completes become`} Completed, and the people who asked get an email.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={pending} onClick={() => run(publishChangelogEntry, "Published")}>
                Publish
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
