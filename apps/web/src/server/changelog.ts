"use server";

import { prisma } from "@tuti/db";
import { redirect } from "next/navigation";

import type { Reaction } from "@/lib/reactions";

import type { FormState } from "./form-state";
import { getMembership } from "./membership";
import type { RewriteMode } from "./release-notes";
import {
  createChangelogEntry,
  deleteChangelogEntry as deleteOperation,
  draftChangelogEntry as draftOperation,
  publishChangelogEntry as publishOperation,
  reactToChangelogEntry as reactOperation,
  rewriteChangelogEntry as rewriteOperation,
  unpublishChangelogEntry as unpublishOperation,
  updateChangelogEntry,
  updateChangelogStyle,
} from "./operations/changelog";
import { asAdmin, asAnyone, asTeam, call } from "./operations/run";
import { searchPosts } from "./post-lists";
import { getSession } from "./session";

/** The changelog actions: the team's, and readers' reactions (see the changelog.* operations). */

const DENIED = "Only the project's team can write the changelog";

/** Saves the editor's form: a new draft when `number` is null (then opens it), or changes to entry `number`. */
export async function saveChangelogEntry(
  projectSlug: string,
  number: number | null,
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const input = {
    title: String(formData.get("title") ?? ""),
    content: formData.get("content") || undefined,
    body: formData.get("content") ? undefined : "",
    tags: formData.getAll("tags").map(String) as ("new" | "improved" | "fixed" | "breaking")[],
    // Published entries show their posts read-only, so the form doesn't send them.
    posts: formData.has("postsEditable") ? formData.getAll("posts").map(Number) : undefined,
  };
  let created: number | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    if (number === null) {
      created = (await call(createChangelogEntry, context, input)).number;
    } else {
      await call(updateChangelogEntry, context, { number, ...input });
    }
  });
  if (created !== undefined) {
    redirect(`/app/${projectSlug}/changelog/${created}`);
  }
  return result;
}

/** The posts "Link post…" offers an entry for what's typed: planned, in progress or completed ones (searchPosts). */
export async function findPostsToComplete(projectSlug: string, q: string) {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: DENIED };
  }
  return { posts: await searchPosts(membership.project.id, q, { status: { in: ["PLANNED", "IN_PROGRESS", "COMPLETED"] } }) };
}

/** Replaces a draft's text with an AI draft (see changelog.draft). */
export async function draftChangelogEntry(projectSlug: string, number: number): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(draftOperation, context, { number: Number(number) }));
}

export type ChangelogRewrite = Awaited<ReturnType<(typeof rewriteOperation)["run"]>>;

/** An AI edit of the saved text, proposed, not saved (see changelog.rewrite). */
export async function rewriteChangelogEntry(
  projectSlug: string,
  number: number,
  input: { mode: RewriteMode; section?: number; instruction?: string },
): Promise<{ error?: string; rewrite?: ChangelogRewrite }> {
  let rewrite: ChangelogRewrite | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    // As JSON: the document's attrs come from ProseMirror as null-prototype objects, which React won't send.
    rewrite = JSON.parse(JSON.stringify(await call(rewriteOperation, context, { ...input, number: Number(number) }))) as ChangelogRewrite;
  });
  return rewrite ? { rewrite } : result;
}

/** Saves an accepted AI edit, unless the entry changed since it was proposed (see changelog.update). */
export async function acceptChangelogRewrite(
  projectSlug: string,
  number: number,
  content: unknown,
  expectedUpdatedAt: string,
): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(updateChangelogEntry, context, { number: Number(number), content, expectedUpdatedAt: String(expectedUpdatedAt) }),
  );
}

export async function publishChangelogEntry(projectSlug: string, number: number, announce = true): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(publishOperation, context, { number: Number(number), announce: announce === true }),
  );
}

export async function unpublishChangelogEntry(projectSlug: string, number: number): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(unpublishOperation, context, { number: Number(number) }));
}

export async function deleteChangelogEntry(projectSlug: string, number: number): Promise<FormState> {
  const result = await asTeam(projectSlug, DENIED, (context) => call(deleteOperation, context, { number: Number(number) }));
  if (!result.error) {
    redirect(`/app/${projectSlug}/changelog`);
  }
  return result;
}

/** Saves the writing style form: tone notes and the published entries picked as examples (see changelogStyle.update). */
export async function saveChangelogStyle(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const input = { tone: String(formData.get("tone") ?? ""), examples: formData.getAll("examples").map(Number) };
  // A setting (Settings → Writing style), like AI answers: owners and admins.
  return asAdmin(projectSlug, "Only project owners and admins can change the writing style", (context) => call(updateChangelogStyle, context, input));
}

/** A reader's reaction to a published entry on the portal, or taking it back (see changelog.react). */
export async function reactToChangelogEntry(
  projectSlug: string,
  number: number,
  reaction: Reaction,
  reacted: boolean,
): Promise<FormState> {
  return asAnyone(
    "Sign in to react",
    "Entry not found",
    () => prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } }),
    (context) => call(reactOperation, context, { number: Number(number), reaction, reacted: reacted === true }),
  );
}
