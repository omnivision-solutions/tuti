import { type PostVisibility, prisma } from "@tuti/db";
import { handlers, postAudience } from "@tuti/jobs";
import { isValidElement, type ReactNode } from "react";
import { expect, test, vi } from "vitest";

import { BackLink } from "@/components/back-link";
import { ListFilters } from "@/components/list-filters";
import { VisibilityBadge } from "@/components/visibility-badge";
import BoardPage from "@/app/portal/[project]/(site)/feedback/[board]/page";
import PostPage from "@/app/portal/[project]/(site)/feedback/[board]/[post]/page";
import RoadmapPage from "@/app/portal/[project]/(site)/roadmap/page";
import WidgetPage from "@/app/portal/[project]/widget/page";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { setBoardOff } from "./boards";
import { publishedEntries } from "./changelog-queries";
import { getChangelogEntry, listChangelog } from "./operations/changelog";
import { emailedOnCompletion } from "./operations/code-changes";
import { createComment, createPost } from "./operations/create";
import type { Actor } from "./operations/define";
import { updatePost } from "./operations/manage";
import { setSubscription, setVote } from "./operations/more";
import { getPost, getRoadmap, listBoards, listComments, listPosts, roadmapColumns } from "./operations/read";
import { call } from "./operations/run";
import { firstBoardPath, portalHomePath } from "./portal-home";
import { addSampleContent } from "./sample-content";
import { accountPosts, boardsWithCounts, postsLike, recentlyShipped, votersToEmail } from "./post-lists";
import { postViewer, SIGNED_OUT_VIEWER, TEAM_VIEWER } from "./post-visibility";
import { findSimilarPosts } from "./similar-posts";
import { widgetIdeas } from "./widget";
import { ideaNews } from "./widget-home";

/**
 * Private posts: a public post is everyone's, a private one its author's and the team's, a Team only one the team's;
 * its comments and votes go with it. Each place a post reaches someone off the team is checked here.
 */

/** The text of a page's tree (components in it aren't run); "404" for a page that's not found. */
async function rendered(page: Promise<unknown>): Promise<string> {
  const textOf = (node: ReactNode): string =>
    Array.isArray(node)
      ? node.map(textOf).join("")
      : isValidElement<{ children?: ReactNode }>(node)
        ? textOf(node.props.children)
        : typeof node === "string" || typeof node === "number"
          ? String(node)
          : "";
  return page.then(
    (node) => textOf(node as ReactNode),
    (error: { digest?: string }) => (error.digest === "NEXT_HTTP_ERROR_FALLBACK;404" ? "404" : Promise.reject(error)),
  );
}

/**
 * A project with three posts in Planned: Bob's public one, Ada's private bug (Bob voted for it and the team replied
 * before it was made private) and the team's own plan. Ada and Bob have verified addresses, so they could be emailed.
 */
async function fixture() {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  const [ada, bob] = await Promise.all([signUp("Ada"), signUp("Bob")]);
  await prisma.user.updateMany({ where: { id: { in: [ada.id, bob.id] } }, data: { emailVerified: true } });
  const board = project.boards[0]!;
  const post = (number: number, title: string, visibility: PostVisibility, author: TestUser) =>
    prisma.post.create({ data: { projectId, boardId: board.id, authorId: author.id, number, title, visibility, status: "PLANNED", voteCount: 1 } });
  const open = await post(1, "Dark mode for the editor", "PUBLIC", bob);
  const mine = await post(2, "Dark mode crashes the editor", "PRIVATE", ada);
  const plan = await post(3, "Dark mode for the editor rollout", "TEAM", owner);
  await prisma.project.update({ where: { id: projectId }, data: { postCount: 3 } });
  await prisma.vote.create({ data: { postId: mine.id, userId: bob.id, projectId } });
  await prisma.comment.create({ data: { postId: mine.id, authorId: owner.id, projectId, body: "We found the cause" } });
  const as = (user: TestUser) => ({ actor: { kind: "user", userId: user.id } as Actor, projectId });
  const key = { actor: { kind: "apiKey", keyId: "key", projectId, scope: "write", createdById: owner.id } as Actor, projectId };
  return { owner, ada, bob, project, board, open, mine, plan, as, key };
}

