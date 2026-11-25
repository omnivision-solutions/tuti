"use client";

import type { Editor } from "@tiptap/react";
import { diffLines, type Doc, type MediaUrls } from "@tuti/content";
import type { ChangelogTag, PostStatus } from "@tuti/db";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "cn";
import { CheckIcon, ImageIcon, LinkIcon, PlusIcon, SparklesIcon, UploadIcon, XIcon } from "lucide-react";
import Link from "next/link";

import { UpgradeDialog } from "@/components/upgrade-dialog";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useActionState,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { useImageUpload } from "@/components/branding-settings";
import { PICKED_CHIP, TAG_LABELS, TAG_VARIANTS } from "@/components/changelog-tag";
import { useCustomizeForm, useFieldChanged } from "@/components/customize-shell";
import { DiffLines } from "@/components/line-diff";
import { type PickablePost, PostPicker, usePostSearch } from "@/components/post-picker";
import { PostStatusBadge } from "@/components/post-status-badge";
import { PullRequestChip } from "@/components/pull-request-chip";
import { BARE_TITLE, RichEditor } from "@/components/rich-editor";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { plural } from "@/lib/autopilot-words";
import { untickedByDefault } from "@/lib/added-pull-requests";
import { formatDate } from "@/lib/format";
import { credits } from "@/lib/usage-format";
import {
  acceptChangelogRewrite,
  composeChangelogCover,
  addChangelogPullRequests,
  type ChangelogRewrite,
  deleteChangelogEntry,
  draftChangelogEntry,
  findMissingChanges,
  findPostsToComplete,
  type MissingChanges,
  publishChangelogEntry,
  removeChangelogPullRequest,
  rewriteChangelogEntry,
  saveChangelogEntry,
  saveChangelogStyle,
  unpublishChangelogEntry,
} from "@/server/changelog";
import type { CoverDesign } from "@/server/cover-card";
import type { FormState } from "@/server/form-state";
import type { RewriteMode } from "@/server/release-notes";

export type TagName = Lowercase<ChangelogTag>;

type Entry = {
  number: number;
  title: string;
  content: Doc;
  tags: TagName[];
  /** The keys of the reader groups it's for; none: everyone. */
  groups: string[];
  /** Email-only: emailed to subscribers, listed nowhere. */
  emailOnly?: boolean;
  posts: number[];
  published: boolean;
  /** Its cover (the featured image): a link to its thumbnail size. */
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
export const ChangelogSavingContext = createContext<{
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
  /** The form's featured image isn't the saved one (one uploaded or removed, not saved yet): Publish offers no cover of its own over it. */
  coverChanged: boolean;
  setCoverChanged: (changed: boolean) => void;
  /** "Who sees it" changed and isn't saved: Publish waits (it publishes what's saved, to whoever that's for). */
  groupsChanged: boolean;
  setGroupsChanged: (changed: boolean) => void;
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
  const [coverChanged, setCoverChanged] = useState(false);
  const [groupsChanged, setGroupsChanged] = useState(false);
  return (
    <ChangelogSavingContext
      value={{ pending, setPending, publishing, setPublishing, uploading, setUploading, announce, setAnnounce, drafting, setDrafting, locked, setLocked, coverChanged, setCoverChanged, groupsChanged, setGroupsChanged }}
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
 * The entry's featured image (its `cover`), at the text column's width as readers see it: without one, a band to add
 * one (picked or dropped on it); with one, Replace and Remove over it (shown on hover and focus, always on touch screens).
 */
function FeaturedImage({
  projectSlug,
  entry,
  covers,
  onBusy,
  onRemove,
}: {
  projectSlug: string;
  entry: Entry | null;
  /** The cover designs "Make a cover" offers a saved entry; null for a new one. */
  covers?: CoverChoices | null;
  onBusy: (delta: number) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const add = useRef<HTMLButtonElement>(null);
  const savedCover = entry?.cover ? { id: entry.cover.id, url: entry.wideCoverUrl ?? entry.cover.url } : null;
  const { image, setImage, uploading, error, dragging, drop, inputs, pick } = useImageUpload({
    projectSlug,
    name: "cover",
    id,
    label: "Featured image",
    image: savedCover,
    onBusy,
  });
  // A cover saved from outside the form (composed in the Publish dialog, or set by a teammate) is the form's cover
  // from then on, so the next Save keeps it rather than taking it off: unless the form's own was changed and not saved
  // yet (an upload, a removal), which stays. "Use this cover" is asked for here, so its cover is taken either way.
  const [savedWas, setSavedWas] = useState(savedCover?.id);
  const [made, setMade] = useState(false);
  if (savedWas !== savedCover?.id) {
    setSavedWas(savedCover?.id);
    setMade(false);
    if (made || image?.id === savedWas) {
      setImage(savedCover);
    }
  }
  // Told to Publish, which adds no cover of its own over one that's waiting to be saved.
  const saving = useContext(ChangelogSavingContext);
  const changed = image?.id !== savedCover?.id;
  useEffect(() => saving?.setCoverChanged(changed), [saving, changed]);
  // One dialog, whichever of its two buttons opened it (Add's row or the image's), so it's still there when the cover it
  // made takes the first one's place; then the keyboard's focus goes to Replace, as after an upload.
  const [making, setMaking] = useState(false);
  const focusReplace = useRef(false);
  useEffect(() => {
    if (image && focusReplace.current) {
      focusReplace.current = false;
      replace.current?.focus({ preventScroll: true });
    }
  }, [image]);
  const make = entry && covers && (
    <Button type="button" variant="secondary" size="sm" disabled={uploading} focusableWhenDisabled onClick={() => setMaking(true)}>
      Make a cover
    </Button>
  );
  // An upload from Add replaces it with the image: focus, dropped with it, moves to Replace (as Remove's goes to Add).
  // (Only then, and only if focus went with Add: a file dropped with the mouse, or someone who moved on while it
  // uploaded, to the text or by a click anywhere else, keeps theirs.)
  const replace = useRef<HTMLButtonElement>(null);
  const fromAdd = useRef(false);
  useEffect(() => {
    if (image && fromAdd.current && (!document.activeElement || document.activeElement === document.body)) {
      // Where they are on the page stays (scrolled away while it uploaded).
      replace.current?.focus({ preventScroll: true });
    }
  }, [image]);
  // After the effect above, which reads it (an upload's image and its end land together); a failed one's is forgotten.
  useEffect(() => {
    fromAdd.current = uploading && document.activeElement === add.current;
    if (!uploading) {
      return;
    }
    // A click elsewhere can leave focus on the page itself, as Add going does: it's moving on all the same. Only a press
    // that takes focus from Add counts (checked once the press has moved it; a touch starting a scroll doesn't).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const movedOn = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (add.current && document.activeElement !== add.current) {
          fromAdd.current = false;
        }
      });
    };
    document.addEventListener("pointerdown", movedOn, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", movedOn, true);
    };
  }, [uploading]);
  const status = uploading && (
    <p role="status" className="text-sm text-muted-foreground">
      Uploading…
    </p>
  );

  return (
    <div role="group" aria-label="Featured image" className="flex flex-col gap-2">
      {image ? (
        <div {...drop} className={cn("group/cover relative", dragging && "rounded-lg ring-2 ring-primary")}>
          {/* Alt text the title, as on the portal. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized */}
          <img src={image.url} alt={entry?.title ?? ""} className={cn("h-auto w-full rounded-lg border", uploading && "opacity-50")} />
          {status && <div className="absolute inset-0 flex items-center justify-center">{status}</div>}
          <div className="absolute top-2 right-2 flex gap-2 opacity-0 transition-opacity group-hover/cover:opacity-100 group-focus-within/cover:opacity-100 max-sm:opacity-100 pointer-coarse:opacity-100">
            <Button type="button" variant="secondary" size="sm" aria-label="Replace featured image" ref={replace} disabled={uploading} focusableWhenDisabled onClick={pick}>
              Replace
            </Button>
            {make}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label="Remove featured image"
              // Off while one uploads (its image would come back after), focusable all the same.
              disabled={uploading}
              focusableWhenDisabled
              onClick={() => {
                // Remove goes with the image: focus moves to Add, not out of the form.
                flushSync(() => setImage(null));
                add.current?.focus();
                onRemove();
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        // One row, not a tall empty band pushing the text down: the cover takes its room once there is one.
        <div
          {...drop}
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed px-3 py-2 transition-colors",
            dragging && "border-primary bg-soft",
          )}
        >
          <Button type="button" variant="ghost" size="sm" className="-ml-1.5" ref={add} disabled={uploading} focusableWhenDisabled onClick={pick}>
            <ImageIcon />
            Add featured image
          </Button>
          {make}
          {status || <span className="text-xs text-muted-foreground">or drop one here · 1200×630 works best</span>}
        </div>
      )}
      {inputs}
      {error && <FieldError>{error}</FieldError>}
      {entry && covers && (
        <MakeCover
          projectSlug={projectSlug}
          number={entry.number}
          title={entry.title}
          covers={covers}
          // Readers' image, or the one the form shows and hasn't saved: either way, one is replaced.
          replacing={savedCover !== null || image !== null}
          published={entry.published}
          open={making}
          onOpenChange={setMaking}
          // Marked as asked for before it's made: the page refreshed with it can land before the action's answer does.
          onAsking={setMade}
          onMade={() => {
            focusReplace.current = true;
          }}
        />
      )}
    </div>
  );
}

