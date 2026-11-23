"use client";

import { SparklesIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { CopyButton } from "@/components/copy-button";

/**
 * A prompt for the team's coding agent, folded: what it will do in a few steps and Copy prompt, the whole text on
 * request (it's long, and pasted rather than read).
 */
export function AgentPrompt({ prompt, steps }: { prompt: string; steps: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border p-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
        <SparklesIcon aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm">
        <p className="font-medium">Paste into your coding agent. It will:</p>
        <ol className="list-decimal pl-5 text-muted-foreground [&_code]:font-mono [&_code]:text-xs [&_code]:text-foreground">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="self-start text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {open ? "Hide full prompt" : "Show full prompt"}
        </button>
        {open && <pre className="max-h-64 overflow-y-auto rounded-lg bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">{prompt}</pre>}
      </div>
      <CopyButton value={prompt} label="prompt" wide />
    </div>
  );
}
