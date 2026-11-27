"use client";

import type { Doc, MediaUrls } from "@tuti/content";
import type { Editor } from "@tiptap/react";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type RefObject, useActionState, useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { ChangelogSaveButton, ChangelogSavingContext } from "@/components/changelog";
import { pillClass } from "@/components/filter-pills";
import { BARE_TITLE, RichEditor } from "@/components/rich-editor";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { VersionState } from "@/lib/changelog-versions";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";

/**
 * A changelog entry's languages in its editor (docs/plan.md L16): the language pill in the top bar, the sidebar's
 * Languages, and the form a version in another language is written in.
 */


const STATES: Record<VersionState, { label: string; dot: string }> = {
  default: { label: "Default", dot: "bg-primary" },
  current: { label: "Up to date", dot: "bg-primary" },
  written: { label: "Written by your team", dot: "bg-primary" },
  translating: { label: "Translating…", dot: "bg-status-under-review" },
  waiting: { label: "Can't translate yet", dot: "bg-destructive" },
  behind: { label: "Default language changed", dot: "bg-status-under-review" },
  setting: { label: "Product setting changed", dot: "bg-status-under-review" },
  unwritten: { label: "Not written", dot: "bg-muted-foreground" },
};

/** One of an entry's languages: the default first, its editor's address in each (`href`). */
export type EntryLanguage = { code: string; name: string; state: VersionState; href: string };

/** What a state says, the default language named where its text changed. */
const stateLabel = (state: VersionState, defaultName: string) => (state === "behind" ? `${defaultName} changed` : STATES[state].label);

const Dot = ({ state }: { state: VersionState }) => <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATES[state].dot)} />;

