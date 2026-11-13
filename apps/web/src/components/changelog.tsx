"use client";

import type { Editor } from "@tiptap/react";
import { diffLines, type Doc, type MediaUrls } from "@tuti/content";
import type { ChangelogTag, PostStatus } from "@tuti/db";
import { cn } from "cn";
import { CheckIcon, ExternalLinkIcon, LinkIcon, SparklesIcon, XIcon } from "lucide-react";
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
import { PICKED_CHIP, TAG_LABELS, TAG_VARIANTS } from "@/components/changelog-tag";
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

export type TagName = Lowercase<ChangelogTag>;

type Entry = {
  number: number;
  title: string;
  content: Doc;
  tags: TagName[];
  posts: number[];
  published: boolean;
  /** Its cover image (a link to show it by: its thumbnail's size, for the sidebar). */
  cover: { id: string; url: string } | null;
  /** The cover at the text column's width (the editor shows it there as readers see it); null without one. */
  wideCoverUrl?: string | null;
  /** Published: how many people it told, those who asked (its posts' shipped emails) and other subscribers (entryTold); null if that isn't known. */
  told: { asked: number; subscribers: number } | null;
  /** Published as new (the widget's and the portal's dot), or quietly. */
  announced: boolean;
  /** Emailed to subscribers already (the first time it was published with Email subscribers): never again. */
  emailedSubscribers: boolean;
  /** Of those, how many haven't had it yet (held, or unpublished before they all went): publishing sends theirs. */
  subscribersLeft: number;
  /** How many it was emailed to (sent). */
  subscribersSent: number;
  /** Emailed from the tool it was imported from (Featurebase), not by Tuti: who it went to isn't known here. */
  emailedFrom?: string | null;
  /** Sample content (server/sample-content.ts): it completes sample posts only. */
  sample?: boolean;
  /** A draft imported though it was published in the other tool: that date, which publishing keeps, quietly (changelog.publish). */
  importedOn?: string | null;
  /** The project's email is paused (its bounces or complaints): nobody's emailed, and the resume doesn't send it later. */
  emailPaused?: boolean;
};
type PostOption = PickablePost & { status: PostStatus };

const CHANGELOG_FORM = "changelog-form";
/** AiHelpers' menu button: Draft with AI's dialog gives the keyboard's focus back to it once the text is written. */
const EDIT_WITH_AI = "edit-with-ai";
const ChangelogSavingContext = createContext<{
  pending: boolean;
  setPending: (pending: boolean) => void;
  /** Publish, Unpublish or Draft with AI is running: Save waits for it, as they wait for a save (one would undo the other). */
  publishing: boolean;
  setPublishing: (publishing: boolean) => void;
  /** The cover is uploading: Save waits (it would keep the one before), and so does Publish (it publishes what's saved). */
  uploading: boolean;
  setUploading: (uploading: boolean) => void;
  /** How publishing announces it, picked in the sidebar (HowAnnounced): email subscribers, mark it new. */
  announce: Announce;
  setAnnounce: (announce: Announce) => void;
  /** Draft with AI's dialog is open: from the top bar's button, Publish's dialog or the Edit with AI menu (AiHelpers). */
  drafting: boolean;
  setDrafting: (drafting: boolean) => void;
  /** The text has something this release's editor can't show (RichEditor's onUnreadable): AI must not rewrite it either. */
  locked: boolean;
  setLocked: (locked: boolean) => void;
} | null>(null);
type Announce = { email: boolean; markNew: boolean };

