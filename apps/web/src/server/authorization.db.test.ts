import { readdirSync, readFileSync } from "node:fs";

import { type TeamRole, prisma } from "@tuti/db";
import { SignJWT } from "jose";
import {
  type ModelFake,
  type S3Fake,
  startModelFake,
  startS3Fake,
  startWebhookReceiver,
  type WebhookReceiver,
} from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { hashInvitationToken } from "@/lib/invitations";
import { generateSsoSecret } from "@/lib/sso";
import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import * as apiKeys from "./api-keys";
import * as boards from "./boards";
import * as changelog from "./changelog";
import * as github from "./github";
import * as invitations from "./invitations";
import * as managePosts from "./manage-posts";
import * as media from "./media";
import * as portalHandoff from "./portal-handoff";
import * as posts from "./posts";
import * as projects from "./projects";
import * as similarPosts from "./similar-posts";
import * as ssoSettings from "./sso-settings";
import * as team from "./team";
import * as webhooks from "./webhooks";
import * as widget from "./widget";

/**
 * Every server action, who may call it, and a valid call. The type lists each
 * module's exports, so a new action doesn't compile until it's added here, and
 * the first test fails for a new "use server" file that isn't imported above.
 *
 * Each action must refuse everyone below its level (signed out, other
 * projects' teams, lower roles) without changing anything, and work for the
 * lowest level allowed (so the refusals aren't just bad arguments).
 */
const modules = {
  changelog,
  "api-keys": apiKeys,
  boards,
  github,
  invitations,
  "manage-posts": managePosts,
  media,
  "portal-handoff": portalHandoff,
  posts,
  projects,
  "similar-posts": similarPosts,
  "sso-settings": ssoSettings,
  team,
  webhooks,
  widget,
};

type Level = "public" | "signed in" | TeamRole;

type Case = {
  allowed: Level;
  /** Takes ids of the project's records: another project's team must not reach them through their own slug. */
  takesIds?: true;
  /** Users who signed in through another project's SSO can't do this (they only exist on that portal). */
  refusesSsoUsers?: true;
  /** Runs before the allowed call only (e.g. scripting the model's reply). */
  before?: () => void;
  call: (slug: string, fixture: Fixture) => Promise<unknown>;
};

type Matrix = { [M in keyof typeof modules]: { [A in keyof (typeof modules)[M]]: Case } };

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};

