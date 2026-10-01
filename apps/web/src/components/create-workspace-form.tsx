"use client";

import { useActionState } from "react";

import type { FormState } from "@/server/form-state";
import { createWorkspace } from "@/server/workspaces";

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createWorkspace, {});

  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="name" placeholder="Workspace name (e.g. Acme)" required className="input" />
      <div className="flex items-center gap-1 text-sm text-zinc-500">
        tuti.so/
        <input name="slug" placeholder="acme" required className="input flex-1" />
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
