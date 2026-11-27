"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import { matchText } from "@/lib/match-text";
import type { FormState } from "@/server/form-state";
import type { SpamSettings as Settings } from "@/server/operations/spam";
import { listSpamSender, removeSpamSender, setSpamGuidance, setSpamPhrase, type SpamTry, trySpam } from "@/server/spam-settings";

const SENDER = "kim@acme.example or acme.example";
const aboutSender = (entry: string) => (entry.includes("@") ? null : "and its subdomains");
/** An address or a domain as the lists keep it: lowercase, and "@acme.example" the domain. */
const asSender = (entry: string) => entry.trim().toLowerCase().replace(/^@/, "");

/**
 * Settings → Spam (docs/plan.md, Inbox automation, W2): the spam filter's blocked and allowed lists, the team's phrases,
 * its guidance for the AI, and a box to try a message against it. Each list saves as it's changed (see spam.update); the
 * guidance with the page's "Save changes".
 */
export function SpamSettings({
  projectSlug,
  settings,
  maxPhrase,
  maxGuidance,
}: {
  projectSlug: string;
  settings: Settings;
  maxPhrase: number;
  maxGuidance: number;
}) {
  // Decided once per visit: removing the last entry leaves the card, with its empty line and the keyboard's focus in it.
  const [showAllowed] = useState(settings.allowed.length > 0);
  return (
    <>
      <EntryList
        id="spam-blocked"
        title="Blocked"
        description="New conversations from them go to Spam."
        label="Address or domain to block"
        placeholder={SENDER}
        empty="Nobody is blocked"
        entries={settings.blocked}
        about={aboutSender}
        as={asSender}
        add={(entry) => listSpamSender(projectSlug, true, entry)}
        remove={(entry) => removeSpamSender(projectSlug, entry)}
      />
      {/* Not offered for new entries; any already there stay listed, as they still let senders through, so they can be removed. */}
      {showAllowed && (
        <EntryList
          id="spam-allowed"
          title="Allowed"
          description="Their messages skip your phrases."
          label="Address or domain to allow"
          placeholder={SENDER}
          empty="Nobody is allowed by name"
          entries={settings.allowed}
          about={aboutSender}
          as={asSender}
          add={(entry) => listSpamSender(projectSlug, false, entry)}
          remove={(entry) => removeSpamSender(projectSlug, entry)}
        />
      )}
      <EntryList
        id="spam-phrases"
        title="Phrases"
        description="New conversations with one go to Spam, unless you trust the sender."
        label="Phrase to add"
        placeholder="facebook admin"
        maxLength={maxPhrase}
        empty="No phrases yet"
        entries={settings.phrases}
        as={matchText}
        add={(entry) => setSpamPhrase(projectSlug, entry, true)}
        remove={(entry) => setSpamPhrase(projectSlug, entry, false)}
      />
      {/* Only where the server has a model for the filter (spamSettings): elsewhere nothing would read it. */}
      {settings.guidance !== undefined && <Guidance projectSlug={projectSlug} guidance={settings.guidance} max={maxGuidance} />}
      <TryMessage projectSlug={projectSlug} />
    </>
  );
}

/**
 * One list as a card: its count beside the title, one field and Add (as Redirects' two fields, in the card), then its
 * entries, each with Remove under its ⋯. `about`: a muted word after an entry. `as`: an entry as the server compares
 * them, so one that's there already is said, not added.
 */
