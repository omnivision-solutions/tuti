import { readdirSync, readFileSync } from "node:fs";

import { type TeamRole, prisma } from "@tuti/db";
import { beforeAll, expect, test } from "vitest";

import { hashInvitationToken } from "@/lib/invitations";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import * as boards from "./boards";
import * as invitations from "./invitations";
import * as managePosts from "./manage-posts";
import * as posts from "./posts";
import * as projects from "./projects";
import * as similarPosts from "./similar-posts";
import * as ssoSettings from "./sso-settings";
import * as team from "./team";

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
  boards,
  invitations,
  "manage-posts": managePosts,
  posts,
  projects,
  "similar-posts": similarPosts,
  "sso-settings": ssoSettings,
  team,
};

type Level = "public" | "signed in" | TeamRole;

type Case = {
  allowed: Level;
  /** Takes ids of the project's records: another project's team must not reach them through their own slug. */
  takesIds?: true;
  /** Users who signed in through another project's SSO can't act here (portal actions). */
  portal?: true;
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
  boards: {
    createBoard: { allowed: "ADMIN", call: (slug) => boards.createBoard(slug, {}, form({ name: "Ideas", slug: "ideas" })) },
    updateBoard: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => boards.updateBoard(slug, f.boardId, {}, form({ name: "Ideas", slug: "ideas" })),
    },
    deleteBoard: { allowed: "ADMIN", takesIds: true, call: (slug, f) => boards.deleteBoard(slug, f.emptyBoardId) },
  },
  invitations: {
    createInvitation: { allowed: "ADMIN", call: (slug) => invitations.createInvitation(slug, "MEMBER") },
    revokeInvitation: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => invitations.revokeInvitation(slug, f.invitationId),
    },
    // The token is the permission: anyone signed in who has it may join.
    acceptInvitation: { allowed: "signed in", call: (_slug, f) => invitations.acceptInvitation(f.invitationToken) },
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
  },
  posts: {
    createPost: {
      allowed: "signed in",
      portal: true,
      call: (slug) =>
        posts.createPost({}, form({ projectSlug: slug, boardSlug: "feature-requests", title: "Dark mode" })),
    },
    toggleVote: { allowed: "signed in", portal: true, call: (_slug, f) => posts.toggleVote(f.postId) },
    addComment: {
      allowed: "signed in",
      portal: true,
      call: (_slug, f) => posts.addComment({}, form({ postId: f.postId, body: "Me too" })),
    },
  },
  projects: {
    createProject: {
      allowed: "signed in",
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
};

const ROLES: TeamRole[] = ["MEMBER", "ADMIN", "OWNER"];

/** Who's acting: a role on the project's team, or someone from outside it. */
type Actor = TeamRole | "signed out" | "other project's owner" | "other project's SSO user";

let users: Record<TeamRole | "outsider" | "ssoUser", TestUser>;
let otherProject: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  const [OWNER, ADMIN, MEMBER, outsider, ssoUser] = await Promise.all(
    ["Owner", "Admin", "Member", "Outsider", "SSO user"].map((name) => signUp(name)),
  );
  users = { OWNER: OWNER!, ADMIN: ADMIN!, MEMBER: MEMBER!, outsider: outsider!, ssoUser: ssoUser! };
  otherProject = await createProject(users.outsider);
  await prisma.ssoIdentity.create({
    data: { projectId: otherProject.id, externalId: "ext-1", userId: users.ssoUser.id },
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

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
  return {
    slug: project.slug,
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
    return rule.portal ? ["signed out", "other project's SSO user"] : ["signed out"];
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
  expect(await outcome(rule.call(fixture.slug, fixture))).not.toMatch(/^error: /);
});