const numbers = (posts: { number: number }[]) => posts.map((post) => post.number).sort();

test("the API's posts, a post, its comments, the roadmap and the boards' counts: each caller sees only the posts they may", async () => {
  const { owner, ada, bob, as, key } = await fixture();
  // Bob: the public one; Ada: hers too; the team and its keys: all three.
  expect(numbers((await call(listPosts, as(bob), {})).posts)).toEqual([1]);
  expect(numbers((await call(listPosts, as(ada), {})).posts)).toEqual([1, 2]);
  expect(numbers((await call(listPosts, as(owner), {})).posts)).toEqual([1, 2, 3]);
  expect(numbers((await call(listPosts, key, {})).posts)).toEqual([1, 2, 3]);
  expect((await call(listPosts, key, { sort: "new" })).posts[0]).toMatchObject({ number: 3, visibility: "team" });

  // One they may not see is as missing as one that isn't there, and so are its comments.
  await expect(call(getPost, as(bob), { number: 2 })).rejects.toMatchObject({ status: 404 });
  await expect(call(getPost, as(ada), { number: 3 })).rejects.toMatchObject({ status: 404 });
  expect(await call(getPost, as(ada), { number: 2 })).toMatchObject({ title: "Dark mode crashes the editor", visibility: "private" });
  await expect(call(listComments, as(bob), { number: 2 })).rejects.toMatchObject({ status: 404 });
  expect((await call(listComments, as(ada), { number: 2 })).comments.map((c) => c.body)).toEqual(["We found the cause"]);

  expect(numbers((await call(getRoadmap, as(bob), {})).planned)).toEqual([1]);
  expect(numbers((await call(getRoadmap, key, {})).planned)).toEqual([1, 2, 3]);
  expect((await call(listBoards, as(bob), {})).boards).toEqual([{ slug: "feature-requests", name: "Feature requests", posts: 1, postVisibility: "public", off: false }]);
  expect((await call(listBoards, as(ada), {})).boards[0]!.posts).toBe(2);
});

test("nobody votes on, follows or comments on a post they may not see", async () => {
  const { ada, bob, as } = await fixture();
  for (const [user, number] of [[bob, 2], [ada, 3]] as const) {
    await expect(call(setVote, as(user), { number, voted: true })).rejects.toMatchObject({ status: 404 });
    await expect(call(setSubscription, as(user), { number, subscribed: true })).rejects.toMatchObject({ status: 404 });
    await expect(call(createComment, as(user), { number, body: "Me too" })).rejects.toMatchObject({ status: 404 });
  }
  // Their own private post: as any post.
  expect(await call(createComment, as(ada), { number: 2, body: "Still crashing" })).toMatchObject({ body: "Still crashing" });
});

test("a new post takes its board's visibility; only the team posts on a Team only board or picks another visibility", async () => {
  const { owner, bob, board, as, key } = await fixture();
  await prisma.board.update({ where: { id: board.id }, data: { postVisibility: "PRIVATE" } });
  expect(await call(createPost, as(bob), { board: board.slug, title: "Export fails" })).toMatchObject({ visibility: "private" });
  await expect(call(createPost, as(bob), { board: board.slug, title: "Export fails", visibility: "public" })).rejects.toMatchObject({ status: 403 });
  expect(await call(createPost, key, { board: board.slug, title: "Public roadmap item", visibility: "public" })).toMatchObject({ visibility: "public" });

  await prisma.board.update({ where: { id: board.id }, data: { postVisibility: "TEAM" } });
  await expect(call(createPost, as(bob), { board: board.slug, title: "Export fails" })).rejects.toMatchObject({ status: 404 });
  expect(await call(createPost, as(owner), { board: board.slug, title: "Security review" })).toMatchObject({ visibility: "team" });
});