/** The cover designs with something to show for an entry as it's saved, the one picked when nobody picks, and `version`, which changes with each save (its previews are drawn again). */
export type CoverChoices = { designs: CoverDesign[]; automatic: CoverDesign; version: number };

const COVER_DESIGN_NAMES: Record<CoverDesign, string> = { title: "Title", screenshot: "Screenshot", sections: "Sections", pattern: "Pattern", background: "Your background" };

/** A cover design to pick (the Publish dialog's, Make a cover's, Settings'): its picture, then its name. */
const coverOption = "relative flex cursor-pointer flex-col gap-1 text-xs text-muted-foreground has-checked:text-foreground";
const coverPicture = "aspect-[1600/840] w-full rounded-md border bg-muted peer-checked:ring-2 peer-checked:ring-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring";

/**
 * The cover designs to pick from, each a picture of this entry's own cover in it (the team's preview route: the saved
 * title or `headline`, tag, headings and image, with the portal's branding), and "No cover" with `none`.
 */
function CoverDesigns({
  projectSlug,
  number,
  covers,
  value,
  onChange,
  headline = "",
  none = false,
  className = "grid-cols-2",
}: {
  projectSlug: string;
  number: number;
  covers: CoverChoices;
  value: CoverDesign | "none";
  onChange: (value: CoverDesign | "none") => void;
  headline?: string;
  none?: boolean;
  /** Its columns. */
  className?: string;
}) {
  const name = useId();
  const query = new URLSearchParams({ v: String(covers.version), ...(headline.trim() && { headline: headline.trim() }) });
  // `relative` (coverOption): each radio (out of sight) stays within its own option, so focus and a click on it land there.
  const option = coverOption;
  const picture = coverPicture;
  return (
    <fieldset className={cn("grid gap-3", className)}>
      <legend className="mb-2 text-sm font-medium">Cover</legend>
      {covers.designs.map((design) => (
        <label key={design} className={option}>
          <input type="radio" name={name} className="peer sr-only" checked={value === design} onChange={() => onChange(design)} />
          {/* eslint-disable-next-line @next/next/no-img-element -- drawn for this entry by the team's preview route */}
          <img src={`/app/${projectSlug}/changelog/${number}/cover/${design}?${query}`} alt="" width={800} height={420} className={picture} />
          {COVER_DESIGN_NAMES[design]}
        </label>
      ))}
      {none && (
        <label className={option}>
          <input type="radio" name={name} className="peer sr-only" checked={value === "none"} onChange={() => onChange("none")} />
          <span aria-hidden className={cn(picture, "border-dashed bg-transparent")} />
          No cover
        </label>
      )}
    </fieldset>
  );
}

/** The design that's picked: theirs while the entry still offers it (a save can take its image away), else the entry's own. */
const pickedCover = <None extends "none" | never>(covers: CoverChoices, picked: CoverDesign | None | undefined) =>
  picked !== undefined && (picked === "none" || covers.designs.includes(picked as CoverDesign)) ? picked : covers.automatic;

/**
 * "Make a cover" beside the featured image's buttons: the designs drawn for the saved entry, a headline to show in its
 * title's place, and "Use this cover", which keeps the picked one as the entry's cover (changelog.composeCover). Unsaved
 * text stays as it is: the form's cover follows the saved one (FeaturedImage).
 */
