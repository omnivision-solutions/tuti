"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import { describeSpamRule, SPAM_RULE_FIELD_KEYS, SPAM_RULE_FIELDS, SPAM_RULE_MATCHER_KEYS, SPAM_RULE_MATCHERS, type SpamRuleField, type SpamRuleMatcher, spamRuleKey, spamRuleValue } from "@/lib/spam-rules";
import type { FormState } from "@/server/form-state";
import type { SpamRuleRow, SpamSettings as Settings } from "@/server/operations/spam";
import { addSpamRule, allowSpamSender, removeSpamRule, removeSpamSender, setSpamGuidance, type SpamTry, trySpam } from "@/server/spam-settings";

const SENDER = "kim@acme.example or acme.example";
const aboutSender = (entry: string) => (entry.includes("@") ? null : "and its subdomains");
/** An address or a domain as the lists keep it: lowercase, and "@acme.example" the domain. */
const asSender = (entry: string) => entry.trim().toLowerCase().replace(/^@/, "");

/** What the value field suggests for each field. */
const PLACEHOLDERS: Record<SpamRuleField, string> = {
  sender_domain: "spam.example",
  sender_address: "kim@spam.example",
  sender_name: "Facebook Support",
  subject: "Your page will be disabled",
  body: "facebook admin",
  subject_or_body: "facebook admin",
  sent_to: "sales@acme.example",
};

/**
 * Settings → Spam (docs/plan.md, Inbox automation, W2 and W2b): the spam filter's block rules, its allowed list (shown
 * only while it has entries), the AI spam check's guidance, and a box to try a message against it. The rules and the
 * list save as they're changed (see spam.update); the guidance with the page's "Save changes".
 */
export function SpamSettings({ projectSlug, settings, maxValue, maxGuidance }: { projectSlug: string; settings: Settings; maxValue: number; maxGuidance: number }) {
  // The last allowed entry removed takes its card: focus goes to the rules' field.
  useFocusAfterRemoval(settings.allowed.length, settings.allowed.length > 0 ? "spam-allowed" : "spam-rule-value");
  return (
    <>
      <BlockRules projectSlug={projectSlug} rules={settings.rules} maxValue={maxValue} />
      {/* Not offered for new entries; any already there stay listed, as they still let senders through, so they can be removed. */}
      {settings.allowed.length > 0 && (
        <EntryList
          id="spam-allowed"
          title="Allowed"
          description="Their messages skip your rules on what they say."
          label="Address or domain to allow"
          placeholder={SENDER}
          entries={settings.allowed}
          about={aboutSender}
          as={asSender}
          add={(entry) => allowSpamSender(projectSlug, entry)}
          remove={(entry) => removeSpamSender(projectSlug, entry)}
        />
      )}
      {/* Only where the server has a model for the filter (spamSettings): elsewhere nothing would read it. */}
      {settings.guidance !== undefined && <Guidance projectSlug={projectSlug} guidance={settings.guidance} max={maxGuidance} />}
      <TryMessage projectSlug={projectSlug} />
    </>
  );
}

