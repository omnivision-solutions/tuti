"use client";

import type { Doc } from "@tuti/content";
import { closeHistory } from "@tiptap/pm/history";
import { DOMSerializer, Fragment, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, Selection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
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
/** `ends`: the kind of block the sent text starts and ends in (a paragraph, a list, a heading), its outermost. */
type Asked = { id: number; from: number; to: number; instruction: string; ends: [string, string]; result: Doc | null };
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
      apply: (tr, value, before) => {
        const meta = tr.getMeta(ASK_AI) as Asked | null | undefined;
        if (meta !== undefined) {
          return meta;
        }
        if (!value || !tr.docChanged) {
          return value;
        }
        // Moved along (text added right at either end is outside it); any change to what's inside drops it, formatting
        // too (a mark added moves nothing, so it's the content that's compared).
        const from = tr.mapping.map(value.from, 1);
        const to = tr.mapping.map(value.to, -1);
        if (from >= to || !before.doc.slice(value.from, value.to).eq(tr.doc.slice(from, to))) {
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
        // Right after the line the selection ends in (in a list, inside its item), so it's beside the struck-through text.
        const $end = state.doc.resolve(asked.to);
        const after = $end.depth > 0 ? $end.after() : asked.to;
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
    // The app's own buttons' look (design.md), on plain elements: the version isn't drawn by React.
    each.className = buttonVariants({ variant: primary ? "default" : "outline", size: "sm" });
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
  // The editor going (a save that changes the title or text remounts the form; leaving the page) takes a version working or
  // showing with it: said so, in words true of either.
  useEffect(
    () => () => {
      if (editor && ask(editor.state)) {
        toast("The AI's edit was dropped.");
      }
    },
    [editor],
  );
  const actions = useRef<Actions | null>(null);

  const run = async (from: number, to: number, instruction: string) => {
    if (!editor || !setup) {
      return;
    }
    const id = ++next.current;
    const { doc } = editor.state;
    // The selection in the innermost block holding all of it: its paragraph or heading, or the list whose items it runs
    // across (a nested one's own), never the outer blocks around it (an outer list item cut to its nested list isn't
    // text the AI can edit).
    const $from = doc.resolve(from);
    const holder = $from.node($from.sharedDepth(to));
    const inside = doc.slice(from, to).content;
    const sent = holder.isTextblock || holder.type.name === "bulletList" || holder.type.name === "orderedList" ? Fragment.from(holder.copy(inside)) : inside;
    set(editor, { id, from, to, instruction, ends: [sent.firstChild?.type.name ?? "", sent.lastChild?.type.name ?? ""], result: null });
    setStatus("The AI is editing the selected text…");
    const all = from <= 1 && to >= doc.content.size - 1;
    const result = await rewriteText(setup.projectSlug, {
      kind: setup.kind,
      entry: setup.entry,
      // With the blocks around it, so part of a line goes as a paragraph (part of a list item as a list).
      text: { type: "doc", content: sent.toJSON() as Doc["content"] },
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
      // Try again pressed: its button went with the version, so back to the text.
      if (document.activeElement === document.body) {
        editor.commands.focus();
      }
      return;
    }
    set(editor, { ...now, result: result.content });
    setStatus("The AI's version is under the selected text: Accept, Try again or Discard.");
    // On its Accept while the person is still on the selected text (a key there, Tab in a list indenting the item, would
    // edit it and drop the version) or nowhere (Try again's button went); never away from what they're typing elsewhere.
    const { selection } = editor.state;
    const onIt = editor.view.hasFocus() && selection.from >= now.from && selection.to <= now.to;
    if (onIt || document.activeElement === document.body) {
      editor.view.dom.querySelector<HTMLButtonElement>('[data-ask-ai="new"] button')?.focus();
    }
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
          // Each end joins the text around it as deep as it can where it's the kind of block that was sent (part of a line,
          // of a list item, of a heading stays part of it); a kind changed (a paragraph made a list) goes in as its own
          // block, as the preview shows it.
          const fragment = Fragment.fromJSON(editor.schema, now.result.content ?? []);
          const max = Slice.maxOpen(fragment);
          const slice = new Slice(
            fragment,
            fragment.firstChild?.type.name === now.ends[0] ? max.openStart : 0,
            fragment.lastChild?.type.name === now.ends[1] ? max.openEnd : 0,
          );
          // Its own step in the history: undo takes back only Accept, not typing just before or after it.
          const tr: Transaction = closeHistory(editor.state.tr.replaceRange(now.from, now.to, slice).setMeta(ASK_AI, null));
          editor.view.dispatch(tr);
          editor.view.dispatch(closeHistory(editor.state.tr));
          editor.commands.focus();
          setStatus("The AI's version is in the text.");
        },
        retry: () => {
          const now = ask(editor.state);
          if (now) {
            // Back on the selected text while the AI works (Try again's button goes with the version): focus moves on to
            // the new version's Accept once it's back.
            editor.chain().focus().setTextSelection({ from: now.from, to: now.to }).run();
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
    // One at a time: a version still working or showing goes, said so (it was asked for, and may be paid for).
    if (ask(editor.state)) {
      toast("The AI's earlier edit was dropped for this one.");
    }
    // Only the text: a selection ending at the very start of the next line (Shift+Down, a drag) or starting at the very
    // end of a line would otherwise take the line break along, and Accept would join the two lines.
    const { doc } = editor.state;
    let { from, to } = editor.state.selection;
    // Select All's ends are the document's own, outside every line: onto the first and last text.
    if (doc.resolve(from).depth === 0) {
      from = Selection.findFrom(doc.resolve(from), 1, true)?.from ?? from;
    }
    if (doc.resolve(to).depth === 0) {
      to = Selection.findFrom(doc.resolve(to), -1, true)?.from ?? to;
    }
    const $to = doc.resolve(to);
    if (to > from && $to.parent.isTextblock && $to.parentOffset === 0) {
      to = Selection.findFrom(doc.resolve($to.before()), -1, true)?.from ?? to;
    }
    const $from = doc.resolve(from);
    if (from < to && $from.parent.isTextblock && $from.parentOffset === $from.parent.content.size) {
      from = Selection.findFrom(doc.resolve($from.after()), 1, true)?.from ?? from;
    }
    setOpen(false);
    if (from < to) {
      // The selection made the trimmed range, so focus coming back from the dialog is on it (and moves on to Accept).
      editor.commands.setTextSelection({ from, to });
      void run(from, to, instruction);
    }
  };

  return {
    plugin: () => askAiPlugin(actions),
    open: () => {
      setRecent(recentInstructions());
      setOpen(true);
    },
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