/** The top bar's pill: the language shown ("English ▾"), a menu of the entry's languages with where each stands. */
export function ChangelogLanguagePill({ languages, current }: { languages: EntryLanguage[]; current: string }) {
  const shown = languages.find((language) => language.code === current) ?? languages[0]!;
  const defaultName = languages[0]!.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`Language: ${shown.name}`} className={pillClass(false)}>
        <span className="truncate">{shown.name}</span>
        <ChevronDownIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-64">
        {languages.map((language) => (
          <DropdownMenuItem key={language.code} render={<Link href={language.href} aria-current={language.code === shown.code ? "page" : undefined} />}>
            <Dot state={language.state} />
            {language.name}
            <span className="ml-auto pl-4 text-xs text-muted-foreground">{stateLabel(language.state, defaultName)}</span>
            <CheckIcon aria-hidden className={language.code === shown.code ? "text-primary" : "invisible"} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The sidebar's Languages: each of the entry's other languages with its dot and where it stands, a link to its version. */
export function ChangelogLanguageList({ languages, current }: { languages: EntryLanguage[]; current: string }) {
  const defaultName = languages[0]!.name;
  return (
    <section aria-labelledby="entry-languages" className="flex flex-col gap-2">
      <h2 id="entry-languages" className="group-label">
        Languages
      </h2>
      <ul className="flex flex-col gap-1">
        {languages.slice(1).map((language) => (
          <li key={language.code}>
            <Link
              href={language.href}
              aria-current={language.code === current ? "page" : undefined}
              className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted aria-[current=page]:bg-muted"
            >
              <Dot state={language.state} />
              <span className="truncate">{language.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{stateLabel(language.state, defaultName)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The form a version is written in (the pill's other languages): its Save is in the top bar (`form`). */
export const VERSION_FORM = "changelog-version";

export type VersionView = {
  code: string;
  name: string;
  state: VersionState;
  keepUpToDate: boolean;
  /** For changelog.saveTranslation: a save from an older read is refused. */
  version: string;
  /** Why it can't be translated yet, if it can't. */
  waiting: string | null;
  title: string;
  /** Its text; the default language's while it has none yet (not written, or its first translation still to come), to write over. */
  content: Doc;
  /** `title` and `content` are its own (false: the default language's, shown in their place). */
  own: boolean;
};

/** Which kind of page a version is of: a changelog entry's is translated whole; an article's by section (L11). */
export type VersionKind = "changelog" | "article";

/** The one line over a version's text: where it stands, and what saving does. */
function versionLine(view: VersionView, defaultName: string, kind: VersionKind) {
  switch (view.state) {
    case "current":
      return kind === "article"
        ? // Published edits give way where English changes; a draft's never do, so it says published.
          `Translated automatically from ${defaultName}. Publishing ${defaultName} again replaces your published edits in the sections it touches.`
        : `Translated automatically from ${defaultName}. Saving your edits turns off Keep up to date.`;
    case "translating":
      return `Translating from ${defaultName}…`;
    case "waiting":
      return `Can't translate it yet: ${view.waiting}.`;
    case "behind":
      return `${defaultName} changed since this was saved.`;
    case "setting":
      return `"Our product is available in ${view.name}" changed since this was saved.`;
    case "unwritten":
      // An article's draft, saved and not published yet (an entry's version has no drafts).
      return view.own ? `Not published yet: readers get the ${defaultName} text until you publish it.` : `Not written yet: it starts as the ${defaultName} text.`;
    default:
      return null;
  }
}

/** What a version form hands on to the one the page's next read mounts: its unsaved title and text, and the token they go from. */
type Carried = { title: string; content: Doc; token: string; mediaUrls: MediaUrls };

/**
 * A version's editor: one per language (the page keys it so), holding what's typed and not saved across the form it shows,
 * which is mounted afresh for each read with new text (`formKey`): every read goes through the editor's own checks (text it
 * can't read stays read-only, images from their addresses), and typing survives it.
 */
export function ChangelogVersionEditor({ formKey, ...props }: Omit<Parameters<typeof ChangelogVersionForm>[0], "drafts"> & { formKey: string }) {
  const [drafts] = useState(draftStore);
  return <ChangelogVersionForm key={formKey} {...props} drafts={drafts} />;
}

/** The editor's unsaved draft, across the forms it mounts, and which of them is the one shown (the last mounted). */
function draftStore() {
  let draft: Carried | null = null;
  let shownForm: string | null = null;
  return {
    take: () => draft,
    put: (next: Carried | null) => {
      draft = next;
    },
    /** A form mounted (its effect: run twice in Strict Mode, to the same effect). */
    show: (form: string) => {
      shownForm = form;
    },
    shown: (form: string) => form === shownForm,
  };
}
type Drafts = ReturnType<typeof draftStore>;

/** A version's save (its form: title, text, `version`, and `intent` "publish" for an article's Publish), and its Keep up to date. */
export type VersionActions = {
  save: (state: FormState, formData: FormData) => Promise<FormState & { version?: string }>;
  keep: (on: boolean, version: string) => Promise<FormState & { version?: string; changed?: boolean }>;
};

export function ChangelogVersionForm({
  projectSlug,
  save,
  keep,
  kind = "changelog",
  defaultName,
  view,
  mediaUrls,
  languages,
  drafts,
}: VersionActions & {
  projectSlug: string;
  kind?: VersionKind;
  defaultName: string;
  view: VersionView;
  mediaUrls: MediaUrls | null;
  /** The sidebar's Languages (none: no list). */
  languages: EntryLanguage[];
  /** The editor's unsaved draft, carried across the forms it mounts (ChangelogVersionEditor). */
  drafts: Drafts;
}) {
  // A draft carried from the form before this one (typed after its last save was sent, the page having read again since):
  // this form starts from it, and from the token that typing goes from, so its Save is checked against that.
  const [start] = useState(drafts.take);
  // This form's mount: only the one shown writes the carried draft (a late answer to an unmounted form's save leaves it). Its
  // id stable across renders (Strict Mode calls state initializers twice: a counter there would skip past it).
  const mount = useId();
  useEffect(() => drafts.show(mount), [drafts, mount]);
  const current = () => drafts.shown(mount);
  // The token its text was loaded with, kept as the page reads it again (Keep up to date flipped, say), for Save only: a save
  // made from this text is refused once the version, its marks or the entry's text changed since (changelog.saveTranslation).
  // The switch goes from the page's latest read, as it changes nothing typed here.
  const [loaded, setLoaded] = useState(start?.token ?? view.version);
  // Typed and not saved yet (the title, or any edit in the text: Enter, paste and drop fire no input event there): a refused
  // toggle doesn't read the page again over it. A ref, read when the toggle's answer comes (typing goes on meanwhile), and
  // state, for the page's new reads below.
  const dirty = useRef(!!start);
  const [edited, setEdited] = useState(!!start);
  // Edits so far: a save clears the marks only where none came after it was sent (typing goes on while it saves).
  const edits = useRef(start ? 1 : 0);
  const titleField = useRef<HTMLInputElement>(null);
  const editor = useRef<Editor | null>(null);
  // The addresses of media added in this form (and carried in): the page's next read has only its own text's, so the draft
  // carries them, with this read's own (`mediaUrls`: an image in it the next read drops is still in the draft).
  const added = useRef<MediaUrls>(start?.mediaUrls ?? {});
  const markEdited = () => {
    dirty.current = true;
    edits.current += 1;
    setEdited(true);
    // Carried to the form the page's next read mounts, should it come before this is saved.
    if (current()) {
      drafts.put({ title: titleField.current?.value ?? "", content: (editor.current?.getJSON() as Doc | undefined) ?? view.content, token: loaded, mediaUrls: { ...mediaUrls, ...added.current } });
    }
  };
  // The page read again with a new token but the same text (the form is remounted when its text changes: page.tsx keys it by
  // it): a form with nothing typed goes from that read; one with edits keeps its own, so their save is refused rather than
  // marked up to date with a change they never saw.
  const [seen, setSeen] = useState(view.version);
  if (seen !== view.version) {
    setSeen(view.version);
    if (!edited) {
      setLoaded(view.version);
    }
  }
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const sent = edits.current;
    const result = await save(prev, formData);
    if (!result.error) {
      toast.success(formData.get("intent") === "publish" ? "Published" : "Saved");
      // An answer for a form the page has since replaced: the one now shown goes from its own read (or its carried draft).
      if (!current()) {
        return result;
      }
      // Its own save is what the next one goes from, unless a newer read was taken meanwhile (its token, not this answer's).
      const sentToken = String(formData.get("version") ?? "");
      setLoaded((now) => (now === sentToken ? result.version! : now));
      if (edits.current === sent) {
        dirty.current = false;
        setEdited(false);
        drafts.put(null);
      } else {
        // Typed after it was sent: still unsaved, carried on from what it saved (never a later read's token).
        const draft = drafts.take();
        if (draft) drafts.put({ ...draft, token: result.version! });
      }
    }
    return result;
  }, {});
  // The top bar's Save says when it's saving, and waits (ChangelogSaveButton).
  const saving = useContext(ChangelogSavingContext);
  useEffect(() => saving?.setPending(pending), [saving, pending]);
  const line = versionLine(view, defaultName, kind);
  // On the text alone (the labels, line and errors are the app's English): the default language's while the text shown is
  // its, whatever the state (not written, or a first translation on its way or failing).
  const textLang = view.own ? view.code : languages[0]!.code;
  const attention = view.state === "behind" || view.state === "setting" || view.state === "waiting";
  return (
    <form id={VERSION_FORM} {...keepingFields(action)} onInput={(event) => {
        if ((event.target as HTMLElement).getAttribute("role") !== "switch") {
          markEdited();
        }
      }} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
      {/* The version read: a save made from it is refused once it's changed (changelog.saveTranslation). */}
      <input type="hidden" name="version" value={loaded} />
      <div className="flex min-w-0 flex-col gap-4">
        {line && (
          <p className={cn("rounded-md px-3 py-2 text-sm", attention ? "bg-highlight text-highlight-foreground" : "bg-soft")}>
            {line}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <input
            ref={titleField}
            name="title"
            aria-label="Title"
            lang={textLang}
            defaultValue={start?.title ?? view.title}
            required
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "version-error" : undefined}
            className={`${BARE_TITLE} text-2xl`}
          />
          {state.error && <FieldError id="version-error">{state.error}</FieldError>}
        </div>
        <RichEditor bare profile={kind} name="content" label={kind === "article" ? "Text" : "What changed"} lang={textLang} initial={start?.content ?? view.content} editorRef={editor} onChange={markEdited} onMediaUrls={(urls) => (added.current = { ...added.current, ...urls })} uploads={mediaUrls ? { projectSlug, mediaUrls: { ...mediaUrls, ...start?.mediaUrls } } : undefined} />
      </div>
      <aside aria-label="Version settings" className="flex flex-col gap-6 border-t pt-6 text-sm lg:sticky lg:top-0 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
        <KeepUpToDate
          version={view.version}
          // Only where the form's text goes from the read the toggle acted on: text loaded from an older read keeps its
          // token, so its save is still refused.
          onSaved={(actedOn, next) => setLoaded((current) => (current === actedOn ? next : current))}
          dirty={dirty}
          keep={keep}
          kind={kind}
          defaultName={defaultName}
          on={view.keepUpToDate}
          // The team has text in it: its own (written, or an article's draft saved and not published, still "unwritten";
          // with Keep up to date off, text of its own is the team's), which a new translation can replace.
          teamWrote={view.own || view.state === "written" || view.state === "behind" || view.state === "setting"}
        />
        {languages.length > 1 && <ChangelogLanguageList languages={languages} current={view.code} />}
      </aside>
    </form>
  );
}

/**
 * Keep up to date: on, it's translated again (and whenever the default language's text changes); over a version the team
 * wrote (`teamWrote`), only once they confirm, as it replaces their text.
 */
function KeepUpToDate({
  keep,
  kind,
  defaultName,
  on,
  teamWrote,
  version,
  onSaved,
  dirty,
}: {
  keep: VersionActions["keep"];
  kind: VersionKind;
  defaultName: string;
  on: boolean;
  teamWrote: boolean;
  /** The page's latest read of the version (`teamWrote` is that read's too): turning it on over text changed since is refused, not done unconfirmed. */
  version: string;
  /** Done: the read it acted on (`version`) and what the version says now, for the form's next save. */
  onSaved: (actedOn: string, version: string) => void;
  /** The form has edits not saved yet: refused as changed, the page isn't read again over them. */
  dirty: RefObject<boolean>;
}) {
  const [checked, setChecked] = useState(on);
  // What's saved changing (a save turns it off) shows in place: the switch keeps focus, unsaved edits stay.
  const [saved, setSaved] = useState(on);
  if (saved !== on) {
    setSaved(on);
    setChecked(on);
  }
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();
  const [pending, start] = useTransition();
  const save = (next: boolean) => {
    setChecked(next);
    setConfirming(false);
    start(async () => {
      const result = await keep(next, version);
      if (result.changed) {
        setChecked(!next);
        if (dirty.current) {
          // Reading the page again would put its text in place of theirs.
          toast.error("It changed meanwhile. Copy your edits, then reload.");
        } else {
          router.refresh();
          toast.error("It changed meanwhile: shown as it is now. Try again.");
        }
      } else if (result.error) {
        setChecked(!next);
        toast.error(result.error);
      } else {
        onSaved(version, result.version!);
      }
    });
  };
  return (
    <>
      {/* Under its group label, as the entry editor's sidebar groups are (docs/design.md): no hint sentence. */}
      <section aria-labelledby="version-translation" className="flex flex-col gap-2">
      <h2 id="version-translation" className="group-label">
        Translation
      </h2>
      <label className="flex items-center justify-between gap-3">
        <span className="font-medium">Keep up to date</span>
        {/* Not `disabled` while it saves (focus would leave it): changes are ignored meanwhile. */}
        <Switch
          checked={checked}
          aria-disabled={pending || undefined}
          onChange={(event) => {
            if (pending) {
              return;
            }
            const next = event.currentTarget.checked;
            if (next && teamWrote) {
              setConfirming(true);
            } else {
              save(next);
            }
          }}
        />
      </label>
      </section>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Translate it again?</AlertDialogTitle>
            <AlertDialogDescription>
              {kind === "article" ? `Sections ${defaultName} changed in since your edits take a new translation.` : "A new translation replaces your text in this version."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={() => save(true)}>Translate again</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The top bar's Save for a version (its form is below it). */
export const ChangelogVersionSave = () => <ChangelogSaveButton form={VERSION_FORM} primary />;

/** An article version's Save draft and Publish in the top bar: both submit its form, Publish saving the draft first. */
export function ArticleVersionSave() {
  const saving = useContext(ChangelogSavingContext);
  return (
    <>
      <ChangelogSaveButton form={VERSION_FORM} isNew primary={false} />
      <Button type="submit" form={VERSION_FORM} name="intent" value="publish" disabled={saving?.pending} focusableWhenDisabled>
        Publish
      </Button>
    </>
  );
}
