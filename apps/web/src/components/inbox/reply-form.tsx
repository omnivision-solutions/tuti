"use client";

import { useId, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { replyInConversation } from "@/server/inbox";

/** The team's reply box; ⌘/Ctrl+Enter sends. */
export function ReplyForm({ projectSlug, number }: { projectSlug: string; number: number }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const errorId = useId();

  const send = () =>
    startTransition(async () => {
      const result = await replyInConversation(projectSlug, number, body);
      setError(result.error);
      if (!result.error) {
        setBody("");
      }
    });

  return (
    <form
      ref={form}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Field data-invalid={error ? true : undefined}>
        <Textarea
          aria-label="Reply"
          placeholder="Write a reply…"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !pending) {
              event.preventDefault();
              form.current?.requestSubmit();
            }
          }}
          rows={4}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? "Sending…" : "Send"}
      </Button>
    </form>
  );
}
