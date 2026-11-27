"use server";

import { prisma } from "@tuti/db";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { MAX_PICKED_PULL_REQUESTS } from "@/lib/added-pull-requests";
import type { Reaction } from "@/lib/reactions";

import type { CoverDesign } from "./cover-card";
import type { FormState } from "./form-state";
import { getMembership } from "./membership";
import type { RewriteMode } from "./release-notes";
import {
  composeChangelogCover as composeCoverOperation,
  composeCover,
  addChangelogPullRequests as addPullRequestsOperation,
  addedAnalysisCost,
  MAX_ADDED_PULL_REQUESTS,
  createChangelogEntry,
  deleteChangelogEntry as deleteOperation,
  draftChangelogEntry as draftOperation,
  listMissingChanges,
  publishChangelogEntry as publishOperation,
  reactToChangelogEntry as reactOperation,
  removeChangelogPullRequest as removePullRequestOperation,
  rewriteChangelogEntry as rewriteOperation,
  unpublishChangelogEntry as unpublishOperation,
  updateChangelogEntry,
  updateChangelogStyle,
} from "./operations/changelog";
import { takeChangelogScreenshots as takeScreenshotsOperation } from "./operations/screenshots";
import { saveChangelogTranslation } from "./operations/changelog-translations";
import {
  createChangelogComment as createCommentOperation,
  deleteChangelogComment as deleteCommentOperation,
  updateChangelogComment as updateCommentOperation,
} from "./operations/changelog-comments";
import { OperationError } from "./operations/define";
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
    // Only where the form offers groups (the project has some), so a save never clears ones set by the API otherwise.
    groups: formData.has("groupsEditable") ? formData.getAll("groups").map(String) : undefined,
    // Likewise only once changed (WhoSeesIt), so a save never undoes one set meanwhile.
    emailOnly: formData.has("emailOnlyEditable") ? formData.get("emailOnly") === "1" : undefined,
    // Published entries show their posts read-only, so the form doesn't send them.
    posts: formData.has("postsEditable") ? formData.getAll("posts").map(Number) : undefined,
    // The cover's upload id, empty once removed (no field: uploads aren't set up, so it stays as it is).
    cover: formData.has("cover") ? String(formData.get("cover")) || null : undefined,
    // The saved version the form's text was shown from: a save is refused, not putting their lines back, if screenshots
    // went in since (changelog.takeScreenshots).
    screenshotsSince: String(formData.get("screenshotsSeenAt") ?? "") || undefined,
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

/**
 * Saves an entry's version in another language from its editor (the language pill): its title and text, against the
 * `version` it was read at (the form's). Saving stops Keep up to date (changelog.saveTranslation).
 */
export async function saveChangelogVersion(projectSlug: string, number: number, language: string, _state: FormState, formData: FormData): Promise<FormState> {
  const result = await asTeam(projectSlug, DENIED, (context) =>
    call(saveChangelogTranslation, context, {
      number,
      language: language as "de",
      title: String(formData.get("title") ?? ""),
      content: formData.get("content") || undefined,
      version: String(formData.get("version") ?? ""),
    }),
  );
  if (!result.error) {
    refresh();
  }
  return result;
}

/** Keep up to date on an entry's version (it's translated again) or off. */
export async function keepChangelogVersionUpToDate(projectSlug: string, number: number, language: string, on: boolean): Promise<FormState> {
  const result = await asTeam(projectSlug, DENIED, (context) => call(saveChangelogTranslation, context, { number, language: language as "de", keepUpToDate: on === true }));
  if (!result.error) {
    refresh();
  }
  return result;
}

/** The posts "Link post…" offers an entry for what's typed: planned, in progress or completed ones (searchPosts); sample ones for a sample entry, the others for the rest. */
export async function findPostsToComplete(projectSlug: string, q: string, sampleEntry = false) {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: DENIED };
  }
  return { posts: await searchPosts(membership.project.id, q, { status: { in: ["PLANNED", "IN_PROGRESS", "COMPLETED"] }, sample: sampleEntry }) };
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

/**
 * Publishes an entry (see changelog.publish). With `cover` (the design picked in the Publish dialog, for an entry with
 * no cover), that cover is composed and set first: if it can't be, nothing is published.
 */
export async function publishChangelogEntry(projectSlug: string, number: number, announce = true, emailSubscribers = false, cover?: CoverDesign): Promise<FormState> {
  return asTeam(projectSlug, DENIED, async (context) => {
    // Only for a draft that still has no cover when it's set: one a teammate added since the dialog opened stays, and an
    // entry published meanwhile is left as it went out.
    if (cover !== undefined) {
      // Checked as changelog.composeCover's input is: the design comes from the browser.
      const input = composeCoverOperation.input.safeParse({ number: Number(number), design: String(cover) });
      if (!input.success) {
        throw new OperationError(400, "invalid_input", input.error.issues[0]?.message ?? "Invalid input");
      }
      await composeCover(context, input.data, { ifBare: true }).catch((error: unknown) => {
        // Picked for them unless they chose: say how to publish without it.
        if (error instanceof OperationError && error.code === "no_room") {
          throw new OperationError(409, "no_room", `${error.message}. Pick No cover to publish without one.`);
        }
        throw error;
      });
    }
    await call(publishOperation, context, { number: Number(number), announce: announce === true, emailSubscribers: emailSubscribers === true });
  });
}

