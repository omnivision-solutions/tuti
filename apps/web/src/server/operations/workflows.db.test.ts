import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { MAX_WORKFLOWS } from "@/lib/workflows";
import { createProject, signUp } from "@/test/helpers";

import { deleteGroup } from "./groups";
import { call } from "./run";
import { createWorkflow, deleteWorkflow, getWorkflow, listWorkflows, moveWorkflow, updateWorkflow } from "./workflows";

/** The inbox's workflows over the API (docs/plan.md, Inbox automation, W8): each trigger's ordered list. */

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  await prisma.readerGroup.create({ data: { projectId: project.id, key: "vip", name: "VIP", conditions: [{ property: "plan", op: "is", value: "vip" }] } });
  return {
    projectId: project.id,
    admin,
    add: (name: string, trigger: "conversation_started" | "user_replied" = "conversation_started") => call(createWorkflow, admin, { name, trigger, actions: [{ kind: "mark_priority" }] }),
    /** Each list as it runs: "trigger: name, name". */
    lists: async () => {
      const { workflows } = await call(listWorkflows, admin, {});
      // Places are 0, 1, … in each list, with no gaps.
      for (const trigger of ["conversation_started", "user_replied"]) {
        expect(workflows.filter((w) => w.trigger === trigger).map((w) => w.position)).toEqual(workflows.filter((w) => w.trigger === trigger).map((_, at) => at));
      }
      return workflows.map((w) => `${w.trigger}: ${w.name}${w.enabled ? "" : " (off)"}`);
    },
  };
}

test("a workflow goes last in its trigger's list, on and for everyone unless said, and moves within it", async () => {
  const { admin, add, lists } = await setup();
  const a = await add("A");
  const b = await add("B");
  const c = await add("C");
  const replies = await add("Replies", "user_replied");
  expect(a).toMatchObject({ name: "A", trigger: "conversation_started", position: 0, enabled: true, conditions: [], actions: [{ kind: "mark_priority" }] });
  expect(await call(getWorkflow, admin, { id: replies.id })).toMatchObject({ name: "Replies", position: 0 });
  // The triggers in the path's order, each list top to bottom.
  expect(await lists()).toEqual(["conversation_started: A", "conversation_started: B", "conversation_started: C", "user_replied: Replies"]);

  expect(await call(moveWorkflow, admin, { id: c.id, position: 0 })).toMatchObject({ position: 0 });
  expect(await lists()).toEqual(["conversation_started: C", "conversation_started: A", "conversation_started: B", "user_replied: Replies"]);
  // Left out, or past the end: last.
  expect(await call(moveWorkflow, admin, { id: c.id })).toMatchObject({ position: 2 });
  expect(await call(moveWorkflow, admin, { id: a.id, position: 99 })).toMatchObject({ position: 2 });
  expect(await lists()).toEqual(["conversation_started: B", "conversation_started: C", "conversation_started: A", "user_replied: Replies"]);

  // Given another trigger it goes last there, and the list it left closes up; the rest of it stays.
  expect(await call(updateWorkflow, admin, { id: b.id, trigger: "user_replied", enabled: false })).toMatchObject({ name: "B", position: 1, enabled: false });
  expect(await lists()).toEqual(["conversation_started: C", "conversation_started: A", "user_replied: Replies", "user_replied: B (off)"]);
  expect(await call(updateWorkflow, admin, { id: a.id, name: "Renamed" })).toMatchObject({ name: "Renamed", position: 1, enabled: true });

  // Deleted, its list closes up.
  expect(await call(deleteWorkflow, admin, { id: c.id })).toEqual({ deleted: c.id });
  expect(await lists()).toEqual(["conversation_started: Renamed", "user_replied: Replies", "user_replied: B (off)"]);
  await expect(call(getWorkflow, admin, { id: c.id })).rejects.toMatchObject({ status: 404 });
});

test("another project's workflow isn't there: not read, changed, moved or deleted", async () => {
  const { add } = await setup();
  const theirs = await add("Theirs");
  const { admin, lists } = await setup();
  for (const attempt of [
    () => call(getWorkflow, admin, { id: theirs.id }),
    () => call(updateWorkflow, admin, { id: theirs.id, name: "Mine now" }),
    () => call(moveWorkflow, admin, { id: theirs.id, position: 0 }),
    () => call(deleteWorkflow, admin, { id: theirs.id }),
  ]) {
    await expect(attempt()).rejects.toMatchObject({ status: 404, code: "not_found" });
  }
  expect(await lists()).toEqual([]);
  expect(await prisma.workflow.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ name: "Theirs", position: 0 });
});

test("a workflow is for a group the project has, which can't be deleted while a workflow is for it", async () => {
  const { admin, add } = await setup();
  const everyone = await add("Everyone");
  const input = { name: "VIPs first", trigger: "conversation_started" as const, actions: [{ kind: "mark_priority" as const }] };
  await expect(call(createWorkflow, admin, { ...input, conditions: [{ kind: "in_group", group: "nobody" }] })).rejects.toMatchObject({
    status: 400,
    message: "There's no group “nobody”: add it in Settings → Groups first",
  });
  await expect(call(updateWorkflow, admin, { id: everyone.id, conditions: [{ kind: "in_group", group: "nobody" }] })).rejects.toMatchObject({ status: 400 });
  // One condition, or none.
  await expect(call(createWorkflow, admin, { ...input, conditions: [{ kind: "in_group", group: "vip" }, { kind: "in_group", group: "vip" }] })).rejects.toMatchObject({ status: 400 });
  // At least one action, of a kind there is.
  await expect(call(createWorkflow, admin, { ...input, actions: [] })).rejects.toMatchObject({ status: 400, message: "A workflow needs an action" });
  await expect(call(createWorkflow, admin, { ...input, actions: [{ kind: "close" } as never] })).rejects.toMatchObject({ status: 400 });

  const vips = await call(createWorkflow, admin, { ...input, conditions: [{ kind: "in_group", group: "vip" }] });
  expect(vips.conditions).toEqual([{ kind: "in_group", group: "vip" }]);
  await expect(call(deleteGroup, admin, { group: "vip" })).rejects.toMatchObject({ status: 409, message: "Used by VIPs first; remove it from them first" });
  // For everyone since: the group can go.
  await call(updateWorkflow, admin, { id: vips.id, conditions: [] });
  expect(await call(deleteGroup, admin, { group: "vip" })).toEqual({ deleted: "vip" });
});

test("a trigger's list holds so many workflows, by creating or by changing a workflow's trigger", async () => {
  const { projectId, admin, add } = await setup();
  await prisma.workflow.createMany({
    data: Array.from({ length: MAX_WORKFLOWS }, (_, position) => ({ projectId, name: `Workflow ${position}`, trigger: "conversation_started", position, actions: [{ kind: "mark_priority" }] })),
  });
  await expect(add("One more")).rejects.toMatchObject({ status: 409, message: `“A conversation starts” has ${MAX_WORKFLOWS} workflows already: delete one first` });
  const reply = await add("A reply's", "user_replied");
  await expect(call(updateWorkflow, admin, { id: reply.id, trigger: "conversation_started" })).rejects.toMatchObject({ status: 409 });
  expect(await prisma.workflow.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({ trigger: "user_replied", position: 0 });
});
