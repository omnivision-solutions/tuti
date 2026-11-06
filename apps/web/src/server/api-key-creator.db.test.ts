import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { GET } from "@/app/api/v1/[...path]/route";
import { POST } from "@/app/mcp/route";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { createApiKey } from "./api-keys";
import { changeTeamRole, removeMember } from "./team";

/** A project API key acts for its team with the powers of whoever created it, only while they still have them. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let admin: Awaited<ReturnType<typeof addMember>>;
let key: string;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  admin = await addMember(project.id, "ADMIN");
  actAs(admin);
  key = (await createApiKey(project.slug, "Admin's key", "WRITE")).key!;
  actAs(owner);
});

const get = async (path: string) => {
  const url = new URL(`http://tuti.localhost:3100/api/v1${path}`);
  const response = await GET(new Request(url, { headers: { authorization: `Bearer ${key}` } }), {
    params: Promise.resolve({ path: url.pathname.split("/").slice(3) }),
  });
  return response.status;
};

test("an admin's key stops working once they're removed from the team", async () => {
  expect(await get("/users")).toBe(200);
  expect(await removeMember(project.slug, admin.memberId)).toEqual({});
  // They aren't on the team any more: their key mustn't read its customers or inbox.
  expect(await get("/users")).not.toBe(200);
  // Revoked, not just refused: it comes off Settings → Developers and stays dead if they're invited back.
  expect(await prisma.apiKey.count({ where: { projectId: project.id, revokedAt: null } })).toBe(0);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  expect(await get("/users")).toBe(401);
});

test("a key whose creator left the team without it being revoked (a key from before keys were revoked on leaving) is refused", async () => {
  await prisma.teamMember.delete({ where: { id: admin.memberId } });
  expect(await prisma.apiKey.count({ where: { projectId: project.id, revokedAt: null } })).toBe(1);
  expect(await get("/users")).toBe(401);
  const mcp = await POST(
    new Request("http://tuti.localhost:3100/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  expect(mcp.status).toBe(401);
});

test("an admin's key loses admin operations once they're made a member", async () => {
  expect(await get("/ai-models")).toBe(200);
  expect(await changeTeamRole(project.slug, admin.memberId, "MEMBER")).toEqual({});
  expect(await get("/ai-models")).toBe(403);
});

test("MCP follows the same rule: a demoted admin's key loses admin tools, a removed one's key stops working", async () => {
  const listTools = () =>
    POST(
      new Request("http://tuti.localhost:3100/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
  const tools = async () => ((await (await listTools()).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);

  expect(await tools()).toContain("aiModels_get");
  // Owners' tools are for owners' keys only.
  expect(await tools()).not.toContain("codeChangesTuning_update");
  const admins = key;
  key = (await createApiKey(project.slug, "Owner's key", "WRITE")).key!;
  expect(await tools()).toContain("codeChangesTuning_update");
  key = admins;

  expect(await changeTeamRole(project.slug, admin.memberId, "MEMBER")).toEqual({});
  expect(await tools()).not.toContain("aiModels_get");
  expect(await tools()).toContain("users_list");

  expect(await removeMember(project.slug, admin.memberId)).toEqual({});
  expect((await listTools()).status).toBe(401);
});