test("the team changes a post's visibility; its votes and comments stay, and go where it goes", async () => {
  const { bob, mine, as, key } = await fixture();
  expect(await call(updatePost, key, { number: 2, visibility: "public" })).toMatchObject({ visibility: "public", votes: 1 });
  expect((await call(listComments, as(bob), { number: 2 })).comments).toHaveLength(1);
  await call(updatePost, key, { number: 2, visibility: "team" });
  await expect(call(listComments, as(bob), { number: 2 })).rejects.toMatchObject({ status: 404 });
  expect(await prisma.vote.count({ where: { postId: mine.id } })).toBe(1);
});

test("the portal's board, post page and roadmap show each reader the posts they may see; a Team only board is the team's", async () => {
  const { owner, ada, bob, project, mine } = await fixture();
  const board = (slug = "feature-requests") =>
    rendered(BoardPage({ params: Promise.resolve({ project: project.slug, board: slug }), searchParams: Promise.resolve({}) } as never));
  const post = (param: string) =>
    rendered(PostPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: param }), searchParams: Promise.resolve({}) } as never));
  const roadmap = () => rendered(RoadmapPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never));

  for (const [user, sees, hidden] of [
    [null, [], ["Dark mode crashes the editor", "rollout"]],
    [bob, [], ["Dark mode crashes the editor", "rollout"]],
    [ada, ["Dark mode crashes the editor"], ["rollout"]],
    [owner, ["Dark mode crashes the editor", "rollout"], []],
  ] as const) {
    actAs(user);
    for (const page of [await board(), await roadmap()]) {
      expect(page).toContain("Dark mode for the editor");
      sees.forEach((title) => expect(page).toContain(title));
      hidden.forEach((title) => expect(page).not.toContain(title));
    }
  }

  // On the roadmap her post is marked Private for her (and the team's own Team only one for the team): it reads as theirs.
  const badges = (node: ReactNode): string[] =>
    Array.isArray(node)
      ? node.flatMap(badges)
      : isValidElement<{ children?: ReactNode; visibility?: string }>(node)
        ? node.type === VisibilityBadge
          ? [node.props.visibility!]
          : badges(node.props.children)
        : [];
  const roadmapBadges = async () => badges((await RoadmapPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never)) as ReactNode);
  actAs(ada);
  expect(await roadmapBadges()).toEqual(expect.arrayContaining(["PRIVATE"]));
  actAs(owner);
  expect(await roadmapBadges()).toEqual(expect.arrayContaining(["PRIVATE", "TEAM"]));

  // Ada's post: hers and the team's, with its comment; not found for anyone else.
  for (const user of [null, bob]) {
    actAs(user);
    expect(await post("dark-mode-crashes-the-editor-2")).toBe("404");
    expect(await post("dark-mode-for-the-editor-rollout-3")).toBe("404");
  }
  actAs(ada);
  expect(await post("dark-mode-crashes-the-editor-2")).toContain("1 comment");
  expect(await post("dark-mode-for-the-editor-rollout-3")).toBe("404");
  // A post merged into it doesn't send people there (its address would say its title).
  await prisma.post.create({
    data: { projectId: project.id, boardId: mine.boardId, authorId: bob.id, number: 4, title: "Crash", duplicateOfId: mine.id },
  });
  actAs(bob);
  expect(await post("crash-4")).toBe("404");

  // A Team only board: not found for anyone else, the team's to read.
  await prisma.board.create({ data: { projectId: project.id, slug: "security", name: "Security", postVisibility: "TEAM" } });
  expect(await board("security")).toBe("404");
  // Its old address: not found for anyone else, sent on for the team.
  const security = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug: "security" } });
  await prisma.boardRedirect.create({ data: { projectId: project.id, boardId: security.id, slug: "security-old" } });
  expect(await board("security-old")).toBe("404");
  // Nor a choice on the roadmap: with one board left, there's nothing to pick.
  const roadmapFilters = async () => {
    const tree = await RoadmapPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never);
    const has = (node: ReactNode): boolean =>
      Array.isArray(node) ? node.some(has) : isValidElement<{ children?: ReactNode }>(node) && (node.type === ListFilters || has(node.props.children));
    return has(tree);
  };
  expect(await roadmapFilters()).toBe(false);
  actAs(owner);
  expect(await board("security")).not.toBe("404");
  expect(await roadmapFilters()).toBe(true);
  await expect(board("security-old")).rejects.toMatchObject({ digest: expect.stringContaining("/feedback/security;308") });
});