const matrix: Matrix = {
  "api-keys": {
    createApiKey: { allowed: "ADMIN", call: (slug) => apiKeys.createApiKey(slug, "Zapier", "READ") },
    revokeApiKey: { allowed: "ADMIN", takesIds: true, call: (slug, f) => apiKeys.revokeApiKey(slug, f.apiKeyId) },
  },
  boards: {
    createBoard: { allowed: "ADMIN", call: (slug) => boards.createBoard(slug, {}, form({ name: "Ideas", slug: "ideas" })) },
    updateBoard: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => boards.updateBoard(slug, f.boardId, {}, form({ name: "Ideas", slug: "ideas" })),
    },
    deleteBoard: { allowed: "ADMIN", takesIds: true, call: (slug, f) => boards.deleteBoard(slug, f.emptyBoardId) },
  },
  changelog: {
    saveChangelogEntry: {
      allowed: "MEMBER",
      call: (slug) => {
        const form = new FormData();
        form.set("title", "From the matrix");
        return changelog.saveChangelogEntry(slug, null, {}, form);
      },
    },
    draftChangelogEntry: {
      allowed: "MEMBER",
      before: () => model.reply(JSON.stringify({ title: "Matrix release", notes: "Shipped." })),
      call: (slug) => changelog.draftChangelogEntry(slug, 2),
    },
    publishChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.publishChangelogEntry(slug, 1) },
    unpublishChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.unpublishChangelogEntry(slug, 1) },
    deleteChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.deleteChangelogEntry(slug, 1) },
    saveChangelogStyle: {
      allowed: "MEMBER",
      call: (slug) => {
        const form = new FormData();
        form.set("tone", "Friendly");
        form.append("examples", "1");
        return changelog.saveChangelogStyle(slug, {}, form);
      },
    },
  },
  github: {
    disconnectGithub: { allowed: "ADMIN", call: (slug) => github.disconnectGithub(slug) },
    setGithubCloseOn: { allowed: "ADMIN", call: (slug) => github.setGithubCloseOn(slug, "MERGE") },
    setGithubPrComments: { allowed: "ADMIN", call: (slug) => github.setGithubPrComments(slug, true) },
  },
  invitations: {
    createInvitation: {
      allowed: "ADMIN",
      call: (slug) => invitations.createInvitation(slug, `e2e-${crypto.randomUUID()}@example.com`, "MEMBER"),
    },
    revokeInvitation: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => invitations.revokeInvitation(slug, f.invitationId),
    },
    // The token is the permission: anyone signed in who has it may join.
    acceptInvitation: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => invitations.acceptInvitation(f.invitationToken),
    },
    // Only for invites addressed to the account's own verified email (see invitations.db.test.ts).
    acceptInvitationById: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => invitations.acceptInvitationById(f.emailInvitationId),
    },
    declineInvitation: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => invitations.declineInvitation(f.emailInvitationId),
    },
  },
  "manage-posts": {
    movePost: { allowed: "MEMBER", takesIds: true, call: (slug, f) => managePosts.movePost(slug, f.postId, "empty") },
    changePostStatus: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.changePostStatus(slug, f.postId, "PLANNED"),
    },
    mergePost: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.mergePost(slug, f.duplicateId, f.postId),
    },
    dismissDuplicate: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.dismissDuplicate(slug, f.suggestionId),
    },
    addPostLink: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.addPostLink(slug, f.postId, "https://github.com/acme/app/pull/1"),
    },
    removePostLink: { allowed: "MEMBER", takesIds: true, call: (slug, f) => managePosts.removePostLink(slug, f.postId, f.linkId) },
    acceptLinkSuggestion: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.acceptLinkSuggestion(slug, f.linkSuggestionId),
    },
    dismissLinkSuggestion: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.dismissLinkSuggestion(slug, f.linkSuggestionId),
    },
  },
  media: {
    // Anyone who may post in the project may upload; finishing and status are the uploader's own.
    createUpload: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) => media.createUpload(slug, { type: "image/png", size: 1000 }),
    },
    finishUpload: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => media.finishUpload(f.mediaId) },
    uploadStatus: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => media.uploadStatus(f.mediaId) },
  },
  "portal-handoff": {
    // Any Tuti account may sign in to any portal as itself.
    continueToPortal: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) => portalHandoff.continueToPortal(slug, "a".repeat(43), "/"),
    },
  },
  posts: {
    createPost: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) =>
        posts.createPost({}, form({ projectSlug: slug, boardSlug: "feature-requests", title: "Dark mode" })),
    },
    toggleVote: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => posts.toggleVote(f.postId) },
    addComment: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => posts.addComment({}, form({ postId: f.postId, body: "Me too" })),
    },
  },
  projects: {
    createProject: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: () => projects.createProject({}, form({ name: "New project", slug: `new-${crypto.randomUUID().slice(0, 8)}` })),
    },
  },
  "similar-posts": {
    findSimilarPosts: { allowed: "public", call: (slug) => similarPosts.findSimilarPosts(slug, "Dark mode please") },
  },
  "sso-settings": {
    rotateSsoSecret: { allowed: "ADMIN", call: (slug) => ssoSettings.rotateSsoSecret(slug) },
    disableSso: { allowed: "ADMIN", call: (slug) => ssoSettings.disableSso(slug) },
  },
  team: {
    changeTeamRole: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => team.changeTeamRole(slug, f.targetMemberId, "ADMIN"),
    },
    removeMember: { allowed: "ADMIN", takesIds: true, call: (slug, f) => team.removeMember(slug, f.targetMemberId) },
    leaveProject: { allowed: "MEMBER", call: (slug) => team.leaveProject(slug) },
  },
  // Signed in with tokens, not sessions: anyone holding a valid one may act (see widget.db.test.ts).
  widget: {
    widgetSignIn: {
      allowed: "public",
      call: async (slug) => {
        const secret = generateSsoSecret();
        await prisma.project.update({ where: { slug }, data: { ssoSecret: secret } });
        const now = Math.floor(Date.now() / 1000);
        const jwt = await new SignJWT({ sub: "matrix-user", jti: crypto.randomUUID() })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(new TextEncoder().encode(secret));
        return widget.widgetSignIn(slug, jwt);
      },
    },
    widgetCreatePost: {
      allowed: "public",
      call: async (slug) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        const form = new FormData();
        form.set("boardSlug", "feature-requests");
        form.set("title", "From the widget");
        return widget.widgetCreatePost(slug, widgetToken(project.id, users.MEMBER.id), {}, form);
      },
    },
  },
  webhooks: {
    createWebhook: { allowed: "ADMIN", call: (slug) => webhooks.createWebhook(slug, receiver.url, ["post.created"]) },
    deleteWebhook: { allowed: "ADMIN", takesIds: true, call: (slug, f) => webhooks.deleteWebhook(slug, f.webhookId) },
    sendTestWebhook: { allowed: "ADMIN", takesIds: true, call: (slug, f) => webhooks.sendTestWebhook(slug, f.webhookId) },
  },
};

