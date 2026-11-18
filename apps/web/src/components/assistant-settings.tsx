"use client";

import { XIcon } from "lucide-react";
import { useActionState, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import { saveAssistantSettings } from "@/server/assistant";
import type { FormState } from "@/server/form-state";
import type { AssistantSettings as Settings } from "@/server/operations/assistant";

const LENGTHS = [
  ["short", "Short"],
  ["medium", "Medium"],
  ["detailed", "Detailed"],
] as const;

/** The server's limits (assistant.update's), passed in: a client component can't import them. */
export type AssistantLimits = { instructions: number; topics: number; topic: number };

/** Settings → AI answers: how the docs' AI answers: length, instructions (the tone included) and off-limits topics (see assistant.update). */
export function AssistantSettings({ projectSlug, settings, limits }: { projectSlug: string; settings: Settings; limits: AssistantLimits }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveAssistantSettings(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("AI answers saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      {/* Locked while saving: the form is new once saved, so an edit made meanwhile would be lost. */}
      <fieldset disabled={pending} className="contents">
        <FieldGroup>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Answer length</legend>
            <div className="flex flex-wrap gap-4">
              {LENGTHS.map(([value, name]) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="length" value={value} defaultChecked={settings.length === value} className="size-4 accent-primary" />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
          <Field>
            <FieldLabel htmlFor="assistant-instructions">Instructions</FieldLabel>
            <Textarea
              id="assistant-instructions"
              name="instructions"
              defaultValue={settings.instructions}
              maxLength={limits.instructions}
              rows={4}
              placeholder="Friendly and plain; address the reader as you"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="assistant-off-limits">Off-limits topics</FieldLabel>
            <OffLimitsTopics saved={settings.offLimits} max={limits.topics} maxLength={limits.topic} />
          </Field>
          {state.error && <FieldError>{state.error}</FieldError>}
          <Button type="submit" disabled={pending} className="self-end">
            {pending ? "Saving…" : "Save"}
          </Button>
        </FieldGroup>
      </fieldset>
    </form>
  );
}

/**
 * Off-limits topics as chips: each a field of the form (`offLimits`), removed with its button; the box adds one with
 * Enter or Add. The box is a field too, so a topic typed and not yet added is saved with the rest.
 */
export function OffLimitsTopics({ saved, max, maxLength }: { saved: string[]; max: number; maxLength: number }) {
  const [topics, setTopics] = useState(saved);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLInputElement>(null);
  const full = topics.length >= max;
  // What just happened to the chips, read out by a screen reader: the box alone doesn't say.
  const [status, setStatus] = useState("");
  const add = () => {
    const topic = draft.trim();
    if (topic && topics.includes(topic)) {
      // Left in the box, so it shows that nothing was added.
      setStatus(`${topic} is already there`);
      return;
    }
    if (topic && !full) {
      setTopics([...topics, topic]);
      setStatus(`Added ${topic}`);
    }
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      {topics.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {topics.map((topic) => (
            <li key={topic} className="flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-sm">
              <input type="hidden" name="offLimits" value={topic} />
              <span className="min-w-0 break-words">{topic}</span>
              <button
                type="button"
                aria-label={`Remove ${topic}`}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                  setTopics(topics.filter((other) => other !== topic));
                  setStatus(`Removed ${topic}`);
                  // Its button is gone: focus goes to the box, not to the top of the page.
                  box.current?.focus();
                }}
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          ref={box}
          id="assistant-off-limits"
          name="offLimits"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the topic; it doesn't save the form. Not the Enter that confirms an input method's candidate (Safari sends that one
            // after the composition ends, with key code 229).
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              add();
            }
          }}
          readOnly={full}
          maxLength={maxLength}
          // An example only while there are none: beside chips it reads as one more.
          placeholder={full ? `${max} topics is the most` : topics.length === 0 ? "refund" : undefined}
          autoComplete="off"
        />
        <Button type="button" variant="outline" disabled={full} focusableWhenDisabled onClick={add}>
          Add
        </Button>
      </div>
      <span role="status" className="sr-only">
        {status}
      </span>
    </div>
  );
}
