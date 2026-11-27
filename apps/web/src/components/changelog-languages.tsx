"use client";

import type { Doc, MediaUrls } from "@tuti/content";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useActionState, useContext, useEffect, useState, useTransition } from "react";
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
import { keepChangelogVersionUpToDate, saveChangelogVersion } from "@/server/changelog";
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
  /** Its text; the default language's while it isn't written, to write over. */
  content: Doc;
};

/** The one line over a version's text: where it stands, and what saving does. */
function versionLine(view: VersionView, defaultName: string) {
  switch (view.state) {
    case "current":
      return `Translated automatically from ${defaultName}. Saving your edits turns off Keep up to date.`;
    case "translating":
      return `Translating from ${defaultName}…`;
    case "waiting":
      return `Can't translate it yet: ${view.waiting}.`;
    case "behind":
      return `${defaultName} changed since this was saved.`;
    case "setting":
      return `"Our product is available in ${view.name}" changed since this was saved.`;
    case "unwritten":
      return `Not written yet: it starts as the ${defaultName} text.`;
    default:
      return null;
  }
}

export function ChangelogVersionForm({
  projectSlug,
  number,
  defaultName,
  view,
  mediaUrls,
  languages,
}: {
  projectSlug: string;
  number: number;
  defaultName: string;
  view: VersionView;
  mediaUrls: MediaUrls | null;
  /** The sidebar's Languages. */
  languages: EntryLanguage[];
}) {
  // The token its text was loaded with, kept as the page reads it again (Keep up to date flipped, say), for Save only: a save
  // made from this text is refused once the version, its marks or the entry's text changed since (changelog.saveTranslation).
  // The switch goes from the page's latest read, as it changes nothing typed here.
  const [loaded, setLoaded] = useState(view.version);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveChangelogVersion(projectSlug, number, view.code, prev, formData);
    if (!result.error) {
      // Its own save is what the next one goes from.
      setLoaded(result.version!);
      toast.success("Saved");
    }
    return result;
  }, {});
  // The top bar's Save says when it's saving, and waits (ChangelogSaveButton).
  const saving = useContext(ChangelogSavingContext);
  useEffect(() => saving?.setPending(pending), [saving, pending]);
  const line = versionLine(view, defaultName);
  const attention = view.state === "behind" || view.state === "setting" || view.state === "waiting";
  return (
    <form id={VERSION_FORM} {...keepingFields(action)} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
      {/* The version read: a save made from it is refused once it's changed (changelog.saveTranslation). */}
      <input type="hidden" name="version" value={loaded} />
      <div lang={view.code} className="flex min-w-0 flex-col gap-4">
        {line && (
          <p className={cn("rounded-md px-3 py-2 text-sm", attention ? "bg-highlight text-highlight-foreground" : "bg-soft")} lang="en">
            {line}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <input
            name="title"
            aria-label="Title"
            defaultValue={view.title}
            required
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "version-error" : undefined}
            className={`${BARE_TITLE} text-2xl`}
          />
          {state.error && <FieldError id="version-error">{state.error}</FieldError>}
        </div>
        <RichEditor bare profile="changelog" name="content" label="What changed" initial={view.content} uploads={mediaUrls ? { projectSlug, mediaUrls } : undefined} />
      </div>
      <aside aria-label="Version settings" className="flex flex-col gap-6 border-t pt-6 text-sm lg:sticky lg:top-0 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
        <KeepUpToDate
          version={view.version}
          projectSlug={projectSlug}
          number={number}
          code={view.code}
          on={view.keepUpToDate}
          defaultName={defaultName}
          teamWrote={view.state === "written" || view.state === "behind" || view.state === "setting"}
        />
        <ChangelogLanguageList languages={languages} current={view.code} />
      </aside>
    </form>
  );
}

/**
 * Keep up to date: on, it's translated again (and whenever the default language's text changes); over a version the team
 * wrote (`teamWrote`), only once they confirm, as it replaces their text.
 */
function KeepUpToDate({
  projectSlug,
  number,
  code,
  on,
  defaultName,
  teamWrote,
  version,
}: {
  projectSlug: string;
  number: number;
  code: string;
  on: boolean;
  defaultName: string;
  teamWrote: boolean;
  /** The page's latest read of the version (`teamWrote` is that read's too): turning it on over text changed since is refused, not done unconfirmed. */
  version: string;
}) {
  const [checked, setChecked] = useState(on);
  // What's saved changing (a save turns it off) shows in place: the switch keeps focus, unsaved edits stay.
  const [saved, setSaved] = useState(on);
  if (saved !== on) {
    setSaved(on);
    setChecked(on);
  }
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const save = (next: boolean) => {
    setChecked(next);
    setConfirming(false);
    start(async () => {
      const result = await keepChangelogVersionUpToDate(projectSlug, number, code, next, version);
      if (result.error) {
        setChecked(!next);
        toast.error(result.error);
      }
    });
  };
  return (
    <>
      <label className="flex items-start justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Keep up to date</span>
          <span className="text-xs text-muted-foreground">Translated again whenever {defaultName} changes.</span>
        </span>
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
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Translate it again?</AlertDialogTitle>
            <AlertDialogDescription>A new translation replaces your text in this version.</AlertDialogDescription>
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