const ROLES: TeamRole[] = ["MEMBER", "ADMIN", "OWNER"];

/** Who's acting: a role on the project's team, or someone from outside it. */
type Actor = TeamRole | "signed out" | "other project's owner" | "other project's SSO user";

let s3: S3Fake;
let model: ModelFake;
let receiver: WebhookReceiver;
let users: Record<TeamRole | "outsider" | "ssoUser", TestUser>;
let otherProject: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  s3 = await startS3Fake();
  // Webhook fixtures deliver to a local fake receiver.
  receiver = await startWebhookReceiver();
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  model = await startModelFake();
  for (const [name, value] of Object.entries({ ...s3.env, ...model.env })) {
    vi.stubEnv(name, value);
  }
  const [OWNER, ADMIN, MEMBER, outsider, ssoUser] = await Promise.all(
    ["Owner", "Admin", "Member", "Outsider", "SSO user"].map((name) => signUp(name)),
  );
  users = { OWNER: OWNER!, ADMIN: ADMIN!, MEMBER: MEMBER!, outsider: outsider!, ssoUser: ssoUser! };
  otherProject = await createProject(users.outsider);
  // The account that's allowed to act on its own email invites (allowedActor for "signed in").
  await prisma.user.update({ where: { id: users.outsider.id }, data: { emailVerified: true } });
  await prisma.ssoIdentity.create({
    data: { projectId: otherProject.id, externalId: "ext-1", userId: users.ssoUser.id },
  });
});

afterAll(() => Promise.all([s3.close(), receiver.close(), model.close()]));
// Refused calls never reach the model; allowed ones use the reply they scripted.
afterEach(() => model.done());

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Installation ids are unique: one per fixture. */
let installations = 0;

