"use client";

import { cn } from "cn";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { usePreview } from "@/components/customize-shell";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { enterSaves } from "@/lib/forms";
import { glossaryKey, mergeMeanwhile, type MergeRow } from "@/lib/glossary-merge";
import { type GlossarySaved, type GlossaryTermInput, saveGlossary } from "@/server/glossary";

type Language = { code: string; native: string };
type Row = MergeRow;

/** Languages side by side up to this many; with more, each term is a card (as on phones), its languages under it. */
const MAX_COLUMNS = 3;
/**
 * The table's columns on wide screens (the headings' and each term's, so they line up): term, a column per language, Never
 * translated, Remove. From a 44rem card: three languages' minimums, gaps and padding come to 41.75rem.
 */
const COLUMNS = "@min-[44rem]/settings:grid-cols-[minmax(8rem,1.2fr)_repeat(var(--languages),minmax(6rem,1fr))_7.5rem_2rem]";

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count.toLocaleString("en")} ${many}`);

/**
 * Settings → Languages → Glossary (docs/plan.md, Languages, L12): a row per term, its word in each language ("Model decides"
 * when empty) or Never translated; on phones (and with many languages, or none) a card per term. Saving asks first when pages
 * use a term that changed: how many are translated again, and how many the team writes get sections to update.
 */
export function GlossarySettings(props: { projectSlug: string; languages: Language[]; terms: GlossaryTermInput[]; hash: string }) {
  return (
    <SettingsPane title="Glossary" description="Words kept as they are, or always translated one way." back={{ href: `/app/${props.projectSlug}/settings/languages`, label: "Languages" }}>
      <GlossaryEditor {...props} />
    </SettingsPane>
  );
}

/**
 * The terms, as a form of the pane's: its "Save changes" (or Enter in a field) submits it, and leaving with changes not saved
 * asks first, as on every settings page. With nothing typed it follows fresh server data (a teammate's save); with edits, a
 * save over a glossary saved since is refused (its hash), the edits kept.
 */
function GlossaryEditor({ projectSlug, languages, terms, hash }: { projectSlug: string; languages: Language[]; terms: GlossaryTermInput[]; hash: string }) {
  const id = useId();
  const formId = `${id}-form`;
  const addId = `${id}-add`;
  const keyed = (list: GlossaryTermInput[]) => list.map((term, i) => ({ ...term, key: `${id}-${i}` }));
  const [rows, setRows] = useState<Row[]>(() => keyed(terms));
  const [saved, setSaved] = useState(glossaryKey(terms));
  // The version the edits started from, sent with each save; and the latest the server sent, followed once nothing's typed.
  const [base, setBase] = useState(hash);
  const [latest, setLatest] = useState({ hash, terms });
  const [sent, setSent] = useState(hash);
  if (hash !== sent) {
    setSent(hash);
    setLatest({ hash, terms });
  }
  const [pending, startTransition] = useTransition();
  // The dialog's counts, and the terms they're for: what Save took when it was pressed (edits after it aren't in it, and stay unsaved).
  const [confirm, setConfirm] = useState<{ retranslating: number; behind: number; terms: GlossaryTermInput[] } | null>(null);
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
  // What's saved: terms written, translations only where one is, none on a kept term. A row left empty is dropped.
  const toSave = (): GlossaryTermInput[] =>
    rows
      .filter((row) => row.term.trim())
      .map(({ term, keep, translations }) => ({
        term: term.trim(),
        keep,
        translations: keep ? {} : Object.fromEntries(Object.entries(translations).filter(([, word]) => word.trim()).map(([code, word]) => [code, word.trim()])),
      }));
  // A row with words (or Never translated) but no term: never dropped quietly, it's for the team to name or remove.
  const unnamed = rows.find((row) => !row.term.trim() && (row.keep || Object.values(row.translations).some((word) => word.trim())));
  const dirty = glossaryKey(toSave()) !== saved || !!unnamed;
  if (!dirty && latest.hash !== base) {
    setRows(keyed(latest.terms));
    setSaved(glossaryKey(latest.terms));
    setBase(latest.hash);
  }
  const { register } = usePreview();
  useEffect(() => register(formId, { dirty, pending, saving: pending }), [register, formId, dirty, pending]);
  useEffect(() => () => register(formId, null), [register, formId]);
  const columns = languages.length > 0 && languages.length <= MAX_COLUMNS;
  const update = (key: string, change: Partial<GlossaryTermInput>) => setRows((list) => list.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const add = () => {
    const key = `${id}-new-${added.current++}`;
    setRows((list) => [...list, { key, term: "", keep: false, translations: {} }]);
    setFresh(key);
  };
  // Refused: a teammate's save meanwhile is merged into the rows, marked, and the next Save goes on top of it; else its error.
  const refused = (result: GlossarySaved) => {
    if (!result.latest) {
      toast.error(result.error);
      return;
    }
    const { terms: theirs, hash: now } = result.latest;
    setRows((list) => mergeMeanwhile(list, JSON.parse(saved) as GlossaryTermInput[], theirs, () => `${id}-new-${added.current++}`));
    setSaved(glossaryKey(theirs));
    setBase(now);
    setLatest({ hash: now, terms: theirs });
    toast.error("Changed meanwhile: check the marked terms, then save");
  };
  const commit = (terms: GlossaryTermInput[]) =>
    startTransition(async () => {
      const result = await saveGlossary(projectSlug, terms, base);
      setConfirm(null);
      if (result.error) {
        refused(result);
        return;
      }
      setSaved(glossaryKey(terms));
      setBase(result.hash!);
      setLatest({ hash: result.hash!, terms });
      setRows((list) => list.map((row) => ({ ...row, meanwhile: undefined, theirs: undefined })));
      toast.success("Saved the glossary");
    });
  const save = () => {
    if (unnamed) {
      toast.error("Write the term first");
      document.getElementById(`${unnamed.key}-term`)?.focus();
      return;
    }
    // The terms as they are now: what the dialog describes, and what's saved (never edits made while it works it out).
    const terms = toSave();
    startTransition(async () => {
      // What saving would change first: pages that use a changed term are worth asking about (docs/plan.md, "Nothing large without asking").
      const preview = await saveGlossary(projectSlug, terms, base, true);
      if (preview.error) {
        refused(preview);
        return;
      }
      if ((preview.retranslating ?? 0) + (preview.behind ?? 0) > 0) {
        setConfirm({ retranslating: preview.retranslating ?? 0, behind: preview.behind ?? 0, terms });
        return;
      }
      commit(terms);
    });
  };
  return (
    <form
      id={formId}
      className="flex flex-col gap-7"
      // Enter in a field saves, as "Save changes" would (a form with several fields and no button of its own doesn't by itself).
      onKeyDown={(event) => {
        const field = event.target instanceof HTMLElement ? { tagName: event.target.tagName, type: event.target.getAttribute("type") ?? (event.target as HTMLInputElement).type } : null;
        if (!dirty || pending || !enterSaves({ key: event.key, defaultPrevented: event.defaultPrevented, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode }, field)) {
          return;
        }
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !pending) save();
      }}
    >
      <SettingsCard
        title="Terms"
        count={rows.filter((row) => row.term.trim()).length}
        action={
          <Button id={addId} type="button" variant="outline" size="sm" onClick={add}>
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
              <div aria-hidden style={{ "--languages": languages.length } as React.CSSProperties} className={cn("hidden gap-3 px-5 pt-3 pb-1 text-sm font-medium text-muted-foreground @min-[44rem]/settings:grid", COLUMNS)}>
                <span>Term</span>
                {languages.map((language) => (
                  <span key={language.code} lang={language.code}>
                    {language.native}
                  </span>
                ))}
                <span className="text-center">Never translated</span>
                <span />
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
      <p className="-mt-4 text-sm text-muted-foreground">Changing a term updates the pages that use it.</p>
      <AlertDialog open={confirm !== null} onOpenChange={(next) => !next && !pending && setConfirm(null)}>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle>Save the glossary?</AlertDialogTitle>
            <AlertDialogDescription>Pages that use a term you changed:</AlertDialogDescription>
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
            <Button disabled={pending} focusableWhenDisabled onClick={() => confirm && commit(confirm.terms)}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
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
  const keptTheirs =
    row.keep &&
    languages
      .filter(({ code }) => row.theirs?.[code] !== undefined)
      .map(({ code, native }) => `${native} ${row.theirs![code] || "Model decides"}`)
      .join(", ");
  // Each field's own name: shown above it in a card, the column's on wide screens (only for screen readers there).
  const fieldLabel = cn("text-sm font-medium", columns && "@min-[44rem]/settings:sr-only");
  return (
    <li
      style={{ "--languages": languages.length } as React.CSSProperties}
      className={cn(
        "grid grid-cols-2 items-end gap-x-3 gap-y-3 px-4 py-3.5 @min-[34rem]/settings:px-5",
        columns && cn(COLUMNS, "@min-[44rem]/settings:items-center @min-[44rem]/settings:py-2.5"),
      )}
    >
      <div className={cn("col-span-2 flex flex-col gap-1.5", columns && "@min-[44rem]/settings:col-span-1")}>
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
          aria-describedby={[row.meanwhile && `${row.key}-meanwhile`, keptTheirs && `${row.key}-theirs`].filter(Boolean).join(" ") || undefined}
          onChange={(event) => onChange({ term: event.target.value })}
        />
        {row.meanwhile && (
          <Badge id={`${row.key}-meanwhile`} variant="highlight" className="self-start">
            {row.meanwhile}
          </Badge>
        )}
        {/* Never translated here, so no word fields: a teammate's words, all on one line. */}
        {keptTheirs && (
          <p id={`${row.key}-theirs`} className="text-xs text-muted-foreground">
            Theirs: {keptTheirs}
          </p>
        )}
      </div>
      {row.keep ? (
        // In the table, across the languages' columns (a card says it by its switch).
        columns && <p className="hidden self-center text-sm text-muted-foreground @min-[44rem]/settings:col-[span_var(--languages)] @min-[44rem]/settings:block">Never translated</p>
      ) : (
        languages.map((language) => (
          <div key={language.code} className={cn("flex flex-col gap-1.5", languages.length === 1 && "col-span-2", columns && "@min-[44rem]/settings:col-span-1")}>
            <label htmlFor={`${row.key}-${language.code}`} lang={language.code} className={fieldLabel}>
              {language.native}
            </label>
            <Input
              id={`${row.key}-${language.code}`}
              value={row.translations[language.code] ?? ""}
              maxLength={100}
              placeholder="Model decides"
              aria-label={`${name} in ${language.native}`}
              aria-describedby={row.theirs?.[language.code] !== undefined ? `${row.key}-${language.code}-theirs` : undefined}
              onChange={(event) => onChange({ translations: { ...row.translations, [language.code]: event.target.value } })}
            />
            {/* A teammate changed this word too: theirs, to choose from (gone once saved). */}
            {row.theirs?.[language.code] !== undefined && (
              <p id={`${row.key}-${language.code}-theirs`} className="text-xs text-muted-foreground">
                Theirs: {row.theirs[language.code] || "Model decides"}
              </p>
            )}
          </div>
        ))
      )}
      <label className={cn("flex items-center gap-2 text-sm", columns && "@min-[44rem]/settings:justify-center")}>
        {/* Its name says the words shown ("Never translated") and whose they are. */}
        <Switch checked={row.keep} onChange={(event) => onChange({ keep: event.target.checked })} aria-label={`Never translated: ${name}`} />
        <span className={cn(columns && "@min-[44rem]/settings:sr-only")}>Never translated</span>
      </label>
      <Button type="button" variant="ghost" size="icon-sm" className="justify-self-end" aria-label={`Remove ${name}`} onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </li>
  );
}
