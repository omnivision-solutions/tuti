"use server";

import { type Doc, droppedFacts, factsIn, readNotes, toMarkdown, writable } from "@tuti/content";
import { aiEnabled, complete, log, MAX_ARTICLE_LENGTH, MAX_ENTRY_LENGTH } from "@tuti/shared";

import { readContent } from "./content";
import { countAiEdit, MAX_INSTRUCTION_LENGTH, teamEntry, writingStyle } from "./operations/changelog";
import { aiOrRefuse } from "./operations/credits";
import { OperationError } from "./operations/define";
import { asTeam } from "./operations/run";
import { droppedMarkers, type RewriteKind, rewritePrompt } from "./release-notes";

/**
 * Ask AI in the changelog and help center editors (docs/plan.md, AI rewrite): the text on screen, a selection or all of
 * it, edited as the team asks, proposed and never saved. App only: an API client edits its own copy of the text.
 */

type Block = NonNullable<Doc["content"]>[number];

/**
 * The reply's budget, and the most text one edit takes, in tokens: the reply has to bring all of it back, so a longer
 * one could never succeed, and each try would still be charged. Half the budget leaves room for an edit that adds
 * words, and for JSON's escaping.
 */
const REPLY_TOKENS = 8000;
const MAX_REWRITE_TOKENS = REPLY_TOKENS / 2;
/**
 * ponytail: a rough count, high rather than low: about 4 ASCII characters a token, any other character one (Japanese,
 * Chinese, Korean are about one each; Cyrillic and Greek less). The provider's tokenizer if it ever matters.
 */
const tokensIn = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? 0.25 : 1), 0);

export type RewriteInput = {
  kind: RewriteKind;
  /** A changelog entry's number: its writing style (Settings → Changelog) is the style. */
  entry?: number;
  /** The part to edit, as rich content (a document of its blocks). */
  text: unknown;
  /** The whole entry or article as on screen, when `text` is part of it: context, and an article's style. */
  whole?: unknown;
  /** What to do: a preset's words or the team's own. */
  instruction: string;
};

/** The edited text as rich content, to put in place of what was sent; or `error` saying why not. */
export async function rewriteText(projectSlug: string, input: RewriteInput): Promise<{ error?: string; content?: Doc }> {
  let content: Doc | undefined;
  const result = await asTeam(projectSlug, "Only the project's team can edit with AI", async ({ projectId }) => {
    content = await rewrite(projectId, input);
  });
  return content ? { content } : result;
}

async function rewrite(projectId: string, input: RewriteInput): Promise<Doc> {
  const kind: RewriteKind = input.kind === "article" ? "article" : "changelog";
  if (!aiEnabled()) {
    throw new OperationError(503, "ai_unavailable", "AI isn't set up on this server");
  }
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  if (instruction === "") {
    throw new OperationError(400, "invalid_input", "Say how to change the text");
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new OperationError(400, "invalid_input", `Keep the instruction under ${MAX_INSTRUCTION_LENGTH} characters`);
  }
  // Checked like anything the team saves: the editor's content, of this project's uploads.
  const read = async (raw: unknown) => {
    const result = await readContent(kind, { content: raw ?? "" }, { projectId, maxLength: kind === "changelog" ? MAX_ENTRY_LENGTH : MAX_ARTICLE_LENGTH });
    if (result.error !== undefined) {
      throw new OperationError(400, "invalid_input", result.error);
    }
    return result.doc;
  };
  const blocks = (await read(input.text)).content ?? [];
  const whole = input.whole === undefined || input.whole === null ? undefined : toMarkdown(await read(input.whole));
  if (kind === "changelog" && !Number.isSafeInteger(input.entry)) {
    throw new OperationError(400, "invalid_input", "Say which changelog entry it's in");
  }
  const style = kind === "changelog" ? await writingStyle(projectId, (await teamEntry(projectId, input.entry!)).id) : undefined;

  // What the reader can't write back (a table, code, italics; an image or a video) goes as a {{media N}} line, and must
  // come back as it was: in the same order, each once.
  const kept: Block[] = [];
  const parts = blocks.map((block) => {
    if (writable(block) && block.type !== "image") {
      return toMarkdown({ type: "doc", content: [block] });
    }
    kept.push(block);
    return `{{media ${kept.length}}}`;
  });
  if (parts.every((part) => part.startsWith("{{media ") || part.trim() === "")) {
    throw new OperationError(400, "nothing_to_rewrite", "There's no text the AI can edit there");
  }
  const notes = parts.filter(Boolean).join("\n\n");
  if (tokensIn(notes) > MAX_REWRITE_TOKENS) {
    throw new OperationError(400, "too_long", "That's too much text to edit with AI at once: select a shorter part");
  }

  const ai = await aiOrRefuse(projectId, "changelog", kind === "article" ? "help_center" : undefined);
  await countAiEdit(projectId);
  let reply: string;
  try {
    reply = await complete({
      ...rewritePrompt({ kind, task: "Edit this text as the team's instruction says.", text: notes, whole, instruction, style }),
      maxTokens: REPLY_TOKENS,
      ...ai,
    });
  } catch (error) {
    log.warn("AI rewrite failed", { projectId, kind, error });
    throw new OperationError(502, "ai_failed", "The AI couldn't edit the text. Try again in a moment.");
  }
  // Only the text's own links can be kept; any other loses its link and keeps its words.
  const links = [...factsIn(blocks).keys()].filter((key) => key.startsWith("link ")).map((key) => key.slice("link ".length));
  const rewritten = readNotes(reply, new Set(links), kept);
  if (!rewritten) {
    log.warn("AI rewrite unusable", { projectId, kind, reply: reply.slice(0, 500) });
    throw new OperationError(502, "ai_failed", "The AI's version couldn't be used. Try again.");
  }
  // Facts are checked, not trusted (as changelog.rewrite's).
  const unanswered = droppedMarkers({ type: "doc", content: blocks }, rewritten.doc);
  const dropped = [
    ...droppedFacts(blocks, rewritten.doc.content!),
    ...(unanswered.length > 0 ? [unanswered.length === 1 ? "a line still to fill in" : `${unanswered.length} lines still to fill in`] : []),
  ];
  const back = rewritten.doc.content!.filter((block) => kept.includes(block));
  if (dropped.length === 0 && (back.length !== kept.length || back.some((block, i) => block !== kept[i]))) {
    dropped.push("a part it had to keep as it is");
  }
  if (dropped.length > 0) {
    const list = dropped.length > 1 ? `${dropped.slice(0, -1).join(", ")} and ${dropped.at(-1)}` : dropped[0];
    throw new OperationError(502, "dropped_facts", `The AI's version left out ${list}, so it wasn't used. Try again.`);
  }
  // As JSON: the editor's attrs can be null-prototype objects, which React won't send back.
  return JSON.parse(JSON.stringify(await read(rewritten.doc))) as Doc;
}