/** Composes a cover for the saved entry in a design, with a headline in its title's place if one's given, and sets it (see changelog.composeCover). */
export async function composeChangelogCover(projectSlug: string, number: number, design: CoverDesign, headline = ""): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(composeCoverOperation, context, { number: Number(number), design: String(design) as CoverDesign, headline: String(headline) || undefined }),
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

export type MissingChanges = Awaited<ReturnType<(typeof listMissingChanges)["run"]>> & { cost: Awaited<ReturnType<typeof addedAnalysisCost>> };

/** What "Add changes…" lists: the merged pull requests no entry has (see changelog.missingChanges), and what adding them costs. */
export async function findMissingChanges(projectSlug: string): Promise<{ error?: string; missing?: MissingChanges }> {
  let missing: MissingChanges | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    const [found, cost] = await Promise.all([call(listMissingChanges, context, {}), addedAnalysisCost(context.projectId)]);
    missing = { ...found, cost };
  });
  return missing ? { missing } : result;
}

/** Adds merged pull requests to the running draft (see changelog.addPullRequests): its number, and how many went in. */
export async function addChangelogPullRequests(
  projectSlug: string,
  pullRequests: { repo: string; number: number }[],
): Promise<{ error?: string; number?: number | null; added?: number }> {
  let added: { number: number | null; added: number } | undefined;
  const result = await asTeam(projectSlug, DENIED, async (context) => {
    // The dialog can tick more than one request takes: in batches, into the same running draft. Still a request's worth
    // of work at most: none is refused as the operation refuses it, and no more than the dialog could list.
    if (pullRequests.length === 0 || pullRequests.length > MAX_PICKED_PULL_REQUESTS) {
      throw new OperationError(400, "invalid_input", pullRequests.length === 0 ? "Pick a pull request to add" : `Add up to ${MAX_PICKED_PULL_REQUESTS} pull requests at a time`);
    }
    for (let i = 0; i < pullRequests.length; i += MAX_ADDED_PULL_REQUESTS) {
      const done = await call(addPullRequestsOperation, context, { pullRequests: pullRequests.slice(i, i + MAX_ADDED_PULL_REQUESTS) });
      added = { number: done.number ?? added?.number ?? null, added: (added?.added ?? 0) + done.added.length };
    }
  });
  // A later batch refused: said, with what the ones before it added (they stay, so the page reloads with them, as it
  // does after a success: its form would otherwise save the text from before over them).
  if (result.error && added?.added) {
    refresh();
  }
  return result.error ? { ...result, ...(added && { number: added.number, added: added.added }) } : (added ?? result);
}

/** Takes a merged pull request out of a draft, with its line (see changelog.removePullRequest). */
export async function removeChangelogPullRequest(projectSlug: string, number: number, url: string): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) => call(removePullRequestOperation, context, { number: Number(number), url: String(url) }));
}

/** The entry editor's "Take screenshots" (changelog.takeScreenshots): the "[Screenshot: …]" lines it listed and the admin confirmed, filled in the background. */
export async function takeChangelogScreenshots(projectSlug: string, number: number, shows: string[]): Promise<FormState> {
  const shots = (Array.isArray(shows) ? shows : []).map((show) => ({ show: String(show) }));
  return asAdmin(projectSlug, "Only project owners and admins can take screenshots", (context) => call(takeScreenshotsOperation, context, { number: Number(number), shots }));
}

/** Saves Settings → Changelog's form: instructions (stored as tone notes), the published entries picked as examples, the screenshots' markers and the cover's defaults (see changelogStyle.update). */
export async function saveChangelogStyle(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  // Without AI, the form has the cover only: what drafts follow stays as it is.
  const drafting = formData.has("tone");
  const input = {
    ...(drafting && {
      tone: String(formData.get("tone")),
      examples: formData.getAll("examples").map(Number),
      screenshotMarkers: formData.get("screenshotMarkers") === "on",
    }),
    coverDesign: String(formData.get("coverDesign") ?? "") as CoverDesign | "",
    coverBackground: String(formData.get("coverBackground") ?? "") || null,
  };
  // A setting (Settings → Changelog), like AI answers: owners and admins.
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

const entryProject = (projectSlug: string) => () => prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true } });
const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
};

/** A reader's comment on a published entry, from its portal page (see changelogComments.create). */
export async function commentOnChangelogEntry(projectSlug: string, number: number, _prev: FormState, formData: FormData): Promise<FormState> {
  return asAnyone("Sign in to comment", "Entry not found", entryProject(projectSlug), (context) =>
    call(createCommentOperation, context, { number: Number(number), content: field(formData, "content") || undefined, body: field(formData, "body") }),
  );
}

/** Its author's edit of their comment on an entry (see changelogComments.update). */
export async function editChangelogComment(projectSlug: string, number: number, id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  return asAnyone("Sign in to edit your comment", "Entry not found", entryProject(projectSlug), (context) =>
    call(updateCommentOperation, context, { number: Number(number), id: String(id), content: field(formData, "content") || undefined, body: field(formData, "body") }),
  );
}

/** Deletes a comment on an entry: its author's own, or any for the team in the app (see changelogComments.delete). */
export async function deleteChangelogComment(projectSlug: string, number: number, id: string): Promise<FormState> {
  return asAnyone("Sign in to delete your comment", "Entry not found", entryProject(projectSlug), (context) =>
    call(deleteCommentOperation, context, { number: Number(number), id: String(id) }),
  );
}