test("Similar ideas, typing suggestions, the widget's ideas and news, Account and Recently shipped leave out what a reader may not see", async () => {
  const { ada, bob, project, open, mine, as } = await fixture();
  const titles = (posts: { title: string }[]) => posts.map((post) => post.title).sort();
  const [bobViews, adaViews] = await Promise.all([postViewer(project.id, bob.id), postViewer(project.id, ada.id)]);

  expect(titles(await postsLike(project.id, open, bobViews, { open: true }))).toEqual([]);
  expect(titles(await postsLike(project.id, open, adaViews, { open: true }))).toEqual(["Dark mode crashes the editor"]);
  // With who sees each, and whose it is: the team's merge dialog warns from them.
  expect(await postsLike(project.id, open, adaViews, { open: true })).toEqual([expect.objectContaining({ visibility: "PRIVATE", authorId: ada.id })]);

  actAs(bob);
  expect(titles(await findSimilarPosts(project.slug, "Dark mode for the editor"))).toEqual(["Dark mode for the editor"]);
  expect(titles(await widgetIdeas(project.slug, null))).toEqual(["Dark mode for the editor"]);
  actAs(ada);
  expect(titles(await findSimilarPosts(project.slug, "Dark mode for the editor"))).toEqual(["Dark mode crashes the editor", "Dark mode for the editor"]);

  // Bob voted for Ada's post before it was private: not his news, nor in his Account, any more.
  await prisma.postEvent.createMany({ data: [open, mine].map((post) => ({ postId: post.id, from: "OPEN" as const, to: "PLANNED" as const })) });
  await call(setVote, as(bob), { number: 1, voted: true });
  expect(titles(await ideaNews(project.id, bob.id))).toEqual(["Dark mode for the editor"]);
  expect(titles((await accountPosts(project.id, bob.id, bobViews)).votes)).toEqual([]);
  expect((await boardsWithCounts(project.id, adaViews))[0]!._count.posts).toBe(2);
  // Made the team's own: not in its author's Account either.
  await prisma.post.update({ where: { id: mine.id }, data: { visibility: "TEAM" } });
  expect(titles((await accountPosts(project.id, ada.id, adaViews)).posts)).toEqual([]);

  await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "COMPLETED" } });
  expect(titles(await recentlyShipped(open.boardId, bobViews))).toEqual(["Dark mode for the editor"]);

  // Its board turned off: the public post is nobody else's either, wherever it would show.
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "PLANNED" } });
  await prisma.post.update({ where: { id: mine.id }, data: { visibility: "PRIVATE" } });
  expect(titles(await findSimilarPosts(project.slug, "Dark mode for the editor"))).toEqual(["Dark mode crashes the editor", "Dark mode for the editor"]);
  await prisma.board.update({ where: { id: open.boardId }, data: { off: true } });
  expect(titles(await findSimilarPosts(project.slug, "Dark mode for the editor"))).toEqual([]);
  expect(titles(await postsLike(project.id, open, adaViews, { open: true }))).toEqual([]);
  expect(titles(await ideaNews(project.id, bob.id))).toEqual([]);
  expect(titles(await widgetIdeas(project.slug, null))).toEqual([]);
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "COMPLETED" } });
  expect(titles(await recentlyShipped(open.boardId, bobViews))).toEqual([]);
  // The team's merge dialog warns from who sees each: Team only, on a board that's off.
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "PLANNED" } });
  expect(await postsLike(project.id, open, TEAM_VIEWER, { open: true })).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Dark mode crashes the editor", visibility: "TEAM" })]));
});

