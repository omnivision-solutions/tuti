"use client";

import type { Editor } from "@tiptap/react";
import type { Doc, MediaUrls } from "@tuti/content";
import { SparklesIcon } from "lucide-react";
import { type RefObject, useActionState, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { diffLines } from "@/lib/line-diff";
import { DiffLines } from "@/components/line-diff";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  acceptChangelogRewrite,
  type ChangelogRewrite,
  deleteChangelogEntry,
  draftChangelogEntry,
  publishChangelogEntry,
  rewriteChangelogEntry,
  saveChangelogEntry,
  saveChangelogStyle,
  unpublishChangelogEntry,
} from "@/server/changelog";
import type { FormState } from "@/server/form-state";
import type { RewriteMode } from "@/server/release-notes";

const TAG_LABELS = { new: "New", improved: "Improved", fixed: "Fixed", breaking: "Breaking" } as const;
export type TagName = keyof typeof TAG_LABELS;

type Entry = { number: number; title: string; content: Doc; tags: TagName[]; posts: number[]; published: boolean };
type PostOption = { number: number; title: string; status: string };

/** Writes a new entry (`entry` null) or edits one: title, tags, text and the posts it completes. */
export function ChangelogForm({
  projectSlug,
  entry,
  posts,
  mediaUrls,
  canEditWithAi = false,
  aiPaused = false,
}: {
  projectSlug: string;
  entry: Entry | null;
  /** Posts it can complete: planned, in progress, done, and the ones it already lists. */
  posts: PostOption[];
  mediaUrls: MediaUrls | null;
  /** AI is set up on this server: the editor gets its helpers (for saved entries). */
  canEditWithAi?: boolean;
  /** The project is out of AI credits: the helpers show, disabled. */
  aiPaused?: boolean;
}) {
  const editor = useRef<Editor | null>(null);
  // Changes not saved yet: the AI helpers edit the saved text, and accepting would lose them.
  const [dirty, setDirty] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveChangelogEntry(projectSlug, entry?.number ?? null, prev, formData);
    if (!result.error) {
      setDirty(false);
      toast.success("Saved");
    }
    return result;
  }, {});

  return (
    // Typing in the form (dialogs in portals, like the AI helpers' instruction, aren't in it).
    <form {...keepingFields(action)} onInput={(event) => event.currentTarget.contains(event.target as Node) && setDirty(true)}>
      <FieldGroup>
        {/* Written as it's published: tags, the title, then the text, no boxes. */}
        <div className="flex flex-col gap-2">
          <fieldset className="flex flex-wrap gap-4">
            <legend className="sr-only">Tags</legend>
            {(Object.keys(TAG_LABELS) as TagName[]).map((tag) => (
              <label key={tag} className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="tags" value={tag} defaultChecked={entry?.tags.includes(tag)} className="size-4 accent-primary" />
                {TAG_LABELS[tag]}
              </label>
            ))}
          </fieldset>
          <input
            name="title"
            aria-label="Title"
            defaultValue={entry?.title}
            placeholder="What shipped, in a few words"
            required
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "entry-error" : undefined}
            className={`${BARE_TITLE} text-2xl`}
          />
          {state.error && <FieldError id="entry-error">{state.error}</FieldError>}
        </div>
        <div className="flex flex-col gap-2">
          {entry && canEditWithAi && (
            <div className="flex justify-end">
              <AiHelpers projectSlug={projectSlug} number={entry.number} editor={editor} dirty={dirty} paused={aiPaused} />
            </div>
          )}
          <RichEditor
            bare
            profile="changelog"
            name="content"
            label="What changed"
            placeholder="What's new for people, and how to use it. Type / for headings, lists and more"
            initial={entry?.content}
            uploads={mediaUrls ? { projectSlug, mediaUrls } : undefined}
            editorRef={editor}
            onChange={() => setDirty(true)}
          />
        </div>
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

const PREVIEW_TITLES: Record<RewriteMode, string> = {
  shorten: "Shorter version",
  plain: "Explained for non-developers",
  section: "Rewritten section",
};

