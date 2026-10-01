"use client";

import { useActionState, useEffect, useRef } from "react";

import type { FormState } from "@/server/form-state";
import { createPost } from "@/server/posts";

export function NewPostForm({ workspaceSlug, boardSlug }: { workspaceSlug: string; boardSlug: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(createPost, {});

  useEffect(() => {
    if (!pending && !state.error) {
      formRef.current?.reset();
    }
  }, [pending, state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="boardSlug" value={boardSlug} />
      <input name="title" placeholder="Short, descriptive title" required className="input" />
      <textarea name="body" placeholder="Any more details?" rows={3} className="input" />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button type="submit" disabled={pending} className="btn-primary self-end">
        {pending ? "Posting…" : "Submit feedback"}
      </button>
    </form>
  );
}