/** The block rules: a field, a matcher and a value with Add (Sender domain and "is" to start), then each rule with Remove. */
function BlockRules({ projectSlug, rules, maxValue }: { projectSlug: string; rules: SpamRuleRow[]; maxValue: number }) {
  const form = useRef<HTMLFormElement>(null);
  const [field, setField] = useState<SpamRuleField>("sender_domain");
  const [matcher, setMatcher] = useState<SpamRuleMatcher>("is");
  const [state, action, pending] = useActionState<FormState, FormData>(async (_prev, formData) => {
    const rule = { field, matcher, value: spamRuleValue(field, String(formData.get("value") ?? "")) };
    // Said here: the server takes one that's there already as done, and "Added" would be wrong.
    if (rules.some((other) => spamRuleKey(other) === spamRuleKey(rule))) {
      return { error: "That rule is already there" };
    }
    const result = await addSpamRule(projectSlug, rule);
    if (!result.error) {
      toast.success("Rule added");
      form.current?.reset();
    }
    return result;
  }, {});
  useFocusAfterRemoval(rules.length, "spam-rule-value");
  return (
    <SettingsCard title="Block rules" count={rules.length} description="New conversations that match one go to Spam.">
      <SettingBlock className="gap-2">
        <form ref={form} {...keepingFields(action)} className="flex flex-col gap-2 @min-[34rem]/settings:flex-row @min-[34rem]/settings:items-center">
          <div className="flex gap-2">
            <Select items={SPAM_RULE_FIELDS} value={field} onValueChange={(next) => setField(next as SpamRuleField)}>
              <SelectTrigger className="min-w-0 flex-1 @min-[34rem]/settings:w-40 @min-[34rem]/settings:flex-none" aria-label="Field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPAM_RULE_FIELD_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {SPAM_RULE_FIELDS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select items={SPAM_RULE_MATCHERS} value={matcher} onValueChange={(next) => setMatcher(next as SpamRuleMatcher)}>
              <SelectTrigger className="min-w-0 flex-1 @min-[34rem]/settings:w-40 @min-[34rem]/settings:flex-none" aria-label="Matcher">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPAM_RULE_MATCHER_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {SPAM_RULE_MATCHERS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-0 flex-1 gap-2">
            <Input
              id="spam-rule-value"
              name="value"
              required
              maxLength={maxValue}
              placeholder={matcher === "pattern" ? "*@*.spam.example" : PLACEHOLDERS[field]}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="Value"
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? "spam-rule-error" : undefined}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="outline" disabled={pending} focusableWhenDisabled aria-label={pending ? undefined : "Add rule"}>
              {pending ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
        {state.error && <FieldError id="spam-rule-error">{state.error}</FieldError>}
      </SettingBlock>
      {rules.length === 0 ? (
        <SettingBlock>
          <p className="text-sm text-muted-foreground">No rules yet</p>
        </SettingBlock>
      ) : (
        <ul aria-label="Block rules" className="flex flex-col divide-y">
          {rules.map((rule) => (
            <Entry
              key={rule.id}
              entry={describeSpamRule(rule)}
              shown={
                <>
                  <span className="text-muted-foreground">
                    {SPAM_RULE_FIELDS[rule.field]} {SPAM_RULE_MATCHERS[rule.matcher]}
                  </span>{" "}
                  {rule.value}
                  {rule.fromReport && (
                    <>
                      {" "}
                      <Badge variant="secondary">from a report</Badge>
                    </>
                  )}
                </>
              }
              removed="Rule removed"
              remove={() => removeSpamRule(projectSlug, rule.id)}
            />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

/**
 * One removed: its row, and the ⋯ menu that had focus, is gone. Focus goes to the list's field. Only where it was lost:
 * one a teammate removed leaves focus where it is.
 */
function useFocusAfterRemoval(length: number, id: string) {
  const count = useRef(length);
  useEffect(() => {
    if (length < count.current && document.activeElement === document.body) {
      document.getElementById(id)?.focus();
    }
    count.current = length;
  }, [length, id]);
}

/**
 * A list as a card: its count beside the title, one field and Add (as Redirects' two fields, in the card), then its
 * entries, each with Remove under its ⋯. `about`: a muted word after an entry. `as`: an entry as the server compares
 * them, so one that's there already is said, not added.
 */
function EntryList({
  id,
  title,
  description,
  label,
  placeholder,
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
            maxLength={320}
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
      <ul aria-label={title} className="flex flex-col divide-y">
        {entries.map((entry) => {
          const muted = about?.(entry);
          return (
            <Entry
              key={entry}
              entry={entry}
              shown={
                <>
                  {entry}
                  {muted && <span className="text-muted-foreground"> {muted}</span>}
                </>
              }
              removed={`${entry} removed`}
              remove={() => remove(entry)}
            />
          );
        })}
      </ul>
    </SettingsCard>
  );
}

/** An entry and its ⋯ menu: Remove, at once (adding it again undoes it). `entry`: its name to the ear. */
function Entry({ entry, shown, removed, remove }: { entry: string; shown: ReactNode; removed: string; remove: () => Promise<FormState> }) {
  const [pending, startTransition] = useTransition();
  return (
    <li className="flex items-center gap-2 px-4 py-2 @min-[34rem]/settings:px-5">
      <span className="min-w-0 flex-1 text-sm wrap-anywhere">{shown}</span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} focusableWhenDisabled aria-label={`Actions for ${entry}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-32">
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              startTransition(async () => {
                const result = await remove();
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(removed);
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

/**
 * The AI spam check (checks 6 and 7): the team's guidance in its own words, saved with the page's "Save changes". Off
 * while it's empty: then the AI isn't asked.
 */
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
      title={
        <>
          AI spam check <Badge variant={guidance.trim() ? "soft" : "secondary"}>{guidance.trim() ? "On" : "Off"}</Badge>
        </>
      }
      description="Describe your spam; the AI checks what the rules miss. For now it only notes what it would file."
    >
      {/* Locked while saving, as other settings forms: an edit made meanwhile would be lost. */}
      <form {...form} inert={pending} className="flex flex-col">
        <SettingBlock className="gap-2">
          <label htmlFor="spam-guidance" className="sr-only">
            Describe your spam
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
    (_prev, formData) =>
      trySpam(projectSlug, {
        sender: String(formData.get("sender") ?? ""),
        name: String(formData.get("name") ?? ""),
        to: String(formData.get("to") ?? "").trim() || undefined,
        subject: String(formData.get("subject") ?? ""),
        text: String(formData.get("text") ?? ""),
      }),
    {},
  );
  return (
    <SettingsCard title="Try a message" description="As an email from this address. Nothing is sent or saved.">
      <form {...keepingFields(action)} className="flex flex-col divide-y">
        <SettingRow label="From" htmlFor="spam-try-sender">
          <Input id="spam-try-sender" name="sender" type="email" required maxLength={320} placeholder="kim@acme.example" autoComplete="off" className="@min-[34rem]/settings:w-80" />
        </SettingRow>
        <SettingRow label="Sender name" htmlFor="spam-try-name">
          <Input id="spam-try-name" name="name" maxLength={200} placeholder="Kim Lee" autoComplete="off" className="@min-[34rem]/settings:w-80" />
        </SettingRow>
        <SettingRow label="Sent to" htmlFor="spam-try-to">
          <Input id="spam-try-to" name="to" type="email" maxLength={320} placeholder="sales@acme.example" autoComplete="off" className="@min-[34rem]/settings:w-80" />
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
