"use client";

import type { Editor } from "@tiptap/react";
import { diffLines, type Doc, type MediaUrls } from "@tuti/content";
import type { PostStatus } from "@tuti/db";
import { cn } from "cn";
import { ExternalLinkIcon, LinkIcon, SparklesIcon, XIcon } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useActionState,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { ImageField } from "@/components/branding-settings";
import { DiffLines } from "@/components/line-diff";
import { type PickablePost, PostPicker, usePostSearch } from "@/components/post-picker";
import { PostStatusBadge } from "@/components/post-status-badge";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  acceptChangelogRewrite,
  type ChangelogRewrite,
  deleteChangelogEntry,
  draftChangelogEntry,
  findPostsToComplete,
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

type Entry = {
  number: number;
  title: string;
  content: Doc;
  tags: TagName[];
  posts: number[];
  published: boolean;
  /** Its cover image (a link to show it by). */
  cover: { id: string; url: string } | null;
  /** Published: how many people its posts' shipped emails reached (entryTold); null if that isn't known. */
  told: number | null;
};
type PostOption = PickablePost & { status: PostStatus };

const CHANGELOG_FORM = "changelog-form";
const ChangelogSavingContext = createContext<{
  pending: boolean;
  setPending: (pending: boolean) => void;
  /** Publish, Unpublish or Draft with AI is running: Save waits for it, as they wait for a save (one would undo the other). */
  publishing: boolean;
  setPublishing: (publishing: boolean) => void;
  /** The cover is uploading: Save waits (it would keep the one before), and so does Publish (it publishes what's saved). */
  uploading: boolean;
  setUploading: (uploading: boolean) => void;
} | null>(null);

/** An entry's page: what ChangelogSaveButton (in the top bar) needs from its ChangelogForm (below it). */
export function ChangelogSaving({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [uploading, setUploading] = useState(false);
  return (
    <ChangelogSavingContext value={{ pending, setPending, publishing, setPublishing, uploading, setUploading }}>{children}</ChangelogSavingContext>
  );
}

/**
 * The entry's Save in the top bar (in its menu on phones, where the ChangelogForm below has its own too): it submits
 * that form. A new entry's "Save draft" is the page's main action; a saved one's Save sits beside Publish.
 */
export function ChangelogSaveButton({ isNew = false }: { isNew?: boolean }) {
  const saving = useContext(ChangelogSavingContext);
  const pending = saving?.pending ?? false;
  return (
    <Button type="submit" form={CHANGELOG_FORM} variant={isNew ? "default" : "outline"} disabled={pending || saving?.publishing || saving?.uploading}>
      {pending ? "Saving…" : isNew ? "Save draft" : "Save"}
    </Button>
  );
}

/**
 * Writes a new entry (`entry` null) or edits one: the title and text, and beside them (under them on
 * phones) its tags, the posts it completes and where readers see it.
 */
export function ChangelogForm({
  projectSlug,
  entry,
  posts,
  readerUrl,
  mediaUrls,
  canEditWithAi = false,
  aiPaused = false,
}: {
  projectSlug: string;
  entry: Entry | null;
  /** The posts it lists, saved (merged ones left out); "Link post…" searches for others. */
  posts: PostOption[];
  /** The entry on the portal: null while it isn't published. */
  readerUrl: string | null;
  mediaUrls: MediaUrls | null;
  /** AI is set up on this server: the editor gets its helpers (for saved entries). */
  canEditWithAi?: boolean;
  /** The project is out of AI credits: the helpers show, disabled. */
  aiPaused?: boolean;
}) {
  const editor = useRef<Editor | null>(null);
  // Changes not saved yet: the AI helpers edit the saved text, and accepting would lose them.
  const [dirty, setDirty] = useState(false);
  const [linked, setLinked] = useState(entry?.posts ?? []);
  // Published or unpublished: its posts are the saved ones again (as publishing used them), not links changed before.
  const [published, setPublished] = useState(entry?.published);
  if (published !== entry?.published) {
    setPublished(entry?.published);
    setLinked(entry?.posts ?? []);
  }
  // The cover uploading (how many): Save waits, "Uploading…" showing by the field.
  const [uploading, setUploading] = useState(0);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveChangelogEntry(projectSlug, entry?.number ?? null, prev, formData);
    if (!result.error) {
      setDirty(false);
      toast.success("Saved");
    }
    return result;
  }, {});
  // The top bar's Save (ChangelogSaveButton) says when it's saving too.
  const saving = useContext(ChangelogSavingContext);
  useEffect(() => saving?.setPending(pending), [saving, pending]);
  useEffect(() => saving?.setUploading(uploading > 0), [saving, uploading]);
  const link = (numbers: number[]) => {
    setLinked(numbers);
    setDirty(true);
  };

  return (
    // Typing in the form (dialogs in portals, like the AI helpers' instruction, aren't in it).
    <form
      id={CHANGELOG_FORM}
      {...keepingFields(action)}
      onInput={(event) => event.currentTarget.contains(event.target as Node) && setDirty(true)}
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start"
    >
      {/* Written as it's published: the title, then the text, no boxes. */}
      <FieldGroup className="min-w-0">
        <div className="flex flex-col gap-2">
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
      </FieldGroup>

      {/* Beside the text, held in view as the page scrolls (under it on phones). */}
      <aside aria-label="Entry settings" className="flex flex-col gap-5 rounded-xl border p-4 text-sm lg:sticky lg:top-18 lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Tags</legend>
          {/* Chips: each its checkbox, unseen, laid over it. */}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAG_LABELS) as TagName[]).map((tag) => (
              <label
                key={tag}
                className="relative rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors select-none hover:bg-muted has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
              >
                <input type="checkbox" name="tags" value={tag} defaultChecked={entry?.tags.includes(tag)} className="absolute inset-0 cursor-pointer appearance-none rounded-full outline-none" />
                {TAG_LABELS[tag]}
              </label>
            ))}
          </div>
        </fieldset>
        {/* Published: the saved ones, which publishing completed (not links changed since and not saved). */}
        <CompletedPosts
          projectSlug={projectSlug}
          posts={posts}
          linked={entry?.published ? entry.posts : linked}
          editable={!entry?.published}
          onChange={link}
          told={entry?.published ? entry.told : null}
        />
        {/* Only where uploads are set up (mediaUrls). Replaced with a new upload, or removed. Its label set as the sidebar's headings. */}
        {mediaUrls && (
          <div className="[&_[data-slot=field-label]]:text-xs [&_[data-slot=field-label]]:text-muted-foreground">
            <ImageField
              projectSlug={projectSlug}
              name="cover"
              label="Cover image"
              description="Shown with the entry on your portal."
              image={entry?.cover ?? null}
              onBusy={(delta) => {
                setUploading((n) => n + delta);
                setDirty(true);
              }}
              onRemove={() => setDirty(true)}
            />
          </div>
        )}
        <section aria-label="On your portal" className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">On your portal</h2>
          {readerUrl ? (
            <a href={readerUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start")}>
              <ExternalLinkIcon />
              View as reader
            </a>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" disabled aria-describedby="reader-hint" className="self-start">
                <ExternalLinkIcon />
                View as reader
              </Button>
              <p id="reader-hint" className="text-muted-foreground">
                Readers see it once it&apos;s published.
              </p>
            </>
          )}
        </section>
      </aside>

      {/* On phones Save is here, after everything it saves; from tablet width up it's in the top bar (ChangelogSaveButton). */}
      <Button type="submit" disabled={pending || saving?.publishing || uploading > 0} className="justify-self-end topbar:hidden">
        {pending ? "Saving…" : entry ? "Save" : "Save draft"}
      </Button>
    </form>
  );
}