/** An entry's page: what ChangelogSaveButton (in the top bar) needs from its ChangelogForm (below it). */
export function ChangelogSaving({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [announce, setAnnounce] = useState<Announce>({ email: true, markNew: true });
  const [drafting, setDrafting] = useState(false);
  const [locked, setLocked] = useState(false);
  return (
    <ChangelogSavingContext
      value={{ pending, setPending, publishing, setPublishing, uploading, setUploading, announce, setAnnounce, drafting, setDrafting, locked, setLocked }}
    >
      {children}
    </ChangelogSavingContext>
  );
}

/**
 * The entry's Save in the top bar (at the bottom of the screen on phones, PageActions' `pinned`): it submits
 * the ChangelogForm below. A new entry's "Save draft" is the page's main action; a saved one's Save sits beside Publish.
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
 * Writes a new entry (`entry` null) or edits one: the title, its cover and the text, and beside them (under them on
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
  subscribers = 0,
}: {
  projectSlug: string;
  entry: Entry | null;
  /** How many people confirmed they want the changelog by email (Email subscribers); null on a private portal (none are emailed). */
  subscribers?: number | null;
  /** The posts it lists, saved (merged ones left out); "Link post…" searches for others. */
  posts: PostOption[];
  /** The entry on the portal: null while it isn't published. */
  readerUrl: string | null;
  mediaUrls: MediaUrls | null;
  /** AI is set up on this server and the text is written (not still pull-request titles): the editor gets its helpers (for saved entries). */
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
  // The cover as picked in the sidebar, shown under the title as readers see it.
  const [coverUrl, setCoverUrl] = useState(entry?.wideCoverUrl ?? null);
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
        {/* As the portal shows it, under the title (alt text the title, as there). */}
        {coverUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
          <img src={coverUrl} alt={entry?.title ?? ""} className="h-auto w-full rounded-lg border" />
        )}
        <div className="flex flex-col gap-2">
          {entry && canEditWithAi && !saving?.locked && (
            <div className="flex justify-end">
              <AiHelpers
                projectSlug={projectSlug}
                number={entry.number}
                editor={editor}
                dirty={dirty}
                paused={aiPaused}
                canDraft={!entry.published}
              />
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
            // Its AI helpers (here and Draft with AI in the top bar) would rewrite it without what it can't show; told on
            // every editor made, so text that's readable again (the form remounted with it) unlocks them.
            onReadable={(readable) => saving?.setLocked(!readable)}
          />
        </div>
      </FieldGroup>

      {/* Beside the text, held in view as the pane scrolls, no taller than it (its PaneBody, a size container), under it on phones. */}
      <aside aria-label="Entry settings" className="flex flex-col gap-5 rounded-xl border p-4 text-sm lg:sticky lg:top-0 lg:max-h-[calc(100cqh-3rem)] lg:overflow-y-auto">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Tags</legend>
          {/* Chips: each its checkbox, unseen, laid over it. */}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAG_LABELS) as ChangelogTag[]).map((tag) => (
              <label
                key={tag}
                className={cn(
                  "group/tag relative inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors select-none hover:bg-muted has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  PICKED_CHIP[TAG_VARIANTS[tag]],
                )}
              >
                <input
                  type="checkbox"
                  name="tags"
                  value={tag.toLowerCase()}
                  defaultChecked={entry?.tags.includes(tag.toLowerCase() as TagName)}
                  className="absolute inset-0 cursor-pointer appearance-none rounded-full outline-none"
                />
                <CheckIcon aria-hidden className="hidden size-3.5 group-has-checked/tag:block" />
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
          sampleEntry={entry?.sample ?? false}
          onChange={link}
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
              onChange={(image) => setCoverUrl(image?.url ?? null)}
            />
          </div>
        )}
        {entry && <HowAnnounced entry={entry} subscribers={subscribers} />}
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
    </form>
  );
}

/** "3 subscribers", "1 subscriber". */
const subscriberCountText = (n: number) => `${n} ${n === 1 ? "subscriber" : "subscribers"}`;

/** Who publishing told: the people who asked, the subscribers, or both. */
const toldText = ({ asked, subscribers }: { asked: number; subscribers: number }) => {
  const people = `${asked} ${asked === 1 ? "person" : "people"} who asked`;
  if (subscribers === 0) {
    return `Told ${people}.`;
  }
  return asked === 0 ? `Told ${subscriberCountText(subscribers)}.` : `Told ${people} and ${subscriberCountText(subscribers)}.`;
};

/** The subscribers an entry is still to be emailed to, by how many. */
const stillToEmail = (n: number) => (n === 1 ? "the subscriber who hasn't had it yet" : `the ${n} subscribers who haven't had it yet`);

/**
 * What the Publish dialog says happens: on the portal, marked new or not, and who's emailed (the subscribers, the
 * first time; publishing again, those it's still to go to).
 */
export function publishSummary({
  markNew,
  email,
  subscribers,
  emailedSubscribers,
  subscribersLeft,
}: {
  markNew: boolean;
  email: boolean;
  subscribers: number;
  emailedSubscribers: boolean;
  subscribersLeft: number;
}): string {
  const emailed = emailedSubscribers
    ? subscribersLeft > 0
      ? `, and it's sent to ${stillToEmail(subscribersLeft)}`
      : ""
    : email && subscribers > 0
      ? `, and it's emailed to your ${subscribers === 1 ? "subscriber" : `${subscribers} subscribers`}`
      : "";
  return `It appears on your portal's changelog${markNew ? ", marked new in your widget" : ""}${emailed}.`;
}