test("emails about a post reach only people who may see it: a private post's author, nobody about a Team only one", async () => {
  const { ada, bob, project, mine, plan } = await fixture();
  const settings = { portalAccess: "PUBLIC", plan: "FREE" as const };
  const told = async (post: { authorId: string; visibility: PostVisibility }, off = false) =>
    (await postAudience(project.id, settings, { ...post, board: { off } }, [ada.id, bob.id])).map((person) => person.id).sort();
  expect(await told({ ...mine, visibility: "PUBLIC" })).toEqual([ada.id, bob.id].sort());
  expect(await told(mine)).toEqual([ada.id]);
  expect(await told(plan)).toEqual([]);
  // On a board turned off, even a public one: nobody.
  expect(await told({ ...mine, visibility: "PUBLIC" }, true)).toEqual([]);
  // Email voters on Ada's post (Bob voted) reaches nobody; nor does completing it count Bob.
  expect(await votersToEmail(project.id, mine.id)).toBe(0);
  expect((await emailedOnCompletion(project.id, [mine.id])).get(mine.id)).toBe(1);
});

test("the changelog lists only an entry's public posts to readers; boards that are Team only stay off the sitemap, llms.txt and /feedback", async () => {
  const { bob, project, open, mine, as, key } = await fixture();
  const entry = await prisma.changelogEntry.create({
    data: { projectId: project.id, number: 1, title: "Dark mode", publishedAt: new Date(), posts: { create: [{ postId: open.id }, { postId: mine.id }] } },
  });
  expect((await publishedEntries(project.slug, { number: entry.number }))[0]!.posts.map((post) => post.number)).toEqual([1]);
  expect((await call(getChangelogEntry, as(bob), { number: 1 })).posts.map((post) => post.number)).toEqual([1]);
  expect((await call(getChangelogEntry, key, { number: 1 })).posts.map((post) => post.number).sort()).toEqual([1, 2]);
  expect((await call(listChangelog, as(bob), {})).entries[0]!.posts.map((post) => post.number)).toEqual([1]);
  expect((await call(listChangelog, key, {})).entries[0]!.posts.map((post) => post.number).sort()).toEqual([1, 2]);
  // Its public post on a board turned off: gone from what readers see of the entry, there for the team.
  await prisma.board.update({ where: { id: open.boardId }, data: { off: true } });
  expect((await publishedEntries(project.slug, { number: entry.number }))[0]!.posts).toEqual([]);
  expect((await call(getChangelogEntry, as(bob), { number: 1 })).posts).toEqual([]);
  expect((await call(getChangelogEntry, key, { number: 1 })).posts.map((post) => post.number).sort()).toEqual([1, 2]);
  await prisma.board.update({ where: { id: open.boardId }, data: { off: false } });

  // A Team only board, older than the rest: never the portal's first.
  await prisma.board.create({ data: { projectId: project.id, slug: "security", name: "Security", postVisibility: "TEAM", createdAt: new Date(0) } });
  expect(await firstBoardPath(project.slug)).toBe("/feedback/feature-requests");
  // The widget's Feedback tab posts on the portal's first board too.
  const widgetBoard = async () => {
    const find = (node: ReactNode): string | undefined =>
      Array.isArray(node)
        ? node.map(find).find(Boolean)
        : isValidElement<{ board?: { slug: string }; children?: ReactNode }>(node)
          ? (node.props.board?.slug ?? find(node.props.children))
          : undefined;
    return find((await WidgetPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({ tab: "feedback" }) } as never)) as ReactNode);
  };
  actAs(null);
  expect(await widgetBoard()).toBe("feature-requests");
  expect((await boardsWithCounts(project.id, SIGNED_OUT_VIEWER)).map((board) => board.slug)).toEqual(["feature-requests"]);
  const request = new Request("http://x");
  const map = await (await sitemap(request, { params: Promise.resolve({ project: project.slug }) })).text();
  expect(map).toContain("/feedback/feature-requests/dark-mode-for-the-editor-1");
  expect(map).not.toContain("dark-mode-crashes-the-editor");
  expect(map).not.toContain("rollout");
  expect(map).not.toContain("/feedback/security");
  expect(await (await llms(request, { params: Promise.resolve({ project: project.slug }) })).text()).not.toContain("Security");
});