function MakeCover({
  projectSlug,
  number,
  title,
  covers,
  replacing,
  published,
  open,
  onOpenChange: setOpen,
  onAsking,
  onMade,
}: {
  projectSlug: string;
  number: number;
  title: string;
  covers: CoverChoices;
  /** The entry has a saved cover, which this one replaces. */
  replacing: boolean;
  published: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Its cover is being made (true), or couldn't be (false): the form takes the entry's next cover as its own. */
  onAsking: (asking: boolean) => void;
  /** Its cover is the entry's now. */
  onMade: () => void;
}) {
  const [picked, setPicked] = useState<CoverDesign>();
  const [headline, setHeadline] = useState("");
  // The previews follow the headline once typing pauses, not at every letter.
  const [shown, setShown] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setShown(headline), 400);
    return () => clearTimeout(timer);
  }, [headline]);
  const [pending, startTransition] = useTransition();
  const design = pickedCover<never>(covers, picked);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* No taller than the screen (a phone's, with its keyboard up for the headline): it scrolls. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Make a cover</DialogTitle>
          {/* Unlike an upload, it doesn't wait for Save: said before it's used, with what readers see. */}
          <DialogDescription>
            Drawn from this entry as it&apos;s saved and your portal&apos;s branding. {replacing ? "It replaces the featured image" : "It becomes the featured image"}{" "}
            as soon as you use it, without Save.{published && " Readers see it right away."}
          </DialogDescription>
        </DialogHeader>
        <CoverDesigns projectSlug={projectSlug} number={number} covers={covers} value={design} onChange={(value) => value !== "none" && setPicked(value)} headline={shown} />
        <Field>
          <FieldLabel htmlFor="cover-headline">Headline</FieldLabel>
          <Input id="cover-headline" value={headline} onChange={(event) => setHeadline(event.target.value)} maxLength={90} placeholder={title} autoComplete="off" />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            focusableWhenDisabled
            onClick={() =>
              startTransition(async () => {
                onAsking(true);
                // Not made, however it failed (an answer with an error, or none at all): the form's own image stays.
                const result = await composeChangelogCover(projectSlug, number, design, headline).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
                if (result.error) {
                  onAsking(false);
                  toast.error(result.error);
                } else {
                  onMade();
                  setOpen(false);
                  toast.success("Cover added");
                }
              })
            }
          >
            {pending ? "Making it…" : "Use this cover"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Writes a new entry (`entry` null) or edits one: the title, its featured image and the text, and beside them (under them on
 * phones) its tags, the posts it completes and where readers see it.
 */
export function ChangelogForm({
  projectSlug,
  entry,
  posts,
  standing,
  mediaUrls,
  covers = null,
  canEditWithAi = false,
  aiPaused = false,
  subscribers = 0,
  pullRequests = null,
  groups = [],
  groupsUpgrade = null,
}: {
  projectSlug: string;
  entry: Entry | null;
  /** The project's reader groups, for "Who sees it" (not shown without any). */
  groups?: { key: string; name: string }[];
  /** The plan has no reader groups: picking one opens the upgrade prompt (unpicking works: changelog.update needs the plan only for groups added). */
  groupsUpgrade?: UpgradePrompt | null;
  /** The cover designs "Make a cover" offers (a saved entry, where uploads are set up). */
  covers?: CoverChoices | null;
  /** Its merged pull requests, in their section; null for none (GitHub isn't connected and it has none). */
  pullRequests?: EntryPullRequestsProps | null;
  /** How many people confirmed they want the changelog by email (Email subscribers); null on a private portal (none are emailed). */
  subscribers?: number | null;
  /** The posts it lists, saved (merged ones left out); "Link post…" searches for others. */
  posts: PostOption[];
  /** Where it stands ("Draft", "Published 25 November"), first in the sidebar, as a post's status is; none for a new one. */
  standing?: ReactNode;
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
  // Saves so far: "Who sees it" starts afresh after each (from the saved groups), its picks sent again only once changed.
  const [saves, setSaves] = useState(0);
  // Published or unpublished: its posts are the saved ones again (as publishing used them), not links changed before.
  const [published, setPublished] = useState(entry?.published);
  if (published !== entry?.published) {
    setPublished(entry?.published);
    setLinked(entry?.posts ?? []);
  }
  // The featured image uploading (how many): Save waits, "Uploading…" showing on it.
  const [uploading, setUploading] = useState(0);
  const saving = useContext(ChangelogSavingContext);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveChangelogEntry(projectSlug, entry?.number ?? null, prev, formData);
    if (!result.error) {
      setDirty(false);
      setSaves((n) => n + 1);
      toast.success("Saved");
    }
    return result;
  }, {});
  // The top bar's Save (ChangelogSaveButton) says when it's saving too.
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
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start"
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
        {/* Under the title, as the portal shows it; only where uploads are set up (mediaUrls). */}
        {mediaUrls && (
          <FeaturedImage
            projectSlug={projectSlug}
            entry={entry}
            covers={covers}
            onBusy={(delta) => {
              setUploading((n) => n + delta);
              setDirty(true);
            }}
            onRemove={() => setDirty(true)}
          />
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

      {/* Beside the text with a line on its left, as a post's sidebar is: held in view as the pane scrolls, no taller than
          it (its PaneBody, a size container); under it on phones, after a line. */}
      <aside
        aria-label="Entry settings"
        className="flex flex-col gap-6 border-t pt-6 text-sm lg:sticky lg:top-0 lg:max-h-[calc(100cqh-3rem)] lg:overflow-y-auto lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
      >
        {standing && (
          <section aria-label="Status" className="flex flex-col gap-2">
            <h2 className="group-label">Status</h2>
            <p>{standing}</p>
          </section>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="group-label mb-2">Tags</legend>
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
        <WhoSeesIt
          key={`${saves}:${entry?.groups.join() ?? ""}:${entry?.emailOnly ?? false}`}
          groups={groups}
          picked={entry?.groups ?? []}
          emailOnly={entry?.emailOnly ?? false}
          upgrade={groupsUpgrade}
          saving={pending}
          onChange={() => setDirty(true)}
        />
        {/* Published: the saved ones, which publishing completed (not links changed since and not saved). */}
        <CompletedPosts
          projectSlug={projectSlug}
          posts={posts}
          linked={entry?.published ? entry.posts : linked}
          editable={!entry?.published}
          sampleEntry={entry?.sample ?? false}
          onChange={link}
        />
        {entry && pullRequests && <EntryPullRequests projectSlug={projectSlug} number={entry.number} published={entry.published} dirty={dirty} pullRequests={pullRequests} />}
        {entry && <HowAnnounced entry={entry} subscribers={subscribers} />}
      </aside>
    </form>
  );
}

/**
 * "Who sees it": the reader groups an entry is for, as chips (none picked: everyone). Sent with the form only once a
 * pick changed, so a save of the text never touches groups set meanwhile (by the API, or a teammate), nor needs the
 * plan for ones it already has.
 */
export function WhoSeesIt({
  groups,
  picked,
  emailOnly = false,
  upgrade,
  saving: pending = false,
  onChange,
}: {
  groups: { key: string; name: string }[];
  picked: string[];
  /** Saved as email-only: emailed to subscribers, listed nowhere. */
  emailOnly?: boolean;
  upgrade: UpgradePrompt | null;
  /** A save is running: the picks wait for it (one made now would be dropped as the picker starts afresh after it). */
  saving?: boolean;
  onChange: () => void;
}) {
  const [changed, setChanged] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  // Told to Publish, which waits for it: while this picker has a change it hasn't saved, and no longer once it's gone
  // (started afresh after a save, or with the form when new saved text replaces it, which drops the picks too).
  const saving = useContext(ChangelogSavingContext);
  useEffect(() => {
    saving?.setGroupsChanged(changed || onlyChanged);
    return () => saving?.setGroupsChanged(false);
  }, [saving, changed, onlyChanged]);
  const needsId = useId();
  const onlyId = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="group-label mb-2">Who sees it</legend>
      {changed && <input type="hidden" name="groupsEditable" value="1" />}
      {onlyChanged && <input type="hidden" name="emailOnlyEditable" value="1" />}
      {groups.length > 0 && <div className="flex flex-wrap gap-2">
        {groups.map((group) => (
          <label
            key={group.key}
            className="group/tag relative inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors select-none hover:bg-muted has-checked:border-primary has-checked:text-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input
              type="checkbox"
              name="groups"
              value={group.key}
              defaultChecked={picked.includes(group.key)}
              // Off, but in the keyboard's reach: a chip focused as a save starts keeps its focus.
              aria-disabled={pending || undefined}
              aria-describedby={upgrade ? needsId : undefined}
              onClick={(event) => {
                if (pending) {
                  event.preventDefault();
                  return;
                }
                // Picking one needs the plan: the prompt opens and it stays unpicked.
                if (upgrade && event.currentTarget.checked && !picked.includes(group.key)) {
                  event.preventDefault();
                  setUpgrading(true);
                }
              }}
              onChange={(event) => {
                // The pick the prompt refused, or made while a save runs (onClick put it back), isn't a change.
                if (pending || (upgrade && event.currentTarget.checked && !picked.includes(group.key))) {
                  return;
                }
                setChanged(true);
                onChange();
              }}
              className="absolute inset-0 cursor-pointer appearance-none rounded-full outline-none"
            />
            <CheckIcon aria-hidden className="hidden size-3.5 group-has-checked/tag:block" />
            {group.name}
          </label>
        ))}
      </div>}
      {groups.length > 0 && (
        <p className="text-xs text-muted-foreground">None picked: everyone. Picked: only readers in one of them, and only their subscribers get its email.</p>
      )}
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id={onlyId}
          name="emailOnly"
          value="1"
          defaultChecked={emailOnly}
          aria-describedby={`${onlyId}-hint`}
          aria-disabled={pending || undefined}
          onClick={(event) => pending && event.preventDefault()}
          onChange={() => {
            if (pending) {
              return;
            }
            setOnlyChanged(true);
            onChange();
          }}
          className="mt-0.5 size-4 accent-primary"
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor={onlyId}>Email only</label>
          <p id={`${onlyId}-hint`} className="text-xs text-muted-foreground">
            Emailed to subscribers and listed nowhere. Its page is your team&apos;s only.
          </p>
        </div>
      </div>
      {upgrade && (
        <>
          <span id={needsId} hidden>
            {upgrade.title}
          </span>
          <UpgradeDialog prompt={upgrade} open={upgrading} onOpenChange={setUpgrading} />
        </>
      )}
    </fieldset>
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
 * What the Publish dialog says happens, in one line: on the portal and in the widget, the posts it completes, and how
 * many emails it sends (said as `count`), split in `who` for the count's popover: to the subscribers (the first time;
 * publishing again, those it's still to go to) and to the people who asked for its posts. Emails, not people: nobody is
 * left out of one for being in the other, and each post it completes sends its own (postShipped).
 */
export function publishSummary({
  email,
  subscribers,
  emailedSubscribers,
  subscribersLeft,
  posts,
  asked,
  emailOnly = false,
}: {
  email: boolean;
  /** Email-only: listed nowhere, so it doesn't go on the portal or in the widget. */
  emailOnly?: boolean;
  subscribers: number;
  emailedSubscribers: boolean;
  subscribersLeft: number;
  /** How many posts it completes. */
  posts: number;
  /** How many emails the posts' Completed sends (emailedOnCompletion, summed over the posts). */
  asked: number;
}): { start: string; count: string | null; who: string } {
  const toSubscribers = emailedSubscribers ? subscribersLeft : email ? subscribers : 0;
  const emails = toSubscribers + asked;
  const where = `${emailOnly ? "It's listed nowhere" : "It goes on your portal and in your widget"}${posts > 0 ? `, completes ${plural(posts, "post")}` : ""}`;
  const who = [
    toSubscribers > 0 && `${toSubscribers} to ${emailedSubscribers ? "subscribers who haven't had it yet" : `your ${toSubscribers === 1 ? "subscriber" : "subscribers"}`}`,
    asked > 0 && `${asked} to the people who asked for ${posts === 1 ? "the post" : "the posts"} it completes`,
  ]
    .filter(Boolean)
    .join(", and ");
  return emails > 0 ? { start: `${where}${posts > 0 ? "" : ","} and sends `, count: plural(emails, "email"), who: `${who}.` } : { start: where, count: null, who: "" };
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
      <legend className="group-label mb-2">How it&apos;s announced</legend>
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
          <p>{entry.announced ? "Marked new in your widget." : "Not marked new."}</p>
          {/* The subscribers are the line above: here only the people who asked for its posts. */}
          {entry.told !== null && entry.told.asked > 0 && <p>{toldText({ asked: entry.told.asked, subscribers: 0 })}</p>}
        </>
      ) : entry.sample ? (
        // changelog.publish: a sample entry is never announced or emailed.
        <p>Sample updates aren&apos;t emailed or marked new.</p>
      ) : entry.importedOn ? (
        // changelog.publish: nor is an imported one, the first time.
        <p>Published before you imported it: it keeps that date ({entry.importedOn}) and isn&apos;t emailed or marked new.</p>
      ) : (
        <>
          {entry.emailedSubscribers ? (
            <p>
              {entry.emailedFrom
                ? `Emailed from ${entry.emailedFrom} before: not sent again.`
                : entry.subscribersLeft > 0
                ? `Emailed to ${subscriberCountText(entry.subscribersSent)}. Publishing sends it to ${stillToEmail(entry.subscribersLeft)}.`
                : subscribers === null
                  ? `Emailed to ${subscriberCountText(entry.subscribersSent)} before. Your portal is private now: nobody else gets it.`
                  : `Emailed to ${subscriberCountText(entry.subscribersSent)} when first published: not sent again.`}
            </p>
          ) : (
            choice(
              "Email subscribers",
              entry.emailPaused
                ? "Your project's email is paused."
                : subscribers === null
                ? "Your portal is private, so it isn't emailed."
                : entry.groups.length > 0
                  ? // Counted in its groups only (changelogEmailed sends it to no one else).
                    subscribers === 0
                    ? "Nobody in its groups has subscribed."
                    : `${people(subscribers)} in its groups subscribed.`
                  : subscribers === 0
                    ? "Nobody has subscribed yet."
                    : `${people(subscribers)} subscribed.`,
              { checked: announce.email && !!subscribers, disabled: !subscribers, onChange: (event) => pick({ email: event.target.checked }) },
            )
          )}
          {choice("Mark it new", "A dot in your widget until readers see it.", {
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
      <h2 className="group-label">Posts it completes</h2>
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

export type EntryPullRequestsProps = {
  /** The pull requests it has; `id`, `author` and `mergedAt` where Autopilot read it (PullRequestChip). */
  list: { id?: string; repo: string; number: number; url: string; title: string; author?: string; mergedAt?: string }[];
  /** GitHub is connected: a draft has "Add changes…". */
  canAdd: boolean;
  /** Where adding puts them: null for this entry (the running draft), else the running draft's title (one that would be started). */
  addsTo: string | null;
};

/** The section's heading: Take out and Add change its rows (and a new text remounts the form), so focus goes here. */
const PULL_REQUESTS_HEADING = "entry-pull-requests";
const focusPullRequests = { next: false };

/**
 * The merged pull requests an entry has: each opens on GitHub; a draft's are taken out (with their line,
 * changelog.removePullRequest) or added with "Add changes…" (changelog.missingChanges, changelog.addPullRequests), both
 * saved at once, on the saved text. A published entry's are listed as they shipped.
 */
function EntryPullRequests({
  projectSlug,
  number,
  published,
  dirty,
  pullRequests: { list, canAdd, addsTo },
}: {
  projectSlug: string;
  number: number;
  published: boolean;
  /** The form has changes that aren't saved: taking one out or adding edits the saved text, and the form starts afresh with it. */
  dirty: boolean;
  pullRequests: EntryPullRequestsProps;
}) {
  const [pending, startTransition] = useTransition();
  // Once the list has changed (or the form, given a new text, is made again with it): focus to the heading, if asked.
  const shown = list.map((pr) => pr.url).join(" ");
  useEffect(() => {
    if (focusPullRequests.next) {
      focusPullRequests.next = false;
      document.getElementById(PULL_REQUESTS_HEADING)?.focus();
    }
  }, [shown]);
  const saved = () => {
    if (dirty) {
      toast.error("Save your changes first: pull requests change the saved text.");
    }
    return !dirty;
  };
  // Asked first (docs/design.md): its line leaves the text, with whatever the team wrote in it, and adding it back
  // brings Autopilot's line or its title.
  const [confirming, setConfirming] = useState<{ url: string; ref: string } | null>(null);
  const takeOut = (url: string) =>
    startTransition(async () => {
      // Its button goes (disabled meanwhile, then gone): focus goes to the section's heading.
      focusPullRequests.next = true;
      const result = await removeChangelogPullRequest(projectSlug, number, url);
      if (result.error) {
        // The dialog stays, to try again or cancel.
        focusPullRequests.next = false;
        toast.error(result.error);
      } else {
        setConfirming(null);
        toast.success("Taken out");
      }
    });

  return (
    <section aria-labelledby={PULL_REQUESTS_HEADING} className="flex flex-col gap-2">
      <h2 id={PULL_REQUESTS_HEADING} tabIndex={-1} className="group-label outline-none">
        Pull requests
      </h2>
      {list.length === 0 ? (
        <p className="text-muted-foreground">None.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((pr) => (
            <li key={pr.url} className="flex items-start gap-2">
              {/* As Autopilot shows them: "PR #41", its title, and a link to GitHub on hover or a press. */}
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <PullRequestChip projectSlug={projectSlug} pr={pr} />
                {/* The chip's name says it already ("PR #41: <title>"): read once. */}
                <span aria-hidden className="min-w-0 line-clamp-2 break-words">
                  {pr.title}
                </span>
              </div>
              {!published && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Take out ${pr.repo}#${pr.number}`}
                  title="Take out"
                  disabled={pending}
                  focusableWhenDisabled
                  onClick={() => saved() && setConfirming({ url: pr.url, ref: `${pr.repo}#${pr.number}` })}
                >
                  <XIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!published && canAdd && <AddChanges projectSlug={projectSlug} addsTo={addsTo} saved={saved} />}
      {/* Not closed while it's taking it out: Cancel then would undo nothing. */}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !pending && setConfirming(null)}>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle>Take out {confirming?.ref}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its line leaves the text, with any changes you made to it.
              {/* Only where it can (GitHub connected): Add changes… is the way back. */}
              {canAdd && " Add changes… puts it back with Autopilot's line or its title."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} focusableWhenDisabled onClick={() => confirming && takeOut(confirming.url)}>
              Take out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** "Add changes…": the merged pull requests no entry has, those Autopilot found nothing for users in unticked, added to the running draft. */
function AddChanges({ projectSlug, addsTo, saved }: { projectSlug: string; addsTo: string | null; saved: () => boolean }) {
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<{ error?: string; missing?: MissingChanges } | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  // Adding (not reading GitHub, which can be left): the dialog stays until it's done, or what's typed meanwhile would be
  // lost when the page reloads with the added lines.
  const [adding, startAdding] = useTransition();
  const missing = found?.missing;
  const key = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;
  const picked = missing?.pullRequests.filter((pr) => !unticked.has(key(pr))) ?? [];
  const since = missing && formatDate(new Date(missing.since));
  const cost = missing?.cost;

  const read = () =>
    startTransition(async () => {
      const result = await findMissingChanges(projectSlug);
      setFound(result);
      setUnticked(untickedByDefault(result.missing?.pullRequests ?? []));
    });
  const add = () =>
    // Into this draft's text: what isn't saved would be lost (adding to another draft leaves this one alone).
    (addsTo !== null || saved()) &&
    startAdding(async () => {
      focusPullRequests.next = addsTo === null;
      const result = await addChangelogPullRequests(
        projectSlug,
        picked.map(({ repo, number }) => ({ repo, number })),
      );
      // Nothing added (all in an entry by now, or refused): the list doesn't change, so nothing would clear the flag. Some
      // added (a later batch refused): it does, and focus goes to the section's heading as after a success.
      if (!result.added) {
        focusPullRequests.next = false;
      }
      if (result.error) {
        // In a toast too, which stays: the dialog may have been closed meanwhile, or (some added before a later batch
        // was refused) the page reloads with them, which remounts it closed in the draft they went into.
        toast.error(result.added ? `Added ${plural(result.added, "pull request")}, then: ${result.error}` : result.error);
        setFound({ ...found, error: result.error });
        return;
      }
      setOpen(false);
      toast.success(`Added ${plural(result.added ?? 0, "pull request")}${addsTo === null ? "" : ` to “${addsTo}”`}`);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (adding) {
          return;
        }
        setOpen(next);
        if (next) {
          setFound(null);
          read();
        }
      }}
    >
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" className="self-start" />}>
        <PlusIcon />
        Add changes…
      </DialogTrigger>
      <DialogContent showCloseButton={!adding} className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add changes</DialogTitle>
          <DialogDescription>
            {since ? `Pull requests merged since ${since} that no entry has. ` : "Merged pull requests that no entry has. "}
            {addsTo === null ? "They're added to this draft, a line each." : `They go into “${addsTo}”, which collects merged pull requests, not into this draft.`}
          </DialogDescription>
        </DialogHeader>
        {found?.error && (
          <p role="alert" className="text-sm text-destructive">
            {found.error}
          </p>
        )}
        {!found && (
          <p role="status" className="text-sm text-muted-foreground">
            Reading GitHub…
          </p>
        )}
        {missing && missing.pullRequests.length === 0 && <p className="text-sm text-muted-foreground">Nothing&apos;s missing: every one is in an entry.</p>}
        {missing && missing.pullRequests.length > 0 && (
          <>
            <ul aria-label="Missing pull requests" className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
              {missing.pullRequests.map((pr) => (
                <li key={key(pr)}>
                  <label className="flex items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      checked={!unticked.has(key(pr))}
                      onChange={(event) => {
                        const next = new Set(unticked);
                        if (event.target.checked) {
                          next.delete(key(pr));
                        } else {
                          next.add(key(pr));
                        }
                        setUnticked(next);
                      }}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="break-words">{pr.title}</span>
                      <span className="text-xs break-all text-muted-foreground">
                        {[`${pr.repo}#${pr.number}`, pr.author, formatDate(new Date(pr.mergedAt)), pr.forUsers === false && "Nothing for users"].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {cost && (
              <p className="text-sm">
                {cost.each === null ? (
                  <>Autopilot analyses each one, which costs AI credits. You have {credits(cost.balance)}.</>
                ) : (
                  <>
                    Autopilot analyses each one: about <strong>{credits(cost.each * picked.length)} AI credits</strong>, about {credits(cost.each)} a pull request, what a
                    typical one costs. You have {credits(cost.balance)}.
                  </>
                )}
              </p>
            )}
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={adding} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {missing && missing.pullRequests.length > 0 && (
            <Button type="button" disabled={pending || adding || picked.length === 0} focusableWhenDisabled onClick={add}>
              {adding ? "Adding…" : `Add ${plural(picked.length, "pull request")}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

/**
 * What's saved, as Settings → Changelog's form holds it, in its fields' order (useCustomizeForm's `saved`): without AI
 * (`drafting` false) the form has the cover's fields only, and a field listed that it doesn't have would make the page
 * look changed as it opens.
 */
export function changelogStyleSaved({
  drafting,
  tone,
  examples,
  screenshotMarkers,
  coverDesign,
  coverBackground,
}: {
  drafting: boolean;
  tone: string;
  examples: number[];
  screenshotMarkers: boolean;
  coverDesign: CoverDesign | null;
  coverBackground: { id: string; url: string } | null;
}): [name: string, value: string][] {
  return [
    ...(drafting
      ? [
          ["tone", tone] as [string, string],
          ...examples.map((number): [string, string] => ["examples", String(number)]),
          ...(screenshotMarkers ? [["screenshotMarkers", "on"] as [string, string]] : []),
        ]
      : []),
    ["coverDesign", coverDesign ?? ""],
    ["coverBackground", coverBackground?.id ?? ""],
    ["coverBackgroundUrl", coverBackground?.url ?? ""],
  ];
}

/** The most examples a style takes (changelog.updateStyle's MAX_STYLE_EXAMPLES, which checks it). */
const MAX_EXAMPLES = 3;

/**
 * Settings → Changelog, saved by the page's "Save changes": "Drafting with AI" (with `model`, where the server has AI),
 * the AI model, the team's instructions (stored as tone notes), up to 3 published entries as examples and the
 * screenshots' markers; then "Cover", the design picked first, each drawn on a sample entry, the team's own background
 * one of them.
 */
export function ChangelogStyleForm({
  projectSlug,
  model,
  tone,
  examples,
  screenshotMarkers,
  coverDesign,
  coverBackground,
  published,
}: {
  projectSlug: string;
  /** The AI model's setting; null where the server has no AI, which shows the covers only. */
  model: ReactNode;
  tone: string;
  /** AI drafts mark where a screenshot belongs. */
  screenshotMarkers: boolean;
  /** The cover design picked first; null for the automatic pick. */
  coverDesign: CoverDesign | null;
  /** The team's image for the Your background design. */
  coverBackground: { id: string; url: string } | null;
  /** The entries picked as examples, by number. */
  examples: number[];
  /** Published entries, newest first; `sample`: one of Home's sample updates, which AI never follows unpicked. */
  published: { number: number; title: string; sample?: boolean }[];
}) {
  const [picked, setPicked] = useState(examples);
  // Saved elsewhere meanwhile (another tab), what isn't edited here follows: the examples as the server sends them…
  const [examplesWere, setExamplesWere] = useState(examples);
  if (examplesWere.join() !== examples.join()) {
    setExamplesWere(examples);
    if ([...picked].sort().join() === [...examplesWere].sort().join()) {
      setPicked(examples);
    }
  }
  // …and the instructions (before the form compares with what's saved, in useCustomizeForm's effect).
  const toneField = useRef<HTMLTextAreaElement>(null);
  const toneWas = useRef(tone);
  useLayoutEffect(() => {
    if (toneField.current?.value === toneWas.current.replace(/\r\n?/g, "\n")) {
      toneField.current.value = tone;
    }
    toneWas.current = tone;
  }, [tone]);
  // …and the screenshots' switch.
  const [marking, setMarking] = useState(screenshotMarkers);
  const [markingWas, setMarkingWas] = useState(screenshotMarkers);
  if (markingWas !== screenshotMarkers) {
    setMarkingWas(screenshotMarkers);
    if (marking === markingWas) {
      setMarking(screenshotMarkers);
    }
  }
  // …and the cover's design and background.
  const [design, setDesign] = useState(coverDesign);
  const [designWas, setDesignWas] = useState(coverDesign);
  if (designWas !== coverDesign) {
    setDesignWas(coverDesign);
    if (design === designWas) {
      setDesign(coverDesign);
    }
  }
  const designField = useRef<HTMLFieldSetElement>(null);
  useFieldChanged(designField, design);
  const backgroundId = useId();
  const uploadBackground = useRef<HTMLButtonElement>(null);
  const background = useImageUpload({ projectSlug, name: "coverBackground", id: backgroundId, label: "Cover background", image: coverBackground, onBusy: () => {} });
  const [uploads, setUploads] = useState(0);
  const backgroundOption = useRef<HTMLInputElement>(null);
  const [backgroundWas, setBackgroundWas] = useState(coverBackground);
  // The background shown last: one uploaded here since is picked as the design.
  const [shownWas, setShownWas] = useState(coverBackground?.id);
  if (backgroundWas?.id !== coverBackground?.id) {
    setBackgroundWas(coverBackground);
    // Untouched, or the one just saved (its link as the server gives it, so the form matches what's saved).
    if (background.image?.id === backgroundWas?.id || background.image?.id === coverBackground?.id) {
      background.setImage(coverBackground);
      setShownWas(coverBackground?.id);
    }
  } else if (shownWas !== background.image?.id) {
    setShownWas(background.image?.id);
    if (background.image) {
      setDesign("background");
      setUploads(uploads + 1);
    }
  }
  // Uploaded, Upload's tile is gone: focus that was on it (left on the page's body) goes to the picture it made. Focus
  // moved elsewhere meanwhile (typing in Instructions while it uploads) stays there.
  useEffect(() => {
    if (uploads > 0 && (!document.activeElement || document.activeElement === document.body)) {
      backgroundOption.current?.focus();
    }
  }, [uploads]);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const pick = useRef<HTMLButtonElement>(null);
  // The dialog, opened, has had its pick.
  const done = useRef(false);
  const { state, pending, form } = useCustomizeForm({
    saved: changelogStyleSaved({ drafting: Boolean(model), tone, examples, screenshotMarkers, coverDesign, coverBackground }),
    busy: background.uploading,
    save: async (prev, formData) => {
      const result = await saveChangelogStyle(projectSlug, prev, formData);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Changelog saved");
      }
      return result;
    },
  });
  // The picks still published (one unpublished since doesn't count), in the changelog's order whatever the order
  // picked, so the same examples are never a change to save.
  const chosen = published.filter((entry) => picked.includes(entry.number));
  // Chips come and go without anyone typing: the form is told, for "Save changes".
  useFieldChanged(pick, `${chosen.map((entry) => entry.number).join()} ${marking}`);
  // No more to pick: 3 are, or every published entry is.
  const full = chosen.length >= Math.min(MAX_EXAMPLES, published.length);
  const words = query.trim().toLowerCase();
  const matches = published.filter((entry) => !picked.includes(entry.number) && entry.title.toLowerCase().includes(words));

  return (
    // Locked while saving: an edit made then wouldn't be in what's saved. `inert`, not disabled fields: those would
    // drop out of what the form holds, which "Save changes" compares with what's saved.
    <form {...form} inert={pending} className="flex flex-col gap-7">
      {model && (
        <SettingsCard title="Drafting with AI">
          {/* Saved as it's chosen, not by the page's Save: Enter in its Custom boxes doesn't save the form too (the boxes
              cancel the browser's own submitting themselves; Enter on a level's button still picks it). */}
          <div onKeyDown={(event) => event.stopPropagation()}>{model}</div>
          <SettingBlock className="gap-2">
            <label htmlFor="style-tone" className="font-medium">
              Instructions
            </label>
            <Textarea
              ref={toneField}
              id="style-tone"
              name="tone"
              defaultValue={tone}
              maxLength={4000}
              placeholder="Friendly, short sentences, no jargon. Address the reader as you."
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? "style-error" : undefined}
            />
            {state.error && <FieldError id="style-error">{state.error}</FieldError>}
          </SettingBlock>
          <SettingRow
            label={
              <>
                Style examples{" "}
                {published.length > 0 && (
                  <span className="font-normal text-muted-foreground tabular-nums">
                    {chosen.length}/{MAX_EXAMPLES}
                  </span>
                )}
              </>
            }
            description={published.length === 0 ? "Publish an entry to use it as an example." : "Entries that read the way you like."}
            // What drafts follow meanwhile (writingStyle): said only where there's an entry of the team's own to follow.
            info={chosen.length === 0 && published.some((entry) => !entry.sample) ? "With none picked, AI follows your three latest published entries." : undefined}
          >
            {published.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 @min-[34rem]/settings:max-w-[26rem] @min-[34rem]/settings:justify-end">
                <ul aria-label="Style examples" className="contents">
                  {chosen.map((entry) => (
                    <li key={entry.number} className="flex max-w-full items-center gap-0.5 rounded-lg bg-muted py-0.5 pr-0.5 pl-2.5 text-sm">
                      <input type="hidden" name="examples" value={entry.number} />
                      {/* A long title wraps: cut short, two that start alike would read the same. */}
                      <span className="min-w-0 break-words">{entry.title}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${entry.title}`}
                        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        onClick={() => {
                          // From what still shows: an example unpublished meanwhile is gone for good, republished or not.
                          setPicked(chosen.filter((other) => other.number !== entry.number).map((other) => other.number));
                          // Its button is gone: focus goes to Pick, not to the top of the page.
                          pick.current?.focus();
                        }}
                      >
                        <XIcon aria-hidden className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <Button
                  ref={pick}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  aria-label="Pick a style example"
                  // Focusable all the same (removing a chip sends focus here).
                  disabled={full}
                  focusableWhenDisabled
                  onClick={() => {
                    done.current = false;
                    setQuery("");
                    setPicking(true);
                  }}
                >
                  <PlusIcon />
                  Pick
                </Button>
              </div>
            )}
          </SettingRow>
          <SettingRow
            label="Mark where screenshots go"
            htmlFor="style-screenshots"
            description="A draft leaves a line where a picture belongs, to replace before publishing."
            info="AI can't take screenshots. With this on, a draft has a line like [Screenshot: the new theme menu] where one would help, and the entry can't be published while such a line is left."
            inline
          >
            <Switch id="style-screenshots" aria-describedby="style-screenshots-description" name="screenshotMarkers" checked={marking} onChange={(event) => setMarking(event.target.checked)} />
          </SettingRow>
        </SettingsCard>
      )}
      <SettingsCard title="Cover" description="Picked first when you publish an entry without a cover, or make one.">
        <SettingBlock>
          <fieldset ref={designField} aria-describedby="style-cover-automatic" className="grid grid-cols-2 gap-x-3 gap-y-4 @min-[34rem]/settings:grid-cols-3">
            <legend className="sr-only">Cover picked first</legend>
            {([null, "title", "screenshot", "sections", "pattern", ...(background.image ? (["background"] as const) : [])] as const).map((each) => (
              <div key={each ?? "automatic"} {...(each === "background" && background.drop)} className="flex min-w-0 flex-col gap-1.5">
                <label className={cn(coverOption, "text-sm")}>
                  <input ref={each === "background" ? backgroundOption : undefined} type="radio" name="coverDesign" value={each ?? ""} className="peer sr-only" checked={design === each} onChange={() => setDesign(each)} />
                  {each === null ? (
                    <span aria-hidden className={cn(coverPicture, "flex items-center justify-center text-muted-foreground")}>
                      <SparklesIcon className="size-5" />
                    </span>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- drawn for this project by Settings' preview route
                    <img
                      src={`/app/${projectSlug}/settings/changelog/cover/${each}${each === "background" ? `?background=${background.image!.id}` : ""}`}
                      alt=""
                      width={800}
                      height={420}
                      className={coverPicture}
                    />
                  )}
                  {each === null ? "Automatic" : COVER_DESIGN_NAMES[each]}
                </label>
                {each === "background" && (
                  <div className="-mt-1 flex items-center gap-1">
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0"
                      aria-label="Replace cover background"
                      disabled={background.uploading}
                      focusableWhenDisabled
                      onClick={background.pick}
                    >
                      {background.uploading ? "Uploading…" : "Replace"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Remove cover background"
                      title="Remove"
                      disabled={background.uploading}
                      focusableWhenDisabled
                      onClick={() => {
                        // Its design goes with it, and focus to Upload, which takes its place.
                        flushSync(() => {
                          background.setImage(null);
                          if (design === "background") {
                            setDesign(null);
                          }
                        });
                        uploadBackground.current?.focus();
                      }}
                    >
                      <XIcon />
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {!background.image && (
              <div {...background.drop} className="flex min-w-0 flex-col gap-1.5">
                {/* Unstyled (Base UI's), so it looks like the pictures beside it. */}
                <ButtonPrimitive
                  ref={uploadBackground}
                  type="button"
                  aria-label="Upload Your background"
                  // Off while one uploads, yet focusable: focus stays here through the upload, "Uploading…" read below.
                  disabled={background.uploading}
                  focusableWhenDisabled
                  onClick={background.pick}
                  className={cn(coverOption, "text-left text-sm outline-none focus-visible:*:first:ring-2 focus-visible:*:first:ring-ring")}
                >
                  <span
                    className={cn(
                      coverPicture,
                      "flex items-center justify-center gap-1.5 border-dashed bg-transparent text-muted-foreground transition-colors hover:bg-muted",
                      background.dragging && "bg-soft",
                    )}
                  >
                    <UploadIcon className="size-4" />
                    {background.uploading ? "Uploading…" : "Upload"}
                  </span>
                  Your background
                </ButtonPrimitive>
              </div>
            )}
          </fieldset>
          {background.inputs}
          <p id="style-cover-automatic" className="text-sm text-muted-foreground">
            Automatic is Screenshot when the entry has a large enough image, else Title.
          </p>
          {background.uploading && (
            <p role="status" className="sr-only">
              Uploading…
            </p>
          )}
          {background.error && <FieldError>{background.error}</FieldError>}
        </SettingBlock>
      </SettingsCard>
      {/* Outside the form in the page (a portal): typing in its search isn't a change to save. */}
      <Dialog open={picking} onOpenChange={setPicking}>
        {/* Closed, by a pick or without one, focus goes back to Pick. */}
        <DialogContent finalFocus={pick}>
          <DialogHeader>
            <DialogTitle>Pick a style example</DialogTitle>
            <DialogDescription>A published entry that reads the way you like.</DialogDescription>
          </DialogHeader>
          <Input autoFocus placeholder="Search by title" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search published entries" autoComplete="off" />
          <ul className="-mx-2 max-h-72 overflow-y-auto">
            {matches.map((entry) => (
              <li key={entry.number}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-2 text-left text-sm break-words hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  onClick={() => {
                    // One pick a time it's opened: a second press while it closes would pick the entry that moved up.
                    if (!done.current) {
                      done.current = true;
                      setPicked([...chosen.map((other) => other.number), entry.number]);
                      setPicking(false);
                    }
                  }}
                >
                  {entry.title}
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">No matching entries.</li>}
          </ul>
        </DialogContent>
      </Dialog>
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
  markers = [],
  covers = null,
  emailOnly = false,
  part,
}: {
  projectSlug: string;
  number: number;
  title: string;
  published: boolean;
  /** Saved as email-only: the Publish dialog says it's listed nowhere. */
  emailOnly?: boolean;
  /** Lines an AI draft left for the team to fill in ("[Check: …]", "[Screenshot: …]"), still in the saved text: it isn't published with them. */
  markers?: string[];
  /** The entry has no cover and one can be composed: the Publish dialog offers its designs, with one picked. */
  covers?: CoverChoices | null;
  /** How many posts publishing moves to Completed (not those Completed or Closed already). */
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
  // Who it's for changed and isn't saved: Publish would send it to whoever the saved groups say.
  const groupsUnsaved = saving?.groupsChanged ?? false;
  const aiFirst = unwritten !== undefined && canDraftWithAi && !aiPaused && !locked;
  // Sample and imported entries go out without announcing (changelog.publish): no subscriber is emailed.
  const summary = publishSummary({
    email: !sample && !importedOn && announce.email,
    subscribers,
    emailedSubscribers: !sample && !importedOn && emailedSubscribers,
    subscribersLeft: sample || importedOn ? 0 : subscribersLeft,
    posts: postCount,
    asked: emails,
    emailOnly,
  });
  // The cover Publish adds (the entry's own design until they pick), or "none".
  const [pickedCover_, setPickedCover] = useState<CoverDesign | "none">();
  // Not over a featured image the form has and hasn't saved yet: Publish publishes what's saved, and theirs stays theirs.
  const cover = covers && !saving?.coverChanged && pickedCover(covers, pickedCover_);
  const withCover = cover && cover !== "none" ? cover : undefined;
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
        {/* A row of the "More actions" menu, as a destructive DropdownMenuItem looks; on its tint the text is the darker red (4.5:1). */}
        <AlertDialogTrigger
          render={
            <Button
              variant="ghost"
              disabled={pending}
              className="h-auto gap-1.5 rounded-md px-1.5 py-1 font-normal text-destructive hover:bg-destructive/10 hover:text-destructive-foreground focus-visible:bg-destructive/10 focus-visible:text-destructive-foreground aria-expanded:bg-destructive/10 aria-expanded:text-destructive-foreground dark:hover:bg-destructive/20 dark:focus-visible:bg-destructive/20"
            />
          }
        >
          Delete
        </AlertDialogTrigger>
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
      {/* With the cover's designs it can be taller than a phone's screen: it scrolls, so Publish is in reach. Wider with
          them, so the designs fit in one row. */}
      <AlertDialogContent className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", covers && "sm:max-w-md")}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {markers.length > 0
              ? markers.length === 1
                ? "Replace a line before publishing"
                : `Replace ${markers.length} lines before publishing`
              : groupsUnsaved
                ? "Save who sees it before publishing"
                : `Publish “${title}”?`}
          </AlertDialogTitle>
          {/* The lines are the team's text, any length (a link, a line of code): they wrap anywhere, or the dialog would be as wide as the longest. */}
          {/* A div, so the note on text not written yet is in it too: all of it is read out as the dialog opens. */}
          <AlertDialogDescription render={<div />} className={cn("flex flex-col gap-3", markers.length > 0 && "wrap-anywhere")}>
            {/* Said first, and in the description, which is read out as the dialog opens: what the draft left to fill in, named so it's found in the text. */}
            {markers.length === 0 && groupsUnsaved ? (
              <p>{`You changed who sees “${title}” and haven't saved it. Save, then publish.`}</p>
            ) : markers.length > 0 ? (
              <p>{`“${title}” still has ${markers.length === 1 ? "a line" : "lines"} left to fill in: ${markers.join(" ")} Replace or remove ${markers.length === 1 ? "it" : "them"}, save, then publish.`}</p>
            ) : (
              <p>
                {summary.start}
                {summary.count && (
                  <Popover>
                    <PopoverTrigger openOnHover className="rounded-sm text-foreground underline decoration-dotted underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {summary.count}
                    </PopoverTrigger>
                    <PopoverContent className="max-w-72 p-3 text-sm">{summary.who}</PopoverContent>
                  </Popover>
                )}
                .{sample && " Sample updates are published without announcing."}
                {importedOn && ` Published before you imported it, it keeps that date (${importedOn}) and isn't announced.`}
              </p>
            )}
            {/* Not written yet: said in one tinted line, with Draft with AI beside it (it closes this dialog and opens its own, which says what it replaces). */}
            {unwritten && markers.length === 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-highlight px-3 py-2 text-sm text-highlight-foreground">
                <p className="flex-1">
                  {unwritten === "titles"
                    ? "Its text is still the pull requests' titles."
                    : unwritten === "lines"
                      ? "Its text is still Autopilot's lines, one per pull request."
                      : "It has no text yet, only its pull requests."}
                </p>
                {aiFirst && (
                  <AlertDialogCancel variant="link" className="h-auto p-0 font-medium text-highlight-foreground underline" onClick={() => setDrafting(true)}>
                    Draft with AI first
                  </AlertDialogCancel>
                )}
              </div>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* No cover yet: its designs, drawn for this entry, with one picked already (not while lines are left to fill in: it can't be published). */}
        {covers && cover && markers.length === 0 && (
          <CoverDesigns projectSlug={projectSlug} number={number} covers={covers} value={cover} onChange={setPickedCover} none className="grid-cols-3 sm:grid-cols-4" />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* A sample entry is never announced or emailed (changelog.publish), nor an imported one the first time; a real one goes as the sidebar has it. */}
          <AlertDialogAction
            // Off while lines are left to fill in, but in the keyboard's reach: the description says why.
            disabled={busy || markers.length > 0 || groupsUnsaved}
            focusableWhenDisabled
            onClick={() =>
              sample || importedOn
                ? run((slug, n) => publishChangelogEntry(slug, n, false, false, withCover), "Published without announcing")
                : run((slug, n) => publishChangelogEntry(slug, n, announce.markNew, emailing, withCover), "Published")
            }
          >
            Publish
          </AlertDialogAction>
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
