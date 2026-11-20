"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/settings-card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getSupportAddress, saveDraftInstructions, setSupportInbox } from "@/server/inbox";

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
