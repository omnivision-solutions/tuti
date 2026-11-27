"use client";

import type { Doc } from "@tuti/content";
import { DOMSerializer, Fragment, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { rewriteText } from "@/server/rewrite";

/**
 * Ask AI on a selection (docs/plan.md, AI rewrite): the team says how to change the selected text (a preset or its own
 * words), the AI's version shows under it with the old text struck through, and Accept puts it in place as one edit
 * (undo takes it back; nothing is saved until the entry is). Edits elsewhere in the text move it along; an edit inside
 * the selected text while the AI works, or before it's accepted, drops it, saying so.
 */

/** Where Ask AI can be used, and for what. `paused`: the project is out of credits. */
export type AskAiSetup = { projectSlug: string; kind: "changelog" | "article"; entry?: number; paused: boolean };

/** The presets: a short name, and the instruction the AI gets. */
export const ASK_AI_PRESETS: [string, string][] = [
  ["Shorter", "Make it shorter, keeping every change it mentions."],
  ["Clearer", "Make it clearer and more direct."],
  ["Friendlier", "Make it friendlier and warmer, without exaggerating."],
  ["Fix grammar", "Fix spelling, grammar and punctuation only. Change nothing else."],
  ["For non-developers", "Explain it for people who aren't developers: plain words instead of jargon and technical terms."],
  ["Make a list", "Turn it into a list of short points."],
];
const MAX_INSTRUCTION = 200;
/** The person's own instructions, last used first: kept in their browser only. */
const RECENT_KEY = "tuti.askAi.recent";
const RECENT_COUNT = 5;

function recentInstructions(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string").slice(0, RECENT_COUNT) : [];
  } catch {
    return [];
  }
}
function remember(instruction: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([instruction, ...recentInstructions().filter((each) => each !== instruction)].slice(0, RECENT_COUNT)));
  } catch {
    // Private browsing without storage: nothing to remember it in.
  }
}

/** The text being edited, and the AI's version once it's back (null while it works). `id`: this request's, so a late answer to an earlier one is ignored. */
type Asked = { id: number; from: number; to: number; instruction: string; result: Doc | null };
export const ASK_AI = new PluginKey<Asked | null>("askAi");
const ask = (state: EditorState) => ASK_AI.getState(state) ?? null;

/** Accept, Try again and Discard, from the AI's version shown in the text. */
type Actions = { accept: () => void; retry: () => void; discard: () => void; lost: () => void };

/** The plugin, added to the editor once; `actions` is read when its buttons are pressed. */
export function askAiPlugin(actions: { current: Actions | null }) {
  return new Plugin<Asked | null>({
    key: ASK_AI,
    state: {
      init: () => null,
      apply: (tr, value) => {
        const meta = tr.getMeta(ASK_AI) as Asked | null | undefined;
        if (meta !== undefined) {
          return meta;
        }
        if (!value || !tr.docChanged) {
          return value;
        }
        // Through each step in turn: text added right at either end is outside it; anything touching what's inside drops it.
        let { from, to } = value;
        let touched = false;
        for (const map of tr.mapping.maps) {
          map.forEach((start, end) => {
            touched ||= start < to && end > from;
          });
          from = map.map(from, 1);
          to = map.map(to, -1);
        }
        if (touched || from >= to) {
          queueMicrotask(() => actions.current?.lost());
          return null;
        }
        return { ...value, from, to };
      },
    },
    props: {
      decorations(state) {
        const asked = ask(state);
        if (!asked) {
          return null;
        }
        if (!asked.result) {
          return DecorationSet.create(state.doc, [Decoration.inline(asked.from, asked.to, { class: "animate-pulse rounded-sm bg-primary/10", "data-ask-ai": "working" })]);
        }
        const result = asked.result;
        // After the block the selection ends in: its own lines, whatever part of a line was selected.
        const after = state.doc.resolve(asked.to).after(1);
        return DecorationSet.create(state.doc, [
          Decoration.inline(asked.from, asked.to, { class: "text-muted-foreground line-through decoration-destructive/70", "data-ask-ai": "old" }),
          Decoration.widget(after, (view) => aiVersion(view.state, result, actions), { side: 1, key: `ask-ai-${asked.id}`, stopEvent: () => true, ignoreSelection: true }),
        ]);
      },
    },
  });
}

/** The AI's version as it would read, with its buttons: not part of the text. */
function aiVersion(state: EditorState, result: Doc, actions: { current: Actions | null }) {
  const box = document.createElement("div");
  box.contentEditable = "false";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "The AI's version");
  box.dataset.askAi = "new";
  box.className = "my-3 rounded-lg border border-success/40 bg-success/5 px-4 py-3";
  const text = document.createElement("div");
  text.append(DOMSerializer.fromSchema(state.schema).serializeFragment(Fragment.fromJSON(state.schema, result.content ?? [])));
  const buttons = document.createElement("div");
  buttons.className = "mt-2 flex flex-wrap gap-2 font-sans text-sm";
  const button = (label: string, primary: boolean, onClick: () => void) => {
    const each = document.createElement("button");
    each.type = "button";
    each.textContent = label;
    each.className = primary
      ? "rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      : "rounded-md border px-2.5 py-1 font-medium hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";
    each.addEventListener("click", onClick);
    return each;
  };
  buttons.append(
    button("Accept", true, () => actions.current?.accept()),
    button("Try again", false, () => actions.current?.retry()),
    button("Discard", false, () => actions.current?.discard()),
  );
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      actions.current?.discard();
    }
  });
  box.append(text, buttons);
  return box;
}

const set = (editor: Editor, asked: Asked | null) => editor.view.dispatch(editor.state.tr.setMeta(ASK_AI, asked).setMeta("addToHistory", false));

