"use client";

import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
import { addLanguage, type LanguageChanges, removeLanguage, setDefaultLanguage, updateLanguage } from "@/server/languages";

type Offered = { code: string; name: string; native: string };
type Language = { code: string; name: string; newPages: "automatic" | "manual"; instructions: string; productAvailable: boolean; live: boolean };

const MAX_INSTRUCTIONS = 2000;
const ADD = "add-language";

/** "Deutsch (German)": its own name, and the one the team reads where they differ. */
const label = ({ name, native }: Offered) => (name === native ? name : `${native} (${name})`);

/**
 * Settings → Languages (docs/plan.md, Languages): the default language, then the others, each with its code, mode, Live
 * or Offline and a ⋯ menu. Before article translations (L6) nothing is translated yet, so a row says only its mode, and
 * there's no Retranslate or Try again.
 */
export function LanguageSettings({
  projectSlug,
  defaultLanguage,
  languages,
  offered,
  pages,
  upgrade,
}: {
  projectSlug: string;
  defaultLanguage: string;
  languages: Language[];
  offered: Offered[];
  /** Published articles: what a new language has to translate. */
  pages: number;
  /** The plan has no room for another language: Add language opens this. */
  upgrade: UpgradePrompt | null;
}) {
  const byCode = (code: string) => offered.find((language) => language.code === code)!;
  const addable = offered.filter(({ code }) => code !== defaultLanguage && !languages.some((language) => language.code === code));
  // One removed: its ⋯ menu, which had focus, is gone. Focus goes to Add language, only where it was lost.
  const count = useRef(languages.length);
  useEffect(() => {
    if (languages.length < count.current && document.activeElement === document.body) {
      document.getElementById(ADD)?.focus();
    }
    count.current = languages.length;
  }, [languages.length]);
  return (
    <>
      <SettingsCard>
        <DefaultLanguage projectSlug={projectSlug} value={defaultLanguage} offered={offered} locked={languages.length > 0} />
      </SettingsCard>
      <SettingsCard
        title="Other languages"
        action={addable.length > 0 && <AddLanguage projectSlug={projectSlug} defaultName={byCode(defaultLanguage).native} addable={addable} pages={pages} upgrade={upgrade} />}
      >
        {languages.length === 0 ? (
          <SettingBlock>
            <p className="text-sm text-muted-foreground">Only {byCode(defaultLanguage).native} so far. Add a language to offer your portal, help center and changelog in it too.</p>
          </SettingBlock>
        ) : (
          <ul aria-label="Other languages" className="flex flex-col divide-y">
            {languages.map((language) => (
              <LanguageRow key={language.code} projectSlug={projectSlug} language={language} native={byCode(language.code).native} />
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}

function DefaultLanguage({ projectSlug, value, offered, locked }: { projectSlug: string; value: string; offered: Offered[]; locked: boolean }) {
  const [pending, startTransition] = useTransition();
  const items = Object.fromEntries(offered.map((language) => [language.code, label(language)]));
  return (
    <SettingRow
      label="Default language"
      description={locked ? "What your team writes in. Remove the other languages first to change it." : "What your team writes in. Its pages keep their addresses."}
      htmlFor="default-language"
    >
      <Select
        items={items}
        value={value}
        disabled={pending || locked}
        onValueChange={(code) =>
          startTransition(async () => {
            const result = await setDefaultLanguage(projectSlug, String(code));
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success(`Default language: ${items[String(code)]}`);
            }
          })
        }
      >
        <SelectTrigger id="default-language" aria-describedby="default-language-description" className="w-full @min-[34rem]/settings:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {offered.map((language) => (
            <SelectItem key={language.code} value={language.code}>
              {label(language)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

/** "+ Add language": a dialog to pick one, saying what adding it means first; past the plan's limit, the upgrade prompt. */
function AddLanguage({ projectSlug, defaultName, addable, pages, upgrade }: { projectSlug: string; defaultName: string; addable: Offered[]; pages: number; upgrade: UpgradePrompt | null }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const planId = useId();
  const picked = addable.find((language) => language.code === code);
  const items = Object.fromEntries(addable.map((language) => [language.code, label(language)]));
  return (
    <>
      <Button
        id={ADD}
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        aria-describedby={upgrade ? planId : undefined}
        onClick={() => {
          setCode(null);
          setOpen(true);
        }}
      >
        <PlusIcon aria-hidden /> Add language
      </Button>
      {upgrade ? (
        <>
          <span id={planId} hidden>
            {upgrade.title}
          </span>
          <UpgradeDialog prompt={upgrade} open={open} onOpenChange={setOpen} />
        </>
      ) : (
        <Dialog open={open} onOpenChange={(next) => (next || !pending) && setOpen(next)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a language</DialogTitle>
              <DialogDescription>It&apos;s added offline: only your team sees it until you make it live.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <label htmlFor="add-language-code" className="text-sm font-medium">
                Language
              </label>
              <Select items={items} value={code} onValueChange={(value) => setCode(value === null ? null : String(value))}>
                <SelectTrigger id="add-language-code" className="w-full">
                  <SelectValue placeholder="Pick a language" />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((language) => (
                    <SelectItem key={language.code} value={language.code}>
                      {label(language)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* What it takes on (docs/plan.md, "Nothing large without asking"). The cost comes with translating (L6). */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Pages</dt>
              <dd>
                {pages === 1 ? "1 published page" : `${pages.toLocaleString("en")} published pages`}, shown in {defaultName} until they&apos;re translated
              </dd>
              <dt className="text-muted-foreground">New pages</dt>
              <dd>Automatic. You can change it in the language&apos;s ⋯ menu.</dd>
            </dl>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
              <Button
                disabled={!picked || pending}
                focusableWhenDisabled
                onClick={() =>
                  picked &&
                  startTransition(async () => {
                    const result = await addLanguage(projectSlug, picked.code);
                    if (result.error) {
                      toast.error(result.error);
                      return;
                    }
                    setOpen(false);
                    toast.success(`Added ${picked.native}`);
                  })
                }
              >
                {pending ? "Adding…" : picked ? `Add ${picked.native}` : "Add language"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** A language: its code, names and mode, Live or Offline, and its ⋯ menu. */
function LanguageRow({ projectSlug, language, native }: { projectSlug: string; language: Language; native: string }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const save = (changes: LanguageChanges, done: string) =>
    startTransition(async () => {
      const result = await updateLanguage(projectSlug, language.code, changes);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(done);
      }
    });
  return (
    <li className="flex items-center gap-3 px-4 py-3 @min-[34rem]/settings:px-5">
      <span aria-hidden className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md bg-muted px-1.5 font-mono text-xs font-semibold uppercase">
        {language.code}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span lang={language.code} className="font-medium">
          {native}
        </span>
        <span className="text-sm text-muted-foreground">
          {language.name !== native && <>{language.name} · </>}
          {language.newPages === "automatic" ? "Automatic" : "Manual"}
        </span>
      </div>
      <Badge variant={language.live ? "soft" : "outline"} className={language.live ? undefined : "text-muted-foreground"}>
        {language.live ? "Live" : "Offline"}
      </Badge>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} focusableWhenDisabled aria-label={`Actions for ${language.name}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          <DropdownMenuItem onClick={() => save({ live: !language.live }, language.live ? `${native} is offline` : `${native} is live`)}>
            {language.live ? "Take offline" : "Go live"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>New pages</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={language.newPages}
              onValueChange={(value) => value !== language.newPages && save({ newPages: value as Language["newPages"] }, `New pages in ${native}: ${value === "automatic" ? "Automatic" : "Manual"}`)}
            >
              <DropdownMenuRadioItem value="automatic" closeOnClick>Automatic</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="manual" closeOnClick>Manual</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setEditing(true)}>Instructions…</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <InstructionsDialog projectSlug={projectSlug} language={language} native={native} open={editing} onOpenChange={setEditing} />
      <AlertDialog open={removing} onOpenChange={(next) => (next || !pending) && setRemoving(next)}>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {native}?</AlertDialogTitle>
            <AlertDialogDescription>Your portal will no longer be offered in {native}, and its instructions are deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              focusableWhenDisabled
              onClick={() =>
                startTransition(async () => {
                  const result = await removeLanguage(projectSlug, language.code);
                  if (result.error) {
                    toast.error(result.error);
                    return;
                  }
                  setRemoving(false);
                  toast.success(`Removed ${native}`);
                })
              }
            >
              Remove {native}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** A language's instructions for translating into it, and "Our product is available in …". */
function InstructionsDialog({
  projectSlug,
  language,
  native,
  open,
  onOpenChange,
}: {
  projectSlug: string;
  language: Language;
  native: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const id = `language-${language.code}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !pending) {
          setError(null);
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
              const result = await updateLanguage(projectSlug, language.code, {
                instructions: String(form.get("instructions") ?? ""),
                productAvailable: form.get("productAvailable") === "on",
              });
              if (result.error) {
                setError(result.error);
                return;
              }
              onOpenChange(false);
              toast.success(`Saved ${native}'s instructions`);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Translating into {native}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-instructions`} className="text-sm font-medium">
              Instructions
            </label>
            <Textarea
              id={`${id}-instructions`}
              name="instructions"
              defaultValue={language.instructions}
              maxLength={MAX_INSTRUCTIONS}
              placeholder="Use du, not Sie."
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              className="min-h-24"
            />
          </div>
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <label htmlFor={`${id}-product`} className="text-sm font-medium">
                Our product is available in {native}
              </label>
              <p id={`${id}-product-description`} className="text-sm text-muted-foreground">
                Off: names of buttons and screens stay as written. On: they&apos;re translated.
              </p>
            </div>
            <Switch id={`${id}-product`} name="productAvailable" defaultChecked={language.productAvailable} aria-describedby={`${id}-product-description`} />
          </div>
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
