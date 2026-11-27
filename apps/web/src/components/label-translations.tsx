"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingsCard } from "@/components/settings-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { saveCollectionTranslation } from "@/server/label-translations";

export type LabelTranslationRow = { language: string; native: string; name: string | null; description: string | null; keepUpToDate: boolean };

/**
 * A collection's settings → Translations (docs/plan.md, Languages, L13): a row per language with its name and description
 * there, Automatic or Edited, and Edit; not translated yet, "readers see the <default> name" and Add.
 */
export function CollectionTranslations({
  projectSlug,
  slug,
  defaultName,
  translations,
  ai,
}: {
  projectSlug: string;
  slug: string;
  /** The default language's own name ("English"). */
  defaultName: string;
  translations: LabelTranslationRow[];
  /** AI is on on this server: Keep up to date is offered. */
  ai: boolean;
}) {
  return (
    <SettingsCard title="Translations">
      <ul aria-label="Translations" className="flex flex-col divide-y">
        {translations.map((row) => (
          <TranslationRow key={row.language} projectSlug={projectSlug} slug={slug} defaultName={defaultName} row={row} ai={ai} />
        ))}
      </ul>
    </SettingsCard>
  );
}

function TranslationRow({ projectSlug, slug, defaultName, row, ai }: { projectSlug: string; slug: string; defaultName: string; row: LabelTranslationRow; ai: boolean }) {
  const [open, setOpen] = useState(false);
  const translated = row.name !== null;
  return (
    <li className="flex items-center gap-3 px-4 py-3 @min-[34rem]/settings:px-5">
      <span aria-hidden className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md bg-muted px-1.5 font-mono text-xs font-semibold uppercase">
        {row.language}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        {translated ? (
          <>
            <span lang={row.language} className="font-medium break-words">
              {row.name}
            </span>
            {row.description && (
              <span lang={row.language} className="text-sm break-words text-muted-foreground">
                {row.description}
              </span>
            )}
            {/* Under it on a narrow card (a phone), beside the button on a wide one. */}
            <Badge variant={row.keepUpToDate ? "soft" : "outline"} className="mt-1 self-start @min-[28rem]/settings:hidden">
              {row.keepUpToDate ? "Automatic" : "Edited"}
            </Badge>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{row.keepUpToDate ? `Being translated: readers see the ${defaultName} name` : `Not translated: readers see the ${defaultName} name`}</span>
        )}
      </div>
      {translated && (
        <Badge variant={row.keepUpToDate ? "soft" : "outline"} className="hidden @min-[28rem]/settings:inline-flex">
          {row.keepUpToDate ? "Automatic" : "Edited"}
        </Badge>
      )}
      <Button variant="outline" size="sm" aria-label={`${translated ? "Edit" : "Add"} ${row.native}`} onClick={() => setOpen(true)}>
        {translated ? "Edit" : "Add"}
      </Button>
      <TranslationDialog projectSlug={projectSlug} slug={slug} row={row} ai={ai} open={open} onOpenChange={setOpen} />
    </li>
  );
}

/** A language's name and description, the team's own or kept up to date (typing turns that off, as on an article's version). */
function TranslationDialog({
  projectSlug,
  slug,
  row,
  ai,
  open,
  onOpenChange,
}: {
  projectSlug: string;
  slug: string;
  row: LabelTranslationRow;
  ai: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [keep, setKeep] = useState(row.keepUpToDate && ai);
  // Opened again: from the row as it is now (saved elsewhere meanwhile, another tab's save), not as it was last time.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setKeep(row.keepUpToDate && ai);
      setError(null);
    }
  }
  const id = `translation-${row.language}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !pending) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            startTransition(async () => {
              const result = await saveCollectionTranslation(projectSlug, slug, row.language, {
                keepUpToDate: keep,
                name: String(form.get("name") ?? ""),
                description: String(form.get("description") ?? ""),
              });
              if (result.error) {
                setError(result.error);
                return;
              }
              onOpenChange(false);
              toast.success(`Saved the ${row.native} name`);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>In {row.native}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              Name
            </label>
            <Input
              id={`${id}-name`}
              name="name"
              lang={row.language}
              defaultValue={row.name ?? ""}
              maxLength={60}
              required={!keep}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={() => setKeep(false)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-description`} className="text-sm font-medium">
              Description
            </label>
            <Textarea id={`${id}-description`} name="description" lang={row.language} defaultValue={row.description ?? ""} maxLength={300} className="min-h-16" onChange={() => setKeep(false)} />
          </div>
          {ai && (
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <label htmlFor={`${id}-keep`} className="text-sm font-medium">
                  Keep up to date
                </label>
                <p id={`${id}-keep-description`} className="text-sm text-muted-foreground">
                  AI translates it again when it changes. Editing turns this off.
                </p>
              </div>
              <Switch id={`${id}-keep`} checked={keep} onChange={(event) => setKeep(event.target.checked)} aria-describedby={`${id}-keep-description`} />
            </div>
          )}
          {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending} focusableWhenDisabled>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
