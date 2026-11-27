"use client";

import { cn } from "cn";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { type GlossaryTermInput, saveGlossary } from "@/server/glossary";

type Language = { code: string; native: string };
type Row = GlossaryTermInput & { key: string };

/** Languages side by side up to this many; with more, each term is a card (as on phones), its languages under it. */
const MAX_COLUMNS = 3;

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count.toLocaleString("en")} ${many}`);

/**
 * Settings → Languages → Glossary (docs/plan.md, Languages, L12): a row per term, its word in each language ("Model decides"
 * when empty) or Never translated; on phones (and with many languages) a card per term. Saving asks first when pages use a
 * term that changed: how many are translated again, and how many the team writes get sections to update.
 */
export function GlossarySettings({ projectSlug, languages, terms }: { projectSlug: string; languages: Language[]; terms: GlossaryTermInput[] }) {
  const id = useId();
  const keyed = (list: GlossaryTermInput[]) => list.map((term, i) => ({ ...term, key: `${id}-${i}` }));
  const [rows, setRows] = useState<Row[]>(() => keyed(terms));
  const [saved, setSaved] = useState(JSON.stringify(terms));
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<{ retranslating: number; behind: number } | null>(null);
  const added = useRef(0);
  // The term just added: its field takes focus as it appears.
  const [fresh, setFresh] = useState<string | null>(null);
  // One removed: its Remove button goes with it, so focus goes to the next term's field (else the one before, else Add term).
  const focusAfterRemove = useRef<string | null>(null);
  useEffect(() => {
    if (focusAfterRemove.current) {
      document.getElementById(focusAfterRemove.current)?.focus();
      focusAfterRemove.current = null;
    }
  }, [rows]);
  const addId = `${id}-add`;
  // What's saved: terms written, translations only where one is, none on a kept term.
  const toSave = (): GlossaryTermInput[] =>
    rows
      .filter((row) => row.term.trim())
      .map(({ term, keep, translations }) => ({
        term: term.trim(),
        keep,
        translations: keep ? {} : Object.fromEntries(Object.entries(translations).filter(([, word]) => word.trim()).map(([code, word]) => [code, word.trim()])),
      }));
  const dirty = JSON.stringify(toSave()) !== saved;
  // Side by side with one to MAX_COLUMNS languages (with none there are no columns to line up).
  const columns = languages.length > 0 && languages.length <= MAX_COLUMNS;
  const update = (key: string, change: Partial<GlossaryTermInput>) => setRows((list) => list.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const add = () => {
    const key = `${id}-new-${added.current++}`;
    setRows((list) => [...list, { key, term: "", keep: false, translations: {} }]);
    setFresh(key);
  };
  const commit = () =>
    startTransition(async () => {
      const terms = toSave();
      const result = await saveGlossary(projectSlug, terms);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setConfirm(null);
      setSaved(JSON.stringify(terms));
      toast.success("Saved the glossary");
    });
  const save = () =>
    startTransition(async () => {
      // What saving would change first: pages that use a changed term are worth asking about (docs/plan.md, "Nothing large without asking").
      const preview = await saveGlossary(projectSlug, toSave(), true);
      if (preview.error) {
        toast.error(preview.error);
        return;
      }
      if ((preview.retranslating ?? 0) + (preview.behind ?? 0) > 0) {
        setConfirm({ retranslating: preview.retranslating ?? 0, behind: preview.behind ?? 0 });
        return;
      }
      commit();
    });
  return (
    <SettingsPane
      title="Glossary"
      description="Words kept as they are, or always translated one way."
      back={{ href: `/app/${projectSlug}/settings/languages`, label: "Languages" }}
      actions={
        <Button disabled={!dirty || pending} focusableWhenDisabled onClick={save}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      }
    >
      <SettingsCard
        title="Terms"
        count={rows.filter((row) => row.term.trim()).length}
        action={
          <Button id={addId} variant="outline" size="sm" onClick={add}>
            <PlusIcon aria-hidden /> Add term
          </Button>
        }
      >
        {rows.length === 0 ? (
          <SettingBlock>
            <p className="text-sm text-muted-foreground">No terms yet. Add your product&apos;s name, or a word your translations should always use.</p>
          </SettingBlock>
        ) : (
          <>
            {columns && (
              // The columns' names, beside each other on wide screens (each field says its own to screen readers).
              <div
                aria-hidden
                style={{ "--languages": languages.length } as React.CSSProperties}
                className="hidden gap-3 px-5 pt-3 pb-1 text-sm font-medium text-muted-foreground @min-[40rem]/settings:grid @min-[40rem]/settings:grid-cols-[minmax(8rem,1.2fr)_repeat(var(--languages),minmax(6rem,1fr))_auto_auto]"
              >
                <span>Term</span>
                {languages.map((language) => (
                  <span key={language.code} lang={language.code}>
                    {language.native}
                  </span>
                ))}
                <span>Never translated</span>
                <span className="w-8" />
              </div>
            )}
            <ul aria-label="Terms" className="flex flex-col divide-y">
              {rows.map((row) => (
                <TermRow
                  key={row.key}
                  row={row}
                  languages={languages}
                  columns={columns}
                  fresh={row.key === fresh}
                  onChange={(change) => update(row.key, change)}
                  onRemove={() => {
                    const at = rows.indexOf(row);
                    const next = rows[at + 1] ?? rows[at - 1];
                    focusAfterRemove.current = next ? `${next.key}-term` : addId;
                    setRows((list) => list.filter((other) => other.key !== row.key));
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </SettingsCard>
      <p className="-mt-4 text-sm text-muted-foreground">Changing a term retranslates the sections that use it.</p>
      <AlertDialog open={confirm !== null} onOpenChange={(next) => !next && !pending && setConfirm(null)}>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle>Save the glossary?</AlertDialogTitle>
            <AlertDialogDescription>Pages that use a term you changed are updated.</AlertDialogDescription>
          </AlertDialogHeader>
          {confirm && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {confirm.retranslating > 0 && (
                <>
                  <dt className="text-muted-foreground">Translated again</dt>
                  <dd>{plural(confirm.retranslating, "page", "pages")}</dd>
                </>
              )}
              {confirm.behind > 0 && (
                <>
                  <dt className="text-muted-foreground">To update</dt>
                  <dd>{plural(confirm.behind, "page your team writes", "pages your team writes")}</dd>
                </>
              )}
            </dl>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button disabled={pending} focusableWhenDisabled onClick={commit}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPane>
  );
}

/** A term: its word, its word in each language (or Never translated), and Remove. A row on wide screens, a card on phones. */
function TermRow({
  row,
  languages,
  columns,
  fresh,
  onChange,
  onRemove,
}: {
  row: Row;
  languages: Language[];
  columns: boolean;
  fresh: boolean;
  onChange: (change: Partial<GlossaryTermInput>) => void;
  onRemove: () => void;
}) {
  const name = row.term.trim() || "this term";
  // Each field's own name: shown above it in a card, the column's on wide screens (only for screen readers there).
  const fieldLabel = cn("text-sm font-medium", columns && "@min-[40rem]/settings:sr-only");
  return (
    <li
      style={{ "--languages": languages.length } as React.CSSProperties}
      className={cn(
        "grid grid-cols-2 items-end gap-x-3 gap-y-3 px-4 py-3.5 @min-[34rem]/settings:px-5",
        columns && "@min-[40rem]/settings:grid-cols-[minmax(8rem,1.2fr)_repeat(var(--languages),minmax(6rem,1fr))_auto_auto] @min-[40rem]/settings:items-center @min-[40rem]/settings:py-2.5",
      )}
    >
      <div className={cn("col-span-2 flex flex-col gap-1.5", columns && "@min-[40rem]/settings:col-span-1")}>
        <label htmlFor={`${row.key}-term`} className={fieldLabel}>
          Term
        </label>
        <Input
          id={`${row.key}-term`}
          value={row.term}
          maxLength={100}
          placeholder="Board"
          // The term the team just asked to add.
          autoFocus={fresh}
          onChange={(event) => onChange({ term: event.target.value })}
        />
      </div>
      {row.keep ? (
        // In the table, across the languages' columns (a card says it by its switch).
        columns && <p className="hidden self-center text-sm text-muted-foreground @min-[40rem]/settings:col-[span_var(--languages)] @min-[40rem]/settings:block">Never translated</p>
      ) : (
        languages.map((language) => (
          <div key={language.code} className={cn("flex flex-col gap-1.5", languages.length === 1 && "col-span-2", columns && "@min-[40rem]/settings:col-span-1")}>
            <label htmlFor={`${row.key}-${language.code}`} lang={language.code} className={fieldLabel}>
              {language.native}
            </label>
            <Input
              id={`${row.key}-${language.code}`}
              value={row.translations[language.code] ?? ""}
              maxLength={100}
              placeholder="Model decides"
              aria-label={`${name} in ${language.native}`}
              onChange={(event) => onChange({ translations: { ...row.translations, [language.code]: event.target.value } })}
            />
          </div>
        ))
      )}
      <label className={cn("flex items-center gap-2 text-sm", columns && "@min-[40rem]/settings:justify-center")}>
        {/* Its name says the words shown ("Never translated") and whose they are. */}
        <Switch checked={row.keep} onChange={(event) => onChange({ keep: event.target.checked })} aria-label={`Never translated: ${name}`} />
        <span className={cn(columns && "@min-[40rem]/settings:sr-only")}>Never translated</span>
      </label>
      <Button variant="ghost" size="icon-sm" className="justify-self-end" aria-label={`Remove ${name}`} onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </li>
  );
}
