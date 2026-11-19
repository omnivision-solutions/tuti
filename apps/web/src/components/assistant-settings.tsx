"use client";

import { XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useCustomizeForm, useFieldChanged } from "@/components/customize-shell";
import { SettingBlock, SettingRow } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { saveAssistantSettings } from "@/server/assistant";
import type { AssistantSettings as Settings } from "@/server/operations/assistant";

const LENGTHS = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "detailed", label: "Detailed" },
] as const;

/** The server's limits (assistant.update's), passed in: a client component can't import them. */
export type AssistantLimits = { instructions: number; topics: number; topic: number };

/**
 * Settings → AI answers: how the docs' AI answers: length, instructions (the tone included) and off-limits topics (see
 * assistant.update), as rows of the page's card, saved by the page's "Save changes".
 */
export function AssistantSettings({ projectSlug, settings, limits }: { projectSlug: string; settings: Settings; limits: AssistantLimits }) {
  const id = useId();
  const { state, pending, form } = useCustomizeForm({
    save: async (prev, formData) => {
      const result = await saveAssistantSettings(projectSlug, prev, formData);
      if (!result.error) {
        toast.success("AI answers saved");
      }
      return result;
    },
  });

  return (
    // Locked while saving: the form is new once saved, so an edit made meanwhile would be lost. `inert`, not disabled
    // fields: those would drop out of what the form holds, which "Save changes" compares with what's saved.
    <form {...form} inert={pending} className="flex flex-col divide-y">
      <SettingRow label={<span id={`${id}-length`}>Answer length</span>}>
        <Segmented name="length" options={LENGTHS} defaultValue={settings.length} aria-labelledby={`${id}-length`} />
      </SettingRow>
      <SettingBlock className="gap-2">
        <label htmlFor="assistant-instructions" className="font-medium">
          Instructions
        </label>
        <Textarea
          id="assistant-instructions"
          name="instructions"
          defaultValue={settings.instructions}
          maxLength={limits.instructions}
          rows={3}
          placeholder="Friendly and plain; address the reader as you"
        />
      </SettingBlock>
      <SettingBlock className="gap-2">
        <label htmlFor="assistant-off-limits" className="font-medium">
          Off-limits topics
        </label>
        <OffLimitsTopics saved={settings.offLimits} max={limits.topics} maxLength={limits.topic} />
        {state.error && <FieldError>{state.error}</FieldError>}
      </SettingBlock>
    </form>
  );
}

/**
 * Off-limits topics as chips in their field: each a field of the form (`offLimits`), removed with its button; the box
 * after them adds one with Enter or a comma (said to screen readers; there's no Add button). The box is a field too, so a topic typed and not yet added is saved with the rest.
 */
export function OffLimitsTopics({ saved, max, maxLength }: { saved: string[]; max: number; maxLength: number }) {
  const [topics, setTopics] = useState(saved);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLInputElement>(null);
  // Chips come and go without anyone typing: the form is told, for "Save changes".
  useFieldChanged(box, topics);
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
    // Drawn as one field (Input's look); a press on its padding goes to the box.
    <div
      className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card px-1.5 py-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-background"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          box.current?.focus();
        }
      }}
    >
      {topics.length > 0 && (
        <ul className="contents">
          {topics.map((topic) => (
            <li key={topic} className="flex max-w-full items-center gap-0.5 rounded-full bg-muted py-0.5 pr-0.5 pl-2.5 text-sm">
              <input type="hidden" name="offLimits" value={topic} />
              <span className="min-w-0 break-words">{topic}</span>
              <button
                type="button"
                aria-label={`Remove ${topic}`}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
      <input
        ref={box}
        id="assistant-off-limits"
        name="offLimits"
        value={draft}
        onChange={(event) => {
          // A comma ends a topic, typed or pasted (as the text changes: phones' keyboards don't say which key was
          // pressed): what's before each becomes a chip, and the rest stays in the box.
          const pieces = event.target.value.split(",");
          const rest = pieces.pop()!;
          const added = [...new Set(pieces.map((piece) => piece.trim()))].filter((piece) => piece && !topics.includes(piece)).slice(0, max - topics.length);
          if (added.length > 0) {
            setTopics([...topics, ...added]);
            setStatus(`Added ${added.join(", ")}`);
          }
          setDraft(pieces.length > 0 ? rest.trimStart() : rest);
        }}
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
        placeholder={full ? `${max} topics is the most` : "Add a topic…"}
        autoComplete="off"
        enterKeyHint="done"
        aria-describedby="assistant-off-limits-hint"
        className="h-7 min-w-32 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground/75 md:text-sm"
      />
      <span id="assistant-off-limits-hint" className="sr-only">
        Press Enter or a comma to add a topic
      </span>
      <span role="status" className="sr-only">
        {status}
      </span>
    </div>
  );
}