/**
 * The posts an entry completes: each opens the post; a draft's are removed or added with "Link post…" (a search
 * of the planned, in-progress and completed posts, findPostsToComplete), saved with the form. A published entry's
 * can't change: publishing completed them.
 */
function CompletedPosts({
  projectSlug,
  posts,
  linked,
  editable,
  onChange,
  told,
}: {
  projectSlug: string;
  /** The ones it lists, saved. */
  posts: PostOption[];
  /** The ones it completes, by number. */
  linked: number[];
  editable: boolean;
  onChange: (linked: number[]) => void;
  /** Published: how many people its posts' shipped emails reached; null when it isn't known (or it's a draft). */
  told: number | null;
}) {
  const [open, setOpen] = useState(false);
  const search = usePostSearch((q) => findPostsToComplete(projectSlug, q));
  // Posts picked from the search, not saved yet.
  const [picked, setPicked] = useState<PostOption[]>([]);
  const linkButton = useRef<HTMLButtonElement>(null);
  const known = [...posts, ...picked];
  const shown = linked.flatMap((number) => known.find((post) => post.number === number) ?? []);

  return (
    <section aria-label="Posts it completes" className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-muted-foreground">Posts it completes</h2>
      {editable && <input type="hidden" name="postsEditable" value="1" />}
      {/* The ones shown: a linked post merged away since isn't (saving drops it; it can't be listed). */}
      {editable && shown.map((post) => <input key={post.number} type="hidden" name="posts" value={post.number} />)}
      {shown.length === 0 ? (
        <p className="text-muted-foreground">
          {editable ? "Link the posts it ships: publishing marks them Completed and tells the people who asked." : "None."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((post) => (
            <li key={post.number} className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/* In a new tab: leaving would lose what isn't saved. */}
                <Link href={`/app/${projectSlug}/p/${post.number}`} target="_blank" className="break-words hover:underline">
                  {post.title}
                </Link>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <PostStatusBadge status={post.status} />#{post.number}
                </span>
              </div>
              {editable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove “${post.title}”`}
                  title="Remove"
                  onClick={() => {
                    // The button goes: focus stays in the list's place, on "Link post…".
                    linkButton.current?.focus();
                    onChange(linked.filter((n) => n !== post.number));
                  }}
                >
                  <XIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {told !== null && <p className="text-muted-foreground">{`Told ${told} ${told === 1 ? "person" : "people"} who asked.`}</p>}
      {editable && (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            search.restart(next);
          }}
        >
          <DialogTrigger render={<Button ref={linkButton} type="button" variant="outline" size="sm" className="self-start" />}>
            <LinkIcon />
            Link post…
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link a post</DialogTitle>
              <DialogDescription>Pick a planned, in-progress or completed post this entry ships.</DialogDescription>
            </DialogHeader>
            <PostPicker
              candidates={search.found.filter((post) => !linked.includes(post.number))}
              query={search.query}
              onQueryChange={search.onQueryChange}
              onPick={(post) => {
                setPicked([...picked, post]);
                onChange([...linked, post.number]);
                setOpen(false);
                search.restart(false);
              }}
              searching={search.searching}
            />
          </DialogContent>
        </Dialog>
      )}
    </section>
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
    if (result.error) {
      // In a toast too: the dialog may have been closed while it saved.
      toast.error(result.error);
    } else {
      toast.success("Style saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      {/* Locked while saving: an edit made then wouldn't be in what's saved, and the dialog closes after it. */}
      <fieldset disabled={pending} className="contents">
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
      </fieldset>
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
  sample = false,
  canDraftWithAi,
  aiPaused = false,
  part,
}: {
  projectSlug: string;
  number: number;
  title: string;
  published: boolean;
  /** How many posts it completes. */
  postCount: number;
  /** Sample content (server/sample-content.ts): published, never announced. */
  sample?: boolean;
  /** AI is set up on this server and the entry is a draft. */
  canDraftWithAi: boolean;
  /** The project is out of AI credits: Draft with AI shows, disabled. */
  aiPaused?: boolean;
  /** Delete (behind the top bar's "More actions"), or Draft with AI, Save and Publish / Unpublish (in the bar). */
  part: "delete" | "publish";
}) {
  const [pending, startTransition] = useTransition();
  const [drafting, setDrafting] = useState(false);
  // The top bar's actions running: the Save buttons wait (ChangelogSaving).
  const saving = useContext(ChangelogSavingContext);
  // Draft with AI, Publish and Unpublish wait for a save too: run meanwhile, either could undo the other's posts or text.
  // And for the cover's upload: Publish publishes what's saved, so it would go out without it.
  const busy = pending || (saving?.pending ?? false) || (saving?.uploading ?? false);
  useEffect(() => {
    if (part === "publish") {
      saving?.setPublishing(pending);
    }
  }, [saving, part, pending]);
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

  if (part === "delete") {
    return (
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
    );
  }
  // Its buttons sit with the page's other actions (PageHeader's), in the top bar or the phone menu.
  return (
    <div className="contents">
      {canDraftWithAi && (
        // Open while the model writes (a few seconds), closed once the new text is in.
        <AlertDialog open={drafting} onOpenChange={setDrafting}>
          <AlertDialogTrigger render={<Button variant="outline" disabled={busy || aiPaused} />}>Draft with AI</AlertDialogTrigger>
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
                disabled={busy}
                onClick={() => run(draftChangelogEntry, "Drafted with AI", () => setDrafting(false))}
              >
                {pending ? "Drafting…" : "Replace the text"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <ChangelogSaveButton />
      {published ? (
        <Button variant="outline" disabled={busy} onClick={() => run(unpublishChangelogEntry, "Unpublished")}>
          Unpublish
        </Button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger render={<Button disabled={busy} />}>Publish</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Publish “{title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                It appears on your portal&apos;s changelog.
                {postCount > 0 &&
                  ` ${postCount === 1 ? "The post it completes becomes" : `The ${postCount} posts it completes become`} Completed, and the people who asked get an email.`}{" "}
                {sample ? "Sample updates are published without announcing." : "Announced, it also shows as new in your widget."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              {sample ? (
                <AlertDialogAction disabled={busy} onClick={() => run((slug, n) => publishChangelogEntry(slug, n, false), "Published without announcing")}>
                  Publish
                </AlertDialogAction>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => run((slug, n) => publishChangelogEntry(slug, n, false), "Published quietly")}
                  >
                    Publish quietly
                  </Button>
                  <AlertDialogAction disabled={busy} onClick={() => run(publishChangelogEntry, "Published and announced")}>
                    Publish and announce
                  </AlertDialogAction>
                </>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