/**
 * How publishing announces an entry: emailed to the changelog's subscribers (once per entry), and marked new in the
 * widget's What's new (it's listed there either way). A draft's are picked here, for Publish (ChangelogSaving); a
 * published one's say what happened, and how many people it told.
 */
export function HowAnnounced({ entry, subscribers }: { entry: Entry; subscribers: number | null }) {
  const saving = useContext(ChangelogSavingContext);
  const announce = saving?.announce ?? { email: true, markNew: true };
  const pick = (change: Partial<Announce>) => saving?.setAnnounce({ ...announce, ...change });
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const id = useId();
  const choice = (name: string, hint: string, input: React.ComponentProps<"input">) => {
    // Ids without spaces: aria-describedby is a list of them.
    const key = `${id}-${name.replaceAll(" ", "-")}`;
    return (
      <div className="flex items-start gap-2">
        <input type="checkbox" id={key} aria-describedby={`${key}-hint`} className="mt-0.5 size-4 accent-primary" {...input} />
        <div className="flex flex-col gap-0.5">
          <label htmlFor={key}>{name}</label>
          <p id={`${key}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        </div>
      </div>
    );
  };
  return (
    // Not the entry's fields: picking doesn't make it unsaved.
    <fieldset className="flex flex-col gap-3" onInput={(event) => event.stopPropagation()}>
      <legend className="mb-2 text-xs font-medium text-muted-foreground">How it&apos;s announced</legend>
      {entry.published ? (
        <>
          <p>
            {!entry.emailedSubscribers
              ? "Not emailed to subscribers."
              : entry.emailedFrom
                ? `Emailed to your subscribers from ${entry.emailedFrom}.`
                : entry.subscribersLeft > 0
                ? `Being emailed to subscribers: ${entry.subscribersLeft} still to go.`
                : `Emailed to ${subscriberCountText(entry.subscribersSent)}.`}
          </p>
          <p>{entry.announced ? "Marked new in your widget's What's new." : "In your widget's What's new, not marked new."}</p>
          {/* Nobody told yet (still being emailed, say): the line above says so. */}
          {entry.told !== null && entry.told.asked + entry.told.subscribers > 0 && <p className="text-muted-foreground">{toldText(entry.told)}</p>}
        </>
      ) : entry.sample ? (
        // changelog.publish: a sample entry is never announced or emailed.
        <p>Sample updates are published without announcing: not emailed to subscribers, not marked new.</p>
      ) : entry.importedOn ? (
        // changelog.publish: nor is an imported one, the first time.
        <p>Published before you imported it, so it&apos;s published with that date ({entry.importedOn}) without announcing: not emailed to subscribers, not marked new.</p>
      ) : (
        <>
          {entry.emailedSubscribers ? (
            <p>
              {entry.emailedFrom
                ? `Emailed to your subscribers from ${entry.emailedFrom}: it isn't sent again.`
                : entry.subscribersLeft > 0
                ? `Emailed to ${subscriberCountText(entry.subscribersSent)} when it was first published, not to all of them yet. Publishing sends it to ${stillToEmail(entry.subscribersLeft)}.`
                : subscribers === null
                  ? `Emailed to ${subscriberCountText(entry.subscribersSent)} when it was first published. Your portal is private now: it isn't emailed to anyone else.`
                  : `Emailed to ${subscriberCountText(entry.subscribersSent)} when it was first published: it isn't sent again.`}
            </p>
          ) : (
            choice(
              "Email subscribers",
              entry.emailPaused
                ? "Your project's email is paused, so subscribers aren't emailed."
                : subscribers === null
                ? "Your portal is private: its changelog isn't emailed."
                : subscribers === 0
                  ? "Nobody has subscribed yet: people subscribe on your portal's changelog."
                  : `${people(subscribers)} subscribed on your portal's changelog.`,
              { checked: announce.email && !!subscribers, disabled: !subscribers, onChange: (event) => pick({ email: event.target.checked }) },
            )
          )}
          {choice("Mark it new", "It's in your widget's What's new either way. Marked new, the widget shows a dot and your portal's Changelog tab says New to signed-in readers, until they see it.", {
            checked: announce.markNew,
            onChange: (event) => pick({ markNew: event.target.checked }),
          })}
        </>
      )}
    </fieldset>
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
  sampleEntry,
  onChange,
}: {
  projectSlug: string;
  /** A sample entry: "Link post…" offers sample posts only, a real one real posts only (changelog.update refuses the rest). */
  sampleEntry: boolean;
  /** The ones it lists, saved. */
  posts: PostOption[];
  /** The ones it completes, by number. */
  linked: number[];
  editable: boolean;
  onChange: (linked: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const search = usePostSearch((q) => findPostsToComplete(projectSlug, q, sampleEntry));
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
 * only Accept saves it (refused if the entry changed meanwhile). A draft's Draft with AI is here too (its
 * dialog is ChangelogEntryActions'): the one way into AI once the text is written.
 */
function AiHelpers({
  projectSlug,
  number,
  editor,
  dirty,
  paused,
  canDraft,
}: {
  projectSlug: string;
  number: number;
  editor: RefObject<Editor | null>;
  /** The form has changes that aren't saved. */
  dirty: boolean;
  /** Out of AI credits. */
  paused: boolean;
  /** A draft: Draft with AI is in the menu. */
  canDraft: boolean;
}) {
  const saving = useContext(ChangelogSavingContext);
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
        <DropdownMenuTrigger
          render={
            <Button
              id={EDIT_WITH_AI}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || paused}
              focusableWhenDisabled
              title={paused ? "This project is out of AI credits" : undefined}
            />
          }
        >
          <SparklesIcon />
          {pending && !rewrite ? "Writing…" : "Edit with AI"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {/* It says itself what it replaces, unsaved changes included. */}
          {canDraft && <DropdownMenuItem onClick={() => saving?.setDrafting(true)}>Draft with AI…</DropdownMenuItem>}
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
          <Button type="submit" disabled={pending} focusableWhenDisabled className="self-end">
            {pending ? "Saving…" : "Save"}
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
  subscribers = 0,
  emailedSubscribers = false,
  subscribersLeft = 0,
  emails,
  sample = false,
  importedOn = null,
  canDraftWithAi,
  aiPaused = false,
  unwritten,
  part,
}: {
  projectSlug: string;
  number: number;
  title: string;
  published: boolean;
  /** How many posts it completes. */
  postCount: number;
  /** How many people confirmed they want the changelog by email. */
  subscribers?: number;
  /** Emailed to subscribers already: publishing again doesn't, except to those it's still to go to (`subscribersLeft`). */
  emailedSubscribers?: boolean;
  subscribersLeft?: number;
  /** How many people publishing emails that what they asked for shipped (emailedOnCompletion: never for sample posts). */
  emails: number;
  /** Sample content (server/sample-content.ts): published, never announced. */
  sample?: boolean;
  /** Imported as a draft though it was published there: that date, kept by publishing, which doesn't announce it. */
  importedOn?: string | null;
  /** AI is set up on this server and the entry is a draft: Draft with AI's dialog (its button here only while `unwritten`, in Edit with AI's menu otherwise). */
  canDraftWithAi: boolean;
  /** The project is out of AI credits: Draft with AI shows, disabled. */
  aiPaused?: boolean;
  /** Not written yet (onlyPullRequestTitles): its text is still the pull requests' titles, Autopilot's line for each, or empty. Draft with AI leads, and Publish asks first. */
  unwritten?: "titles" | "lines" | "empty";
  /** Delete (behind the top bar's "More actions"), or Draft with AI, Save and Publish / Unpublish (in the bar). */
  part: "delete" | "publish";
}) {
  const [pending, startTransition] = useTransition();
  // The top bar's actions running: the Save buttons wait (ChangelogSaving).
  const saving = useContext(ChangelogSavingContext);
  const drafting = saving?.drafting ?? false;
  const setDrafting = (open: boolean) => saving?.setDrafting(open);
  // Draft with AI, Publish and Unpublish wait for a save too: run meanwhile, either could undo the other's posts or text.
  // And for the cover's upload: Publish publishes what's saved, so it would go out without it.
  const busy = pending || (saving?.pending ?? false) || (saving?.uploading ?? false);
  // As picked in the sidebar (HowAnnounced).
  const announce = saving?.announce ?? { email: true, markNew: true };
  // Nobody to email (or emailed before): it isn't, and the sidebar says so once it's published.
  const emailing = announce.email && subscribers > 0 && !emailedSubscribers;
  // Pull requests' titles aren't release notes: writing them is the next step, not publishing them.
  // Text this release's editor can't show isn't rewritten by AI either (ChangelogForm's onUnreadable).
  const locked = saving?.locked ?? false;
  const aiFirst = unwritten !== undefined && canDraftWithAi && !aiPaused && !locked;
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
  const draftWithAi = canDraftWithAi && (
    // Open while the model writes (a few seconds), closed once the new text is in.
    <AlertDialog key="draft" open={drafting} onOpenChange={setDrafting}>
      {/* Its button while the text isn't written; once it is, Edit with AI's menu over the text opens it. */}
      {unwritten && (
        <AlertDialogTrigger render={<Button variant={aiFirst ? "default" : "outline"} disabled={busy || aiPaused || locked} focusableWhenDisabled />}>
          Draft with AI
        </AlertDialogTrigger>
      )}
      {/* Written now (its button gone), or opened from Edit with AI's menu: focus goes back to that menu's button. */}
      <AlertDialogContent finalFocus={() => document.getElementById(EDIT_WITH_AI) ?? true}>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace the text with an AI draft?</AlertDialogTitle>
          <AlertDialogDescription>
            AI writes release notes from the entry&apos;s saved text, its pull requests and the posts it completes. They replace
            the current text, including changes you haven&apos;t saved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || locked}
            onClick={() => run(draftChangelogEntry, "Drafted with AI", () => setDrafting(false))}
          >
            {pending ? "Drafting…" : "Replace the text"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  const publishOrUnpublish = published ? (
    <Button key="publish" variant="outline" disabled={busy} focusableWhenDisabled onClick={() => run(unpublishChangelogEntry, "Unpublished")}>
      Unpublish
    </Button>
  ) : (
    <AlertDialog key="publish">
      {/* Off while busy, but keeping the keyboard's focus. */}
      <AlertDialogTrigger render={<Button variant={aiFirst ? "outline" : "default"} disabled={busy} focusableWhenDisabled />}>Publish</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {unwritten === "titles" ? "Publish the pull requests' titles?" : unwritten === "lines" ? "Publish Autopilot's lines as they are?" : unwritten === "empty" ? "Publish it without text?" : `Publish “${title}”?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {unwritten === "titles" && `“${title}” still lists what the pull requests were called, not what changed for your users. `}
            {unwritten === "lines" && `“${title}” is still one line for each pull request, as Autopilot wrote them, not release notes. `}
            {unwritten === "empty" && `“${title}” has no text yet, only its pull requests. `}
            {aiFirst && "Draft with AI writes release notes from them. "}
            {sample || importedOn
              ? publishSummary({ markNew: false, email: false, subscribers: 0, emailedSubscribers: false, subscribersLeft: 0 })
              : publishSummary({ markNew: announce.markNew, email: announce.email, subscribers, emailedSubscribers, subscribersLeft })}
            {postCount > 0 &&
              ` ${postCount === 1 ? "The post it completes becomes" : `The ${postCount} posts it completes become`} Completed${emails > 0 ? ", and the people who asked get an email" : ""}.`}
            {sample && " Sample updates are published without announcing."}
            {importedOn && ` Published before you imported it, it keeps that date (${importedOn}) and isn't announced.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* A sample entry is never announced or emailed (changelog.publish), nor an imported one the first time; a real one goes as the sidebar has it. */}
          <AlertDialogAction
            variant={aiFirst ? "outline" : "default"}
            disabled={busy}
            onClick={() =>
              sample || importedOn
                ? run((slug, n) => publishChangelogEntry(slug, n, false, false), "Published without announcing")
                : run((slug, n) => publishChangelogEntry(slug, n, announce.markNew, emailing), "Published")
            }
          >
            {unwritten ? "Publish anyway" : "Publish"}
          </AlertDialogAction>
          {/* Closes this dialog and opens Draft with AI's, which says what it replaces. */}
          {aiFirst && (
            <AlertDialogCancel variant="default" onClick={() => setDrafting(true)}>
              Draft with AI
            </AlertDialogCancel>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  // Its buttons sit with the page's other actions (in the pane's header, PageActions), in the top bar or the phone menu. As the main action,
  // Draft with AI comes last, on the right of Save and Publish: keyed, so it's moved rather than made again (its
  // dialog and the keyboard's focus on it stay) when that changes.
  const save = <ChangelogSaveButton key="save" />;
  return <div className="contents">{aiFirst ? [save, publishOrUnpublish, draftWithAi] : [draftWithAi, save, publishOrUnpublish]}</div>;
}
