import { expect, test } from "vitest";

import { ACTIONS, actionsFor, storedWorkflow, TRIGGER_KEYS, workflowSentence, workflowSummary } from "./workflows";

test("every action says which triggers offer it, and each trigger offers one", () => {
  for (const trigger of TRIGGER_KEYS) {
    expect(actionsFor(trigger).length).toBeGreaterThan(0);
  }
  expect(actionsFor("conversation_started")).toEqual(["mark_priority", "straight_to_person"]);
  expect(actionsFor("user_replied")).toEqual(["mark_priority", "straight_to_person"]);
  // A marking action: the next workflow still runs; Straight to a person ends the list.
  expect(ACTIONS.mark_priority.deciding).toBe(false);
  expect(ACTIONS.straight_to_person.deciding).toBe(true);
});

test("a stored workflow is read whole, or not at all", () => {
  const stored = { trigger: "user_replied", conditions: [{ kind: "in_group", group: "vip" }], actions: [{ kind: "mark_priority" }] };
  expect(storedWorkflow(stored)).toEqual({ conditions: stored.conditions, actions: stored.actions });
  expect(storedWorkflow({ ...stored, conditions: [] })).toEqual({ conditions: [], actions: stored.actions });
  // A trigger, a condition or an action from a later release; no action at all.
  expect(storedWorkflow({ ...stored, trigger: "handover" })).toBeNull();
  expect(storedWorkflow({ ...stored, conditions: [{ kind: "channel", channel: "email" }] })).toBeNull();
  expect(storedWorkflow({ ...stored, actions: [{ kind: "mark_priority" }, { kind: "close" }] })).toBeNull();
  expect(storedWorkflow({ ...stored, actions: [] })).toBeNull();
  expect(storedWorkflow({ ...stored, actions: null })).toBeNull();
});

test("a workflow's one line: who it's for, by the group's name, then what it does", () => {
  expect(workflowSummary({ conditions: [{ kind: "in_group", group: "enterprise" }], actions: [{ kind: "mark_priority" }] }, { enterprise: "Enterprise" })).toBe("In Enterprise: mark priority");
  expect(workflowSummary({ conditions: [], actions: [{ kind: "mark_priority" }] }, {})).toBe("Everyone: mark priority");
});

test("a workflow reads back as a sentence", () => {
  expect(workflowSentence({ trigger: "conversation_started", conditions: [{ kind: "in_group", group: "enterprise" }], actions: [{ kind: "mark_priority" }] }, { enterprise: "Enterprise" })).toBe(
    "When a conversation starts, if the person is in Enterprise: mark priority.",
  );
  expect(workflowSentence({ trigger: "user_replied", conditions: [], actions: [] }, {})).toBe("When a user replies, for everyone: nothing yet.");
});