test("sample content takes its board's visibility, as any new post", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  await prisma.board.update({ where: { id: project.boards[0]!.id }, data: { postVisibility: "TEAM" } });
  await addSampleContent(project.id, owner.id);
  const posts = await prisma.post.findMany({ where: { projectId: project.id }, select: { visibility: true } });
  expect(posts.length).toBeGreaterThan(0);
  expect(posts.every((post) => post.visibility === "TEAM")).toBe(true);
});

/** Runs `run` with the post made `visibility` as the job claims its first email (after it read who to tell). */
async function changedAtFirstClaim(postId: string, visibility: PostVisibility | "board off", run: () => Promise<unknown>) {
  const transaction = prisma.$transaction.bind(prisma);
  let claims = 0;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: Parameters<typeof transaction>) => {
    if (++claims === 1) {
      if (visibility === "board off") {
        await prisma.board.updateMany({ where: { posts: { some: { id: postId } } }, data: { off: true } });
      } else {
        await prisma.post.update({ where: { id: postId }, data: { visibility } });
      }
    }
    return transaction(...args);
  }) as never);
  try {
    await expect(run()).rejects.toThrow(/visibility changed/);
  } finally {
    spy.mockRestore();
  }
}
const log = { info: () => {}, warn: () => {} };

test("a post made private while its shipped email goes out isn't emailed to anyone who may no longer see it", async () => {
  const { ada, mine } = await fixture();
  // Ada's post, public and just completed: Ada (its author) and Bob (a voter) are to be told.
  await prisma.post.update({ where: { id: mine.id }, data: { visibility: "PUBLIC", status: "COMPLETED", shippedEmailsDueAt: new Date() } });
  await changedAtFirstClaim(mine.id, "PRIVATE", () => handlers.postShipped({ postId: mine.id }, log));
  // Nobody emailed on the old audience; run again, it emails only who may see it now: Ada, not Bob.
  expect(await prisma.shippedEmail.count({ where: { postId: mine.id } })).toBe(0);
  await handlers.postShipped({ postId: mine.id }, log);
  const told = await prisma.shippedEmail.findMany({ where: { postId: mine.id, sentAt: { not: null } }, select: { userId: true } });
  expect(told.map((row) => row.userId)).toEqual([ada.id]);
});

test("a post made private while the team's reply is emailed to its voters isn't emailed to a voter who may no longer see it", async () => {
  const { mine } = await fixture();
  // The team's reply on Ada's post, public then: Bob (a voter) is to be emailed it.
  await prisma.post.update({ where: { id: mine.id }, data: { visibility: "PUBLIC" } });
  const reply = await prisma.comment.findFirstOrThrow({ where: { postId: mine.id } });
  await prisma.comment.update({ where: { id: reply.id }, data: { votersEmailDueAt: new Date() } });
  await changedAtFirstClaim(mine.id, "PRIVATE", () => handlers.replyEmailed({ commentId: reply.id }, log));
  await handlers.replyEmailed({ commentId: reply.id }, log);
  expect(await prisma.replyEmail.count({ where: { commentId: reply.id } })).toBe(0);
});