/** A project with one of everything the actions work on. */
async function createFixture() {
  const project = await createProject(users.OWNER);
  const projectId = project.id;
  await prisma.teamMember.createMany({
    data: [
      { projectId, userId: users.ADMIN.id, role: "ADMIN" },
      { projectId, userId: users.MEMBER.id, role: "MEMBER" },
    ],
  });
  const target = await prisma.user.create({
    data: { id: crypto.randomUUID(), name: "Target", email: `e2e-${crypto.randomUUID()}@example.com` },
  });
  const targetMember = await prisma.teamMember.create({ data: { projectId, userId: target.id, role: "MEMBER" } });
  const board = project.boards[0]!;
  const emptyBoard = await prisma.board.create({ data: { projectId, slug: "empty", name: "Empty" } });
  const [post, duplicate] = await Promise.all(
    [1, 2].map((number) =>
      prisma.post.create({
        data: { projectId, boardId: board.id, authorId: users.OWNER.id, number, title: `Post ${number}`, body: "" },
      }),
    ),
  );
  await prisma.project.update({ where: { id: projectId }, data: { postCount: 2 } });
  const suggestion = await prisma.duplicateSuggestion.create({
    data: { projectId, postId: duplicate!.id, originalId: post!.id, similarity: 0.9 },
  });
  const invitationToken = crypto.randomUUID();
  const invitation = await prisma.invitation.create({
    data: {
      projectId,
      tokenHash: hashInvitationToken(invitationToken),
      createdById: users.OWNER.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const emailInvitation = await prisma.invitation.create({
    data: {
      projectId,
      email: users.outsider.email,
      tokenHash: hashInvitationToken(crypto.randomUUID()),
      createdById: users.OWNER.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  // An upload by the account that's allowed to act as "signed in", waiting to be finished.
  const upload = await prisma.media.create({ data: { projectId, uploaderId: users.outsider.id, size: 4 } });
  s3.objects.set(`uploads/${upload.id}`, { body: Buffer.from("fake"), contentType: "image/png" });
  const apiKey = await prisma.apiKey.create({
    data: { projectId, name: "Key", scope: "READ", keyHash: crypto.randomUUID(), prefix: "tuti_x", createdById: users.OWNER.id },
  });
  const link = await prisma.postLink.create({
    data: {
      projectId,
      postId: post!.id,
      kind: "ISSUE",
      repo: "acme/app",
      number: 9,
      url: "https://github.com/acme/app/issues/9",
      source: "MANUAL",
    },
  });
  const linkSuggestion = await prisma.linkSuggestion.create({
    data: {
      projectId,
      postId: post!.id,
      repo: "acme/app",
      number: 11,
      url: "https://github.com/acme/app/pull/11",
      title: "Night mode",
      similarity: 0.6,
    },
  });
  await prisma.project.update({ where: { id: projectId }, data: { changelogCount: 2 } });
  await prisma.changelogEntry.createMany({
    data: [
      { projectId, number: 1, title: "Matrix entry", publishedAt: new Date() },
      { projectId, number: 2, title: "Matrix draft", body: "Shipped" },
    ],
  });
  const webhook = await prisma.webhook.create({
    data: { projectId, url: receiver.url, secret: "whsec_x", events: ["post.created"], createdById: users.OWNER.id },
  });
  await prisma.githubInstallation.create({
    data: { projectId, installationId: ++installations, accountLogin: "acme", createdById: users.OWNER.id },
  });
  return {
    slug: project.slug,
    linkId: link.id,
    linkSuggestionId: linkSuggestion.id,
    webhookId: webhook.id,
    apiKeyId: apiKey.id,
    mediaId: upload.id,
    emailInvitationId: emailInvitation.id,
    boardId: board.id,
    emptyBoardId: emptyBoard.id,
    postId: post!.id,
    duplicateId: duplicate!.id,
    suggestionId: suggestion.id,
    invitationId: invitation.id,
    invitationToken,
    targetMemberId: targetMember.id,
  };
}

function refusedActors(rule: Case): Actor[] {
  if (rule.allowed === "public") {
    return [];
  }
  if (rule.allowed === "signed in") {
    return rule.refusesSsoUsers ? ["signed out", "other project's SSO user"] : ["signed out"];
  }
  return ["signed out", "other project's owner", ...ROLES.slice(0, ROLES.indexOf(rule.allowed))];
}

/** The lowest level that may act, to show the action works. */
function allowedActor(rule: Case): Actor {
  return rule.allowed === "public" ? "signed out" : rule.allowed === "signed in" ? "other project's owner" : rule.allowed;
}

function userFor(actor: Actor): TestUser | null {
  switch (actor) {
    case "signed out":
      return null;
    case "other project's owner":
      return users.outsider;
    case "other project's SSO user":
      return users.ssoUser;
    default:
      return users[actor];
  }
}

/** What an action did: returned an error, redirected, or returned something else. */
async function outcome(action: Promise<unknown>): Promise<string> {
  try {
    const result = await action;
    const error = (result as { error?: string } | undefined)?.error;
    return error ? `error: ${error}` : "ok";
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (digest?.startsWith("NEXT_REDIRECT;")) {
      return "redirect";
    }
    throw error;
  }
}

/** Every table's contents, except sessions (reading a session may refresh it). */
async function snapshot(): Promise<Record<string, string>> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name NOT IN ('session', '_prisma_migrations')`;
  const entries = await Promise.all(
    tables.map(async ({ name }) => {
      const [row] = await prisma.$queryRawUnsafe<{ hash: string }[]>(
        `SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS hash FROM "${name}" t`,
      );
      return [name, row!.hash] as const;
    }),
  );
  return Object.fromEntries(entries);
}

test("every server action module is in the matrix", () => {
  const dir = new URL(".", import.meta.url);
  const serverActionFiles = readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
    .filter((file) => /^["']use server["']/.test(readFileSync(new URL(file, dir), "utf8")))
    .map((file) => file.replace(/\.ts$/, ""));
  expect(serverActionFiles.sort()).toEqual(Object.keys(modules).sort());
});

const cases = Object.entries(matrix).flatMap(([module, actions]) =>
  Object.entries(actions as Record<string, Case>).map(([name, rule]) => ({ name: `${module}.${name}`, rule })),
);

test.each(cases)("$name", async ({ rule }) => {
  const fixture = await createFixture();
  const before = await snapshot();

  for (const actor of refusedActors(rule)) {
    actAs(userFor(actor));
    expect({ actor, outcome: await outcome(rule.call(fixture.slug, fixture)) }).toEqual({
      actor,
      outcome: expect.stringMatching(/^error: /),
    });
  }
  if (rule.takesIds) {
    // Their own project's slug, with this project's ids.
    actAs(users.outsider);
    expect(await outcome(rule.call(otherProject.slug, fixture))).toMatch(/^error: /);
  }
  expect(await snapshot()).toEqual(before);

  actAs(userFor(allowedActor(rule)));
  rule.before?.();
  expect(await outcome(rule.call(fixture.slug, fixture))).not.toMatch(/^error: /);
});