/**
 * The editor's Ask AI: `open` starts it on the selection (the dialog), and `actions` answers the AI's version's buttons.
 * Render `dialog` beside the editor.
 */
export function useAskAi(editor: Editor | null, setup: AskAiSetup | null | undefined) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const next = useRef(0);
  const actions = useRef<Actions | null>(null);

  const run = async (from: number, to: number, instruction: string) => {
    if (!editor || !setup) {
      return;
    }
    const id = ++next.current;
    const { doc } = editor.state;
    set(editor, { id, from, to, instruction, result: null });
    setStatus("The AI is editing the selected text…");
    const all = from <= 1 && to >= doc.content.size - 1;
    const result = await rewriteText(setup.projectSlug, {
      kind: setup.kind,
      entry: setup.entry,
      // With the blocks around it, so part of a line goes as a paragraph (part of a list item as a list).
      text: { type: "doc", content: doc.slice(from, to, true).content.toJSON() as Doc["content"] },
      whole: all ? undefined : editor.getJSON(),
      instruction,
    }).catch(() => ({ error: "The AI couldn't edit the text. Try again in a moment.", content: undefined }));
    // Discarded, lost or asked again since: this answer is no one's.
    const now = !editor.isDestroyed && ask(editor.state);
    if (!now || now.id !== id) {
      return;
    }
    if (!result.content) {
      set(editor, null);
      setStatus("");
      toast.error(result.error ?? "The AI couldn't edit the text. Try again in a moment.");
      return;
    }
    set(editor, { ...now, result: result.content });
    setStatus("The AI's version is under the selected text: Accept, Try again or Discard.");
    // On its Accept: left in the text, a key there (Tab in a list indents the item) would edit the selected text and drop it.
    editor.view.dom.querySelector<HTMLButtonElement>('[data-ask-ai="new"] button')?.focus();
  };

  // Each render's: the buttons in the text call the latest.
  useEffect(() => {
    actions.current = editor
    ? {
        accept: () => {
          const now = ask(editor.state);
          if (!now?.result) {
            return;
          }
          // A paragraph at either end joins the text around it there (part of a line stays part of it); anything else
          // (a list, a heading) goes in as its own block, as the preview shows it.
          const fragment = Fragment.fromJSON(editor.schema, now.result.content ?? []);
          const open = (node: typeof fragment.firstChild) => (node?.type.name === "paragraph" ? 1 : 0);
          const slice = new Slice(fragment, open(fragment.firstChild), open(fragment.lastChild));
          const tr: Transaction = editor.state.tr.replaceRange(now.from, now.to, slice).setMeta(ASK_AI, null);
          editor.view.dispatch(tr);
          editor.commands.focus();
          setStatus("The AI's version is in the text.");
        },
        retry: () => {
          const now = ask(editor.state);
          if (now) {
            void run(now.from, now.to, now.instruction);
          }
        },
        discard: () => {
          set(editor, null);
          editor.commands.focus();
          setStatus("");
        },
        lost: () => {
          setStatus("");
          toast("The text changed, so the AI's edit was dropped. Select it again to ask again.");
        },
      }
    : null;
  });

  const start = (instruction: string) => {
    if (!editor) {
      return;
    }
    const { from, to } = editor.state.selection;
    setOpen(false);
    if (from < to) {
      void run(from, to, instruction);
    }
  };

  return {
    plugin: () => askAiPlugin(actions),
    open: () => {
      setRecent(recentInstructions());
      setOpen(true);
    },
    busy: () => !!editor && ask(editor.state) !== null,
    dialog: editor && setup && (
      <>
        <AskAiDialog open={open} recent={recent} onClose={() => setOpen(false)} onAsk={start} editor={editor} />
        <p role="status" className="sr-only">
          {status}
        </p>
      </>
    ),
  };
}

function AskAiDialog({
  open,
  recent,
  onClose,
  onAsk,
  editor,
}: {
  open: boolean;
  /** The person's own instructions, last used first (read as it opens). */
  recent: string[];
  onClose: () => void;
  onAsk: (instruction: string) => void;
  editor: Editor;
}) {
  const inputId = useId();
  const own = (instruction: string) => {
    remember(instruction);
    onAsk(instruction);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        finalFocus={() => {
          editor.commands.focus();
          return false;
        }}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            // Inside the entry's form in React's tree: don't submit that.
            event.preventDefault();
            event.stopPropagation();
            const instruction = String(new FormData(event.currentTarget).get("instruction") ?? "").trim();
            if (instruction) {
              own(instruction);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Ask AI</DialogTitle>
          </DialogHeader>
          <div role="group" aria-label="Presets" className="flex flex-wrap gap-2">
            {ASK_AI_PRESETS.map(([label, instruction]) => (
              <Button key={label} type="button" variant="outline" size="sm" onClick={() => onAsk(instruction)}>
                {label}
              </Button>
            ))}
          </div>
          {recent.length > 0 && (
            <div role="group" aria-label="Your recent instructions" className="flex flex-col items-start gap-1">
              {recent.map((instruction) => (
                <Button key={instruction} type="button" variant="ghost" size="sm" className="h-auto max-w-full justify-start py-1 text-left whitespace-normal" onClick={() => own(instruction)}>
                  {instruction}
                </Button>
              ))}
            </div>
          )}
          <Field>
            <FieldLabel htmlFor={inputId}>Or say how to change it</FieldLabel>
            <Input id={inputId} name="instruction" autoComplete="off" maxLength={MAX_INSTRUCTION} placeholder="Mention it works on phones too" required autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Ask AI</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