test("a board turned off while a post's shipped email or the team's reply goes out: nobody is emailed", async () => {
  const { mine } = await fixture();
  await prisma.post.update({ where: { id: mine.id }, data: { visibility: "PUBLIC", status: "COMPLETED", shippedEmailsDueAt: new Date() } });
  await changedAtFirstClaim(mine.id, "board off", () => handlers.postShipped({ postId: mine.id }, log));
  await handlers.postShipped({ postId: mine.id }, log);
  expect(await prisma.shippedEmail.count({ where: { postId: mine.id, sentAt: { not: null } } })).toBe(0);

  await prisma.board.updateMany({ data: { off: false } });
  const reply = await prisma.comment.findFirstOrThrow({ where: { postId: mine.id } });
  await prisma.comment.update({ where: { id: reply.id }, data: { votersEmailDueAt: new Date() } });
  await changedAtFirstClaim(mine.id, "board off", () => handlers.replyEmailed({ commentId: reply.id }, log));
  await handlers.replyEmailed({ commentId: reply.id }, log);
  expect(await prisma.replyEmail.count({ where: { commentId: reply.id } })).toBe(0);
});

test("turning a board off drops emails still due about its posts; completing one there again drops an earlier completion's", async () => {
  const { owner, open, board, project, as, key } = await fixture();
  // Hatchet, unreachable: the emails' jobs aren't queued, and their due times wait for the resubmit cron.
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  vi.stubEnv("HATCHET_CLIENT_TOKEN", "");
  await call(updatePost, key, { number: 1, status: "completed" });
  const reply = await call(createComment, as(owner), { number: 1, body: "Shipped", emailVoters: true });
  const due = async () => ({
    shipped: (await prisma.post.findUniqueOrThrow({ where: { id: open.id }, select: { shippedEmailsDueAt: true } })).shippedEmailsDueAt !== null,
    reply: (await prisma.comment.findUniqueOrThrow({ where: { id: reply.id }, select: { votersEmailDueAt: true } })).votersEmailDueAt !== null,
  });
  expect(await due()).toEqual({ shipped: true, reply: true });
  actAs(owner);
  expect(await setBoardOff(project.slug, board.id, true)).toEqual({});
  expect(await due()).toEqual({ shipped: false, reply: false });

  // Completed while on (still due), reopened, then completed again on a board turned off: the earlier due time goes.
  await prisma.board.update({ where: { id: board.id }, data: { off: false } });
  await call(updatePost, key, { number: 1, status: "planned" });
  await call(updatePost, key, { number: 1, status: "completed" });
  expect((await due()).shipped).toBe(true);
  await call(updatePost, key, { number: 1, status: "planned" });
  await prisma.board.update({ where: { id: board.id }, data: { off: true } });
  await call(updatePost, key, { number: 1, status: "completed" });
  expect((await due()).shipped).toBe(false);
  vi.unstubAllEnvs();
});

test("a portal whose boards are all the team's opens on its changelog", async () => {
  const { project } = await fixture();
  await prisma.board.updateMany({ where: { projectId: project.id }, data: { postVisibility: "TEAM" } });
  expect(await portalHomePath(project.slug)).toBe("/changelog");
});

test("a public post on a Team only board leads readers back to the portal's feedback, not to the board they can't open", async () => {
  const { owner, project, open } = await fixture();
  await prisma.board.update({ where: { id: open.boardId }, data: { postVisibility: "TEAM" } });
  const backLink = async () => {
    const find = (node: ReactNode): string | undefined =>
      Array.isArray(node)
        ? node.map(find).find(Boolean)
        : isValidElement<{ children?: ReactNode; href?: string }>(node)
          ? node.type === BackLink
            ? node.props.href
            : find(node.props.children)
          : undefined;
    return find((await PostPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: "dark-mode-for-the-editor-1" }), searchParams: Promise.resolve({}) } as never)) as ReactNode);
  };
  // Its only board is the team's: back to the portal's home.
  actAs(null);
  expect(await backLink()).toMatch(/\/$/);
  // Another board on the portal: back to its feedback.
  await prisma.board.create({ data: { projectId: project.id, slug: "ideas", name: "Ideas" } });
  expect(await backLink()).toMatch(/\/feedback$/);
  actAs(owner);
  expect(await backLink()).toMatch(/\/feedback\/feature-requests$/);
});