function EntryList({
  id,
  title,
  description,
  label,
  placeholder,
  maxLength = 320,
  empty,
  entries,
  about,
  as,
  add,
  remove,
}: {
  id: string;
  title: string;
  description: ReactNode;
  label: string;
  placeholder: string;
  maxLength?: number;
  empty: string;
  entries: string[];
  about?: (entry: string) => string | null;
  as: (entry: string) => string;
  add: (entry: string) => Promise<FormState>;
  remove: (entry: string) => Promise<FormState>;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(async (_prev, formData) => {
    const typed = String(formData.get("entry") ?? "");
    // Said here: the server takes one that's there already as done, and "Added" would be wrong.
    if (entries.some((entry) => as(entry) === as(typed))) {
      return { error: `${typed.trim()} is already on the list` };
    }
    const result = await add(typed);
    if (!result.error) {
      toast.success(`Added to ${title}`);
      form.current?.reset();
    }
    return result;
  }, {});
  // One removed: its row, and the ⋯ menu that had focus, is gone. Focus goes to the list's field. Only where it was
  // lost: one a teammate removed leaves focus where it is.
  const count = useRef(entries.length);
  useEffect(() => {
    if (entries.length < count.current && document.activeElement === document.body) {
      document.getElementById(id)?.focus();
    }
    count.current = entries.length;
  }, [entries.length, id]);
  return (
    <SettingsCard title={title} count={entries.length} description={description}>
      <SettingBlock className="gap-2">
        <form ref={form} {...keepingFields(action)} className="flex items-center gap-2">
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <Input
            id={id}
            name="entry"
            required
            maxLength={maxLength}
            placeholder={placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? `${id}-error` : undefined}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={pending} focusableWhenDisabled aria-label={pending ? undefined : `Add to ${title}`}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </form>
        {state.error && <FieldError id={`${id}-error`}>{state.error}</FieldError>}
      </SettingBlock>
      {entries.length === 0 ? (
        <SettingBlock>
          <p className="text-sm text-muted-foreground">{empty}</p>
        </SettingBlock>
      ) : (
        <ul aria-label={title} className="flex flex-col divide-y">
          {entries.map((entry) => (
            <Entry key={entry} entry={entry} about={about?.(entry) ?? null} remove={remove} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

/** An entry and its ⋯ menu: Remove, at once (adding it again undoes it). */
function Entry({ entry, about, remove }: { entry: string; about: string | null; remove: (entry: string) => Promise<FormState> }) {
  const [pending, startTransition] = useTransition();
  return (
    <li className="flex items-center gap-2 px-4 py-2 @min-[34rem]/settings:px-5">
      <span className="min-w-0 flex-1 text-sm wrap-anywhere">
        {entry}
        {about && <span className="text-muted-foreground"> {about}</span>}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} focusableWhenDisabled aria-label={`Actions for ${entry}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-32">
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              startTransition(async () => {
                const result = await remove(entry);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${entry} removed`);
                }
              })
            }
          >
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** The team's guidance for the AI's checks (checks 6 and 7), in its own words: saved with the page's "Save changes". */
function Guidance({ projectSlug, guidance, max }: { projectSlug: string; guidance: string; max: number }) {
  const { state, pending, form } = useCustomizeForm({
    save: async (_prev, formData) => {
      const result = await setSpamGuidance(projectSlug, String(formData.get("guidance") ?? ""));
      if (!result.error) {
        toast.success("Guidance saved");
      }
      return result;
    },
  });
  return (
    <SettingsCard
      title="Guidance for the AI"
      description="What is and isn't spam for your team. For now the AI only notes what it would file."
    >
      {/* Locked while saving, as other settings forms: an edit made meanwhile would be lost. */}
      <form {...form} inert={pending} className="flex flex-col">
        <SettingBlock className="gap-2">
          <label htmlFor="spam-guidance" className="sr-only">
            Guidance for the AI
          </label>
          <Textarea
            id="spam-guidance"
            name="guidance"
            defaultValue={guidance}
            maxLength={max}
            rows={3}
            placeholder="Agencies offering SEO or design work are spam; questions about our API never are"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "spam-guidance-error" : undefined}
          />
          {state.error && <FieldError id="spam-guidance-error">{state.error}</FieldError>}
        </SettingBlock>
      </form>
    </SettingsCard>
  );
}

/** The box to try a message: what the filter would do with an email from this address, and why. Nothing is saved. */
function TryMessage({ projectSlug }: { projectSlug: string }) {
  const [state, action, pending] = useActionState<SpamTry, FormData>(
    (_prev, formData) => trySpam(projectSlug, { sender: String(formData.get("sender") ?? ""), subject: String(formData.get("subject") ?? ""), text: String(formData.get("text") ?? "") }),
    {},
  );
  return (
    <SettingsCard title="Try a message" description="Nothing is sent or saved.">
      <form {...keepingFields(action)} className="flex flex-col divide-y">
        <SettingRow label="From" htmlFor="spam-try-sender">
          <Input id="spam-try-sender" name="sender" type="email" required maxLength={320} placeholder="kim@acme.example" autoComplete="off" className="@min-[34rem]/settings:w-80" />
        </SettingRow>
        <SettingRow label="Subject" htmlFor="spam-try-subject">
          <Input id="spam-try-subject" name="subject" maxLength={200} autoComplete="off" className="@min-[34rem]/settings:w-80" />
        </SettingRow>
        <SettingBlock className="gap-2">
          <label htmlFor="spam-try-text" className="font-medium">
            Message
          </label>
          <Textarea id="spam-try-text" name="text" rows={3} maxLength={10_000} />
        </SettingBlock>
        <SettingBlock className="gap-2 @min-[34rem]/settings:flex-row @min-[34rem]/settings:items-center">
          <Button type="submit" variant="outline" disabled={pending} focusableWhenDisabled className="self-start">
            {pending ? "Trying…" : "Try it"}
          </Button>
          <p role="status" className="min-w-0 text-sm wrap-anywhere">
            {!pending && state.why && (state.spam ? `This would go to Spam: ${state.why}.` : `This would reach the Inbox: ${state.why}.`)}
          </p>
          {!pending && state.error && <FieldError>{state.error}</FieldError>}
        </SettingBlock>
      </form>
    </SettingsCard>
  );
}
