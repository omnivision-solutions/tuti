"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/settings-card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { nativeLanguageName, TEAM_LANGUAGES } from "@/lib/language-name";
import { getSupportAddress, saveDraftInstructions, setSupportInbox, setTranslation } from "@/server/inbox";

/** Turns the support inbox on or off. */
export function SupportInboxSwitch({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(on);
  return (
    <SettingRow
      label="Messages in the widget"
      description="Users write to your team from the widget."
      info="Your users get a Messages tab in the widget to write to your team and see your replies there. Signed out, they leave their email first. “Ask a person” after an AI answer starts a conversation here too, so it's off while this is."
      htmlFor="support-inbox"
      inline
    >
      <Switch
        id="support-inbox"
        aria-describedby="support-inbox-description"
        checked={checked}
        disabled={pending}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setChecked(next);
          startTransition(async () => {
            const result = await setSupportInbox(projectSlug, next);
            if (result.error) {
              setChecked(!next);
              toast.error(result.error);
            } else {
              toast.success(next ? "Messages on" : "Messages off");
            }
          });
        }}
      />
    </SettingRow>
  );
}

/**
 * Translate conversations and the team's language (docs/plan.md L22), each saved as it changes. Without AI on the server
 * the switch can't be turned on (only off), and says why; what it costs only where credits are on.
 */
export function TranslationSettings({
  projectSlug,
  translate,
  teamLanguage,
  ai,
  credits,
}: {
  projectSlug: string;
  translate: boolean;
  teamLanguage: string;
  ai: boolean;
  credits: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useState(translate);
  const [language, setLanguage] = useState(teamLanguage);
  // A language set through the API that isn't offered here is still shown as it is.
  const languages = TEAM_LANGUAGES.includes(language) ? TEAM_LANGUAGES : [...TEAM_LANGUAGES, language];
  const items = languages.map((code) => ({ value: code, label: nativeLanguageName(code) }));
  const save = (change: { translate?: boolean; teamLanguage?: string }, undo: () => void, done: string) =>
    startTransition(async () => {
      const result = await setTranslation(projectSlug, change);
      if (result.error) {
        undo();
        toast.error(result.error);
      } else {
        toast.success(done);
      }
    });
  return (
    <>
      <SettingRow
        label="Translate conversations"
        description={
          ai
            ? `Customers' messages are shown in your team's language, and your replies go out in theirs.${credits ? " Uses AI credits." : ""}`
            : "Needs AI, which isn't set up on this server."
        }
        htmlFor="translate-conversations"
        inline
      >
        <Switch
          id="translate-conversations"
          aria-describedby="translate-conversations-description"
          checked={on}
          disabled={pending || (!ai && !on)}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            setOn(next);
            save({ translate: next }, () => setOn(!next), next ? "Translation on" : "Translation off");
          }}
        />
      </SettingRow>
      <SettingRow label={<span id="team-language-label">Team language</span>} description="What your team reads and writes conversations in." htmlFor="team-language" inline>
        <Select
          items={items}
          value={language}
          disabled={pending}
          onValueChange={(next) => {
            if (typeof next !== "string" || next === language) {
              return;
            }
            const previous = language;
            setLanguage(next);
            save({ teamLanguage: next }, () => setLanguage(previous), "Team language saved");
          }}
        >
          <SelectTrigger id="team-language" className="w-32 @min-[20rem]/settings:w-40" aria-labelledby="team-language-label" aria-describedby="team-language-description">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </>
  );
}

/** Gives the project its support email address (it's its for good). */
export function GetSupportAddressButton({ projectSlug }: { projectSlug: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      focusableWhenDisabled
      onClick={() =>
        startTransition(async () => {
          const result = await getSupportAddress(projectSlug);
          if (result.error) {
            toast.error(result.error);
          }
        })
      }
    >
      Get a support address
    </Button>
  );
}

/** Settings → AI → Inbox: the team's standing instructions for replies drafted by AI, saved by the page's "Save changes". */
export function DraftInstructionsForm({ projectSlug, instructions }: { projectSlug: string; instructions: string }) {
  const { state, pending, form } = useCustomizeForm({
    save: async (prev, formData) => {
      const result = await saveDraftInstructions(projectSlug, prev, formData);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Instructions saved");
      }
      return result;
    },
  });
  return (
    <form {...form}>
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor="draft-instructions">Instructions for drafts</FieldLabel>
        <Textarea
          id="draft-instructions"
          name="instructions"
          defaultValue={instructions}
          // Read-only while saving: an edit made then wouldn't be in what's saved. Not disabled, which would drop focus.
          readOnly={pending}
          maxLength={2000}
          placeholder="Keep replies short and friendly. End by asking whether that helped."
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "draft-instructions-error" : undefined}
        />
        {state.error && <FieldError id="draft-instructions-error">{state.error}</FieldError>}
      </Field>
    </form>
  );
}