test("a board turned off is the team's: its posts, public ones too, are nobody else's to see, vote on, post to or be emailed about", async () => {
  const { owner, bob, project, board, open, as, key } = await fixture();
  await prisma.board.update({ where: { id: board.id }, data: { off: true } });
  expect(numbers((await call(listPosts, as(bob), {})).posts)).toEqual([]);
  // Named, too: a board filter of the caller's own never takes the off check's place.
  expect(numbers((await call(listPosts, as(bob), { board: board.slug })).posts)).toEqual([]);
  expect(numbers((await call(listPosts, key, {})).posts)).toEqual([1, 2, 3]);
  // The API and webhooks say who sees it now: the team only, though it's public on a board that's on.
  expect(await call(getPost, key, { number: 1 })).toMatchObject({ visibility: "team" });
  expect((await call(listBoards, key, {})).boards).toEqual([expect.objectContaining({ off: true, postVisibility: "public" })]);
  await expect(call(getPost, as(bob), { number: 1 })).rejects.toMatchObject({ status: 404 });
  await expect(call(setVote, as(bob), { number: 1, voted: true })).rejects.toMatchObject({ status: 404 });
  await expect(call(createPost, as(bob), { board: board.slug, title: "Export fails" })).rejects.toMatchObject({ status: 404 });
  expect((await call(listBoards, as(bob), {})).boards).toEqual([]);
  expect((await call(listBoards, as(owner), {})).boards).toHaveLength(1);
  expect(numbers((await call(getRoadmap, as(bob), {})).planned)).toEqual([]);
  expect(await votersToEmail(project.id, open.id)).toBe(0);
  expect((await emailedOnCompletion(project.id, [open.id])).get(open.id) ?? 0).toBe(0);

  actAs(bob);
  const page = (path: Promise<unknown>) => rendered(path);
  expect(await page(BoardPage({ params: Promise.resolve({ project: project.slug, board: board.slug }), searchParams: Promise.resolve({}) } as never))).toBe("404");
  expect(await page(PostPage({ params: Promise.resolve({ project: project.slug, board: board.slug, post: "dark-mode-for-the-editor-1" }), searchParams: Promise.resolve({}) } as never))).toBe("404");
  actAs(owner);
  expect(await page(PostPage({ params: Promise.resolve({ project: project.slug, board: board.slug, post: "dark-mode-for-the-editor-1" }), searchParams: Promise.resolve({}) } as never))).not.toBe("404");

  // Completed or answered while off, nothing is left due to email: turning the board on later tells nobody, even when
  // the emails' jobs couldn't be queued (Hatchet, unreachable) and wait for the resubmit cron.
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  vi.stubEnv("HATCHET_CLIENT_TOKEN", "");
  await call(updatePost, key, { number: 1, status: "completed" });
  const reply = await call(createComment, as(owner), { number: 1, body: "Shipped", emailVoters: true });
  vi.unstubAllEnvs();
  expect(await prisma.post.findUniqueOrThrow({ where: { id: open.id }, select: { shippedEmailsDueAt: true } })).toEqual({ shippedEmailsDueAt: null });
  expect(await prisma.comment.findUniqueOrThrow({ where: { id: reply.id }, select: { votersEmailDueAt: true } })).toEqual({ votersEmailDueAt: null });
  await prisma.post.update({ where: { id: open.id }, data: { status: "PLANNED" } });

  // Turned on again, its public post is everyone's once more; and the roadmap's board filter still narrows to a board.
  await prisma.board.update({ where: { id: board.id }, data: { off: false } });
  expect(numbers((await call(listPosts, as(bob), {})).posts)).toEqual([1]);
  const bugs = await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  await prisma.post.create({ data: { projectId: project.id, boardId: bugs.id, authorId: owner.id, number: 4, title: "Crash on save", status: "PLANNED" } });
  const viewer = { team: false, userId: bob.id };
  expect(numbers((await roadmapColumns(project.id, viewer, { board: "bugs" }))[0]!)).toEqual([4]);
  expect(numbers((await roadmapColumns(project.id, viewer, { board: board.slug }))[0]!)).toEqual([1]);
});
