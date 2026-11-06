import { type PostVisibility, Prisma } from "@tuti/db";

import type { Actor } from "./operations/define";
import { onTeam } from "./session";

/**
 * Private posts (PostVisibility in the schema): who sees a post besides the team. Public: everyone who may read the
 * portal; Private: its author; Team only: nobody. Its comments, votes and voters go with it: whoever can't see the post
 * sees none of them, and isn't emailed about it (postAudience). Every reader of posts outside the team's app narrows
 * by these; the team (and API keys, which act for it) sees every post.
 *
 * Not a "use server" module: its exports must never be callable from browsers.
 */

/** Who's looking: the project's team (every post), or someone else (`userId`; null signed out). */
export type PostViewer = { team: boolean; userId: string | null };

/** The team, or an API key: every post. */
export const TEAM_VIEWER: PostViewer = { team: true, userId: null };

/** Signed out (search engines, the sitemap, RSS): public posts only. */
export const SIGNED_OUT_VIEWER: PostViewer = { team: false, userId: null };

/** Visibilities as the API and forms spell them. */
export const VISIBILITIES = ["public", "private", "team"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const toApiVisibility = (visibility: PostVisibility) => visibility.toLowerCase() as Visibility;
export const fromApiVisibility = (visibility: Visibility) => visibility.toUpperCase() as PostVisibility;

/** The posts `viewer` may see, for a Prisma `where` (use it under `AND` where the query has an `OR` of its own). */
export function visiblePosts(viewer: PostViewer): Prisma.PostWhereInput {
  if (viewer.team) {
    return {};
  }
  return { OR: [{ visibility: "PUBLIC" }, ...(viewer.userId ? [{ visibility: "PRIVATE" as const, authorId: viewer.userId }] : [])] };
}

/** visiblePosts in SQL, for a post aliased `p`. */
export function visiblePostsSql(viewer: PostViewer): Prisma.Sql {
  if (viewer.team) {
    return Prisma.sql`TRUE`;
  }
  return viewer.userId
    ? Prisma.sql`(p.visibility = 'PUBLIC' OR (p.visibility = 'PRIVATE' AND p."authorId" = ${viewer.userId}))`
    : Prisma.sql`p.visibility = 'PUBLIC'`;
}

/** Whether `viewer` may see this post (visiblePosts's rule, for one already read). */
export function canSeePost(viewer: PostViewer, post: { visibility: PostVisibility; authorId: string }): boolean {
  return viewer.team || post.visibility === "PUBLIC" || (post.visibility === "PRIVATE" && !!viewer.userId && post.authorId === viewer.userId);
}

/** The boards `viewer` sees on the portal: a Team only board is the team's (only the team posts there). */
export function shownBoards(viewer: PostViewer): Prisma.BoardWhereInput {
  return viewer.team ? {} : { postVisibility: { not: "TEAM" } };
}

/** The boards the portal lists (its menus, sitemap, llms.txt, the first board, the widget's): never a Team only one. */
export const PORTAL_BOARDS = shownBoards(SIGNED_OUT_VIEWER);

/** Someone (null: signed out) as a viewer of the project's posts: the team if they're on it (onTeam: never with a portal's session). */
export async function postViewer(projectId: string, userId: string | null | undefined): Promise<PostViewer> {
  if (!userId) {
    return SIGNED_OUT_VIEWER;
  }
  return { team: await onTeam(projectId, userId), userId };
}

/** An operation's caller as a viewer: API keys act for the team. */
export function actorPostViewer(actor: Actor, projectId: string): Promise<PostViewer> {
  return actor.kind === "apiKey" ? Promise.resolve(TEAM_VIEWER) : postViewer(projectId, actor.userId);
}