type Section = { index: number; heading: string | null };

/**
 * AI helpers for a saved entry's text: shorten it (or the section with the cursor), explain it
 * for non-developers, or rewrite the section with the cursor. Each shows what would change, and
 * only Accept saves it (refused if the entry changed meanwhile).
 */
function AiHelpers({
  projectSlug,
  number,
  editor,
  dirty,
  paused,
}: {
  projectSlug: string;
  number: number;
  editor: RefObject<Editor | null>;
  /** The form has changes that aren't saved. */
  dirty: boolean;
  /** Out of AI credits. */
  paused: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState<Section | null>(null);
  const [rewrite, setRewrite] = useState<ChangelogRewrite | null>(null);
  const inputId = useId();

  /** The section with the cursor, numbered like changelog.rewrite: its heading's, or 0 before the first heading. */
  const cursorSection = (): Section => {
    const state = editor.current?.state;
    const section: Section = { index: 0, heading: null };
    if (state) {
      const at = state.selection.$from.index(0);
      state.doc.forEach((node, _offset, index) => {
        if (index <= at && node.type.name === "heading") {
          section.index++;
          section.heading = node.textContent;
        }
      });
    }
    return section;
  };

  // They edit the saved text: changes not saved yet would be lost on Accept.
  const saved = () => {
    if (dirty) {
      toast.error("Save your changes first: AI edits the saved text.");
    }
    return !dirty;
  };

  const run = (input: { mode: RewriteMode; section?: number; instruction?: string }) =>
    startTransition(async () => {
      const result = await rewriteChangelogEntry(projectSlug, number, input);
      if (result.rewrite) {
        setRewrite(result.rewrite);
      } else {
        toast.error(result.error);
      }
    });

  const accept = (proposal: ChangelogRewrite) =>
    // Checked again: the form stays editable while the model writes. The preview stays open.
    saved() &&
    startTransition(async () => {
      const result = await acceptChangelogRewrite(projectSlug, number, proposal.proposed.content, proposal.expectedUpdatedAt);
      if (result.error) {
        toast.error(result.error);
      } else {
        setRewrite(null);
        toast.success("Saved");
      }
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" disabled={pending || paused} />}>
          <SparklesIcon />
          {pending && !rewrite ? "Writing…" : "Edit with AI"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={() => saved() && run({ mode: "shorten" })}>Shorten</DropdownMenuItem>
          <DropdownMenuItem onClick={() => saved() && run({ mode: "shorten", section: cursorSection().index })}>
            Shorten this section
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => saved() && run({ mode: "plain" })}>Explain for non-developers</DropdownMenuItem>
          <DropdownMenuItem onClick={() => saved() && setAsking(cursorSection())}>Rewrite this section…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent>
          {asking && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                // The dialog sits inside the entry's form in React's tree: don't submit that.
                event.preventDefault();
                event.stopPropagation();
                const instruction = String(new FormData(event.currentTarget).get("instruction") ?? "");
                setAsking(null);
                run({ mode: "section", section: asking.index, instruction });
              }}
            >
              <DialogHeader>
                <DialogTitle>Rewrite this section</DialogTitle>
                <DialogDescription>
                  {asking.heading ? `“${asking.heading}”, where your cursor is.` : "The text before the first heading, where your cursor is."}{" "}
                  You&apos;ll see the new version before anything changes.
                </DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor={inputId}>Instruction (optional)</FieldLabel>
                <Input
                  id={inputId}
                  name="instruction"
                  maxLength={200}
                  autoComplete="off"
                  placeholder="e.g. Mention that it works on phones too"
                  autoFocus
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAsking(null)}>
                  Cancel
                </Button>
                <Button type="submit">Rewrite</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={rewrite !== null} onOpenChange={(open) => !open && setRewrite(null)}>
        <DialogContent className="sm:max-w-2xl">
          {rewrite && (
            <>
              <DialogHeader>
                <DialogTitle>{PREVIEW_TITLES[rewrite.mode]}</DialogTitle>
                <DialogDescription>
                  Paragraphs taken out are struck through; new ones are highlighted. Nothing changes until you accept.
                </DialogDescription>
              </DialogHeader>
              <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto text-sm break-words">
                <DiffLines lines={diffLines(rewrite.body, rewrite.proposed.body)} />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={pending} onClick={() => setRewrite(null)}>
                  Discard
                </Button>
                <Button type="button" disabled={pending} onClick={() => accept(rewrite)}>
                  {pending ? "Saving…" : "Accept"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The team's writing style for AI drafts: tone notes, and up to 3 published entries as examples. */
export function ChangelogStyleForm({
  projectSlug,
  tone,
  examples,
  published,
}: {
  projectSlug: string;
  tone: string;
  /** The entries picked as examples, by number. */
  examples: number[];
  /** Published entries, newest first. */
  published: { number: number; title: string }[];
}) {
  const [picked, setPicked] = useState(examples);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveChangelogStyle(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Style saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="style-tone">Tone</FieldLabel>
          <Textarea
            id="style-tone"
            name="tone"
            defaultValue={tone}
            maxLength={1000}
            placeholder="Friendly, short sentences, no jargon. Address the reader as you."
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "style-error" : undefined}
          />
          {state.error && <FieldError id="style-error">{state.error}</FieldError>}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Examples</legend>
          {published.length === 0 ? (
            <p className="text-sm text-muted-foreground">Publish an entry to use it as an example.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Pick up to 3 published entries that read the way you like.</p>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
                {published.map((entry) => (
                  <li key={entry.number}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="examples"
                        value={entry.number}
                        checked={picked.includes(entry.number)}
                        disabled={!picked.includes(entry.number) && picked.length >= 3}
                        onChange={(event) =>
                          setPicked(
                            event.target.checked ? [...picked, entry.number] : picked.filter((n) => n !== entry.number),
                          )
                        }
                        className="size-4 accent-primary"
                      />
                      <span className="min-w-0 flex-1 break-words">{entry.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </fieldset>
        <Button type="submit" disabled={pending} className="self-end">
          {pending ? "Saving…" : "Save style"}
        </Button>
      </FieldGroup>
    </form>
  );
}

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
  aiPaused = false,
}: {
  projectSlug: string;
  number: number;
  title: string;
  published: boolean;
  /** How many posts it completes. */
  postCount: number;
  /** AI is set up on this server and the entry is a draft. */
  canDraftWithAi: boolean;
  /** The project is out of AI credits: Draft with AI shows, disabled. */
  aiPaused?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [drafting, setDrafting] = useState(false);
  const run = (action: typeof publishChangelogEntry, done: string, onDone?: () => void) =>
    startTransition(async () => {
      const result = await action(projectSlug, number);
      if (result.error) {
        toast.error(result.error);
      } else {
        onDone?.();
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
        // Open while the model writes (a few seconds), closed once the new text is in.
        <AlertDialog open={drafting} onOpenChange={setDrafting}>
          <AlertDialogTrigger render={<Button variant="outline" disabled={pending || aiPaused} />}>Draft with AI</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace the text with an AI draft?</AlertDialogTitle>
              <AlertDialogDescription>
                AI writes release notes from the entry&apos;s pull requests and the posts it completes. They replace
                the current text, including changes you haven&apos;t saved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={() => run(draftChangelogEntry, "Drafted with AI", () => setDrafting(false))}
              >
                {pending ? "Drafting…" : "Replace the text"}
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
                  ` ${postCount === 1 ? "The post it completes becomes" : `The ${postCount} posts it completes become`} Completed, and the people who asked get an email.`}{" "}
                Announced, it also shows as new in your widget.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => run((slug, n) => publishChangelogEntry(slug, n, false), "Published quietly")}
              >
                Publish quietly
              </Button>
              <AlertDialogAction disabled={pending} onClick={() => run(publishChangelogEntry, "Published and announced")}>
                Publish and announce
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
