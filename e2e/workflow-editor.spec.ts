import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL } from "./env";
import { apiFor, createProject, holdActions, signUp } from "./helpers";

test("an owner makes a priority workflow in its editor, a user in its group writes and is marked priority, then edits it, turns it off and deletes it, on a phone too", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.setViewportSize({ width: 1280, height: 900 });
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });
  await api("/groups", { name: "Trial", conditions: [{ property: "plan", op: "is", value: "trial" }] });
  await api("/users", { users: [{ id: "user-ent", properties: { plan: "enterprise" } }, { id: "user-free", properties: { plan: "free" } }] });
  /** A new conversation from `user`, and whether it came out priority. */
  let written = 0;
  const writes = async (user: string) => {
    await api("/conversations", { user: { id: user }, subject: `Question ${++written}`, body: "How do I export my data?" });
    return ((await api(`/conversations/${written}`, undefined, "GET")) as unknown as { priority: boolean }).priority;
  };

  // Each trigger's group has Add workflow, opening the editor with that trigger chosen.
  await owner.goto(`/app/${slug}/settings/workflows`);
  await owner.getByRole("link", { name: "Add workflow when a user replies" }).click();
  await owner.waitForURL(`**/settings/workflows/new?trigger=user_replied`);
  await expect(owner.getByRole("combobox", { name: "When" })).toContainText("A user replies");
  await owner.goBack();
  await owner.getByRole("link", { name: "Add workflow when a conversation starts" }).click();
  await owner.waitForURL(`**/settings/workflows/new?trigger=conversation_started`);
  await expect(owner).toHaveTitle(/New workflow · Workflows · Settings/);
  const main = owner.getByRole("main");
  const when = owner.getByRole("combobox", { name: "When" });
  await expect(when).toContainText("A conversation starts");
  await expect(main).toContainText("On a user's first message, once per conversation, after the spam filter lets it through.");
  const sentence = main.getByLabel("Reads as");
  await expect(sentence).toHaveText("When a conversation starts, for everyone: nothing yet.");

  // Who it's for, then saved with no name and no action: each says what's missing.
  await owner.getByRole("combobox", { name: "If" }).click();
  await owner.getByRole("option", { name: "People in Enterprise" }).click();
  await expect(sentence).toHaveText("When a conversation starts, if the person is in Enterprise: nothing yet.");
  const save = owner.getByRole("button", { name: "Save changes" });
  await save.click();
  await expect(main.getByText("Give it a name")).toBeVisible();
  await expect(main.getByText("Add an action: a workflow needs one")).toBeVisible();
  await owner.getByRole("textbox", { name: "Name" }).fill("Enterprise first");
  await expect(main.getByText("Give it a name")).toHaveCount(0);
  await owner.getByRole("button", { name: "Add an action" }).click();
  await owner.getByRole("menuitem", { name: "Mark priority" }).click();
  await expect(main.getByText("Add an action: a workflow needs one")).toHaveCount(0);
  await expect(sentence).toHaveText("When a conversation starts, if the person is in Enterprise: mark priority.");
  // An action is added once.
  await owner.getByRole("button", { name: "Add an action" }).click();
  await expect(owner.getByRole("menuitem", { name: "Mark priority" })).toBeDisabled();
  // Closed before going on (else its items cover the row's buttons): an Escape pressed as it opens, before it has the
  // focus, is pressed again.
  await expect(async () => {
    await owner.keyboard.press("Escape");
    await expect(owner.getByRole("menu")).toBeHidden({ timeout: 1000 });
  }).toPass();
  // Removed: the focus goes to Add an action, as its row is gone.
  await owner.getByRole("button", { name: "Remove Mark priority" }).click();
  await expect(owner.getByRole("button", { name: "Add an action" })).toBeFocused();
  await expect(sentence).toHaveText("When a conversation starts, if the person is in Enterprise: nothing yet.");
  await owner.getByRole("button", { name: "Add an action" }).click();
  await owner.getByRole("menuitem", { name: "Mark priority" }).click();
  await checkpoint(owner, "editor-new");
  // Saved with Enter from the name. While a new one saves nothing changes (it goes to the list once added), and the
  // focus stays where it was.
  const releaseAdd = await holdActions(owner);
  const name = owner.getByRole("textbox", { name: "Name" });
  await name.focus();
  await owner.keyboard.press("Enter");
  await expect(name).toHaveAttribute("readonly");
  await expect(name).toBeFocused();
  await owner.keyboard.type(" (typed while saving)");
  await expect(name).toHaveValue("Enterprise first");
  await expect(owner.getByRole("button", { name: "Remove Mark priority" })).toBeDisabled();
  await expect(name).toBeFocused();
  await releaseAdd();
  await expect(owner.getByText("Added Enterprise first")).toBeVisible();
  await owner.waitForURL(`**/app/${slug}/settings/workflows`);
  const started = main.getByRole("list", { name: "When a conversation starts" });
  await expect(started.getByRole("listitem")).toContainText("Enterprise firstIn Enterprise: mark priority");

  // A user in the group writes: marked priority. One who isn't: not.
  expect(await writes("user-ent")).toBe(true);
  expect(await writes("user-free")).toBe(false);

  // The row's name opens its editor: changed to Trial, while a teammate switches it off.
  await started.getByRole("link", { name: "Enterprise first" }).click();
  await owner.waitForURL(/\/settings\/workflows\/[^/]+$/);
  await expect(owner.getByRole("textbox", { name: "Name" })).toHaveValue("Enterprise first");
  await expect(owner.getByRole("combobox", { name: "If" })).toContainText("People in Enterprise");
  await expect(owner.getByRole("switch", { name: "On" })).toBeChecked();
  await expect(save).toBeDisabled();
  const editor = owner.url();
  // The teammate's change through the API, the page's refreshes held until this save is in: the editor saves what it
  // changed only, so the switch-off stays.
  let saved!: () => void;
  const savedIn = new Promise<void>((done) => (saved = done));
  const holdUntilSaved = async (route: Route) => {
    if (route.request().method() === "GET" && route.request().headers()["rsc"]) await savedIn;
    await route.fallback();
  };
  await owner.route("**/*", holdUntilSaved);
  await api(`/workflows/${editor.split("/").pop()}`, { enabled: false }, "PATCH");
  await owner.getByRole("textbox", { name: "Name" }).fill("Trial first");
  await owner.getByRole("combobox", { name: "If" }).click();
  await owner.getByRole("option", { name: "People in Trial" }).click();
  await expect(sentence).toHaveText("When a conversation starts, if the person is in Trial: mark priority.");
  await checkpoint(owner, "editor-edit");
  await save.click();
  await expect(owner.getByText("Saved Trial first")).toBeVisible();
  saved();
  await owner.unroute("**/*", holdUntilSaved);
  expect(((await api(`/workflows/${editor.split("/").pop()}`, undefined, "GET")) as unknown as { enabled: boolean }).enabled).toBe(false);
  // The page the save brings has it: the editor shows it off, with nothing left to save.
  await expect(owner.getByRole("switch", { name: "On" })).not.toBeChecked();
  await expect(save).toBeDisabled();
  await expect(owner.getByRole("heading", { name: "Trial first" })).toBeVisible();
  // Off: a user in the group it was for, or the one it's for now, isn't marked.
  expect(await writes("user-ent")).toBe(false);
  await api("/users", { users: [{ id: "user-free", properties: { plan: "trial" } }] });
  expect(await writes("user-free")).toBe(false);

  // A group deleted while the editor is open: the save is refused, saying so. (The workflow isn't for it, so it can go.)
  await owner.getByRole("switch", { name: "On" }).click();
  await owner.getByRole("combobox", { name: "If" }).click();
  await owner.getByRole("option", { name: "People in Enterprise" }).click();
  // The page's refreshes (the live stream's, on the conversations written above) are held meanwhile: one bringing the
  // groups without Enterprise would have the editor refuse it before the server could. Refused, the editor refreshes.
  let refreshed!: () => void;
  const held = new Promise<void>((done) => (refreshed = done));
  const holdRefresh = async (route: Route) => {
    if (route.request().method() === "GET" && route.request().headers()["rsc"]) await held;
    await route.fallback();
  };
  await owner.route("**/*", holdRefresh);
  await api("/groups/enterprise", undefined, "DELETE");
  await save.click();
  await expect(main.getByText("There's no group “enterprise”: add it in Settings → Groups first")).toBeVisible();
  refreshed();
  await owner.unroute("**/*", holdRefresh);
  // Once the page has the groups, the editor says so itself.
  await expect(main.getByText("This group was deleted: pick another, or Everyone")).toBeVisible();

  // On a phone: the editor fits, as saved (a reload drops the change refused above).
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(editor);
  await expect(owner.getByRole("textbox", { name: "Name" })).toHaveValue("Trial first");
  await expect(owner.getByRole("switch", { name: "On" })).not.toBeChecked();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "editor-phone");

  // Turned on again from the phone, with the name changed while that saves: the change stays, still to save.
  await owner.getByRole("switch", { name: "On" }).click();
  const release = await holdActions(owner);
  await save.click();
  await owner.getByRole("textbox", { name: "Name" }).fill("Trial first (all)");
  await release();
  await expect(owner.getByText("Saved Trial first")).toBeVisible();
  await expect(owner.getByRole("textbox", { name: "Name" })).toHaveValue("Trial first (all)");
  await expect(save).toBeEnabled();
  await owner.getByRole("textbox", { name: "Name" }).fill("Trial first");
  await expect(save).toBeDisabled();
  expect(await writes("user-free")).toBe(true);

  // A workflow whose group is gone (deleted through the release before, which didn't refuse it): its editor says so, and
  // Save waits for another choice.
  await query(
    `INSERT INTO workflow (id, "projectId", name, trigger, position, conditions, actions, "updatedAt") SELECT $2, id, 'Old group', 'user_replied', 0, '[{"kind":"in_group","group":"gone"}]', '[{"kind":"mark_priority"}]', NOW() FROM project WHERE slug = $1`,
    [slug, `e2e-${randomUUID()}`],
  );
  await owner.goto(`/app/${slug}/settings/workflows`);
  await main.getByRole("list", { name: "When a user replies" }).getByRole("link", { name: "Old group" }).click();
  await expect(owner.getByRole("combobox", { name: "If" })).toContainText("People in “gone” (deleted)");
  await expect(main.getByText("This group was deleted: pick another, or Everyone")).toBeVisible();
  await owner.getByRole("textbox", { name: "Name" }).fill("Old group, renamed");
  await save.click();
  await expect(main.getByText("This group was deleted: pick another, or Everyone")).toBeVisible();
  await expect(owner.getByText("Saved Old group, renamed")).toHaveCount(0);
  await owner.getByRole("combobox", { name: "If" }).click();
  await owner.getByRole("option", { name: "Everyone" }).click();
  await expect(main.getByText("This group was deleted: pick another, or Everyone")).toHaveCount(0);
  await save.click();
  await expect(owner.getByText("Saved Old group, renamed")).toBeVisible();
  await owner.goto(editor);

  // Deleted, asking first: back to the list, without it.
  await main.getByRole("button", { name: "Delete" }).click();
  const dialog = owner.getByRole("alertdialog", { name: "Delete Trial first?" });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(owner.getByText("Deleted Trial first")).toBeVisible();
  await owner.waitForURL(`**/app/${slug}/settings/workflows`);
  await expect(main.getByText("No workflows. New conversations go on to the next step.")).toBeVisible();
  // Its address now leads to the list.
  await owner.goto(editor);
  await owner.waitForURL(`**/app/${slug}/settings/workflows`);
});

test("an owner changes only the text of a saved workflow's set reply, and it's saved", async ({ browser }) => {
  test.setTimeout(60_000);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const { id } = (await api("/workflows", {
    name: "Say hello",
    trigger: "about_to_hand_over",
    actions: [{ kind: "reply_text", text: "Hello!" }, { kind: "dont_hand_over" }],
  })) as unknown as { id: string };

  await owner.goto(`/app/${slug}/settings/workflows/${id}`);
  const reply = owner.getByRole("textbox", { name: "Reply" });
  await expect(reply).toHaveValue("Hello!");
  const save = owner.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  await reply.fill("Hello! We'll be with you soon.");
  await save.click();
  await expect(owner.getByText("Saved Say hello")).toBeVisible();
  await expect(save).toBeDisabled();
  const stored = (await api(`/workflows/${id}`, undefined, "GET")) as unknown as { actions: { kind: string; text?: string }[] };
  expect(stored.actions).toEqual([{ kind: "reply_text", text: "Hello! We'll be with you soon." }, { kind: "dont_hand_over" }]);
  await owner.reload();
  await expect(reply).toHaveValue("Hello! We'll be with you soon.");
});
