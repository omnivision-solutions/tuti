import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("an owner sees the path in Settings → Workflows, reorders a trigger's workflows by dragging and from the menu, turns one off and deletes one, on a phone too", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.setViewportSize({ width: 1280, height: 900 });
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });
  const create = (name: string) => api("/workflows", { name, trigger: "conversation_started", actions: [{ kind: "mark_priority" }] });
  await create("First");
  // One a later release made, with an action this one can't read: not shown, yet it keeps its place in the list.
  await query(
    `INSERT INTO workflow (id, "projectId", name, trigger, position, actions, "updatedAt") SELECT $2, id, 'Later', 'conversation_started', 1, '[{"kind":"later_kind"}]', NOW() FROM project WHERE slug = $1`,
    [slug, randomUUID()],
  );
  await create("Second");
  await create("Third");
  /** The whole list as stored, the one this page doesn't show too. */
  const stored = async () => (await query(`SELECT w.name FROM workflow w JOIN project p ON p.id = w."projectId" WHERE p.slug = $1 AND w.trigger = 'conversation_started' ORDER BY w.position`, [slug])).map((row) => row.name as string);
  await api("/workflows", { name: "Enterprise replies", trigger: "user_replied", conditions: [{ kind: "in_group", group: "enterprise" }], actions: [{ kind: "mark_priority" }] });
  /** The trigger's list, top to bottom, as the API runs it. */
  const order = async (trigger: string) =>
    ((await api("/workflows", undefined, "GET")) as unknown as { workflows: { id: string; name: string; trigger: string; enabled: boolean }[] }).workflows.filter((workflow) => workflow.trigger === trigger);

  // Under Spam in the menu; the path top to bottom, the built-in steps fixed in it.
  await owner.goto(`/app/${slug}/settings/spam`);
  await owner.locator(`a[href="/app/${slug}/settings/workflows"]`).click();
  await owner.waitForURL(`**/app/${slug}/settings/workflows`);
  await expect(owner).toHaveTitle(/Workflows · Settings · Acme/);
  const main = owner.getByRole("main");
  await expect(main.getByRole("heading", { level: 2, name: /^When/ })).toHaveText(["When a conversation starts 3", "When a user replies 1"]);
  await expect(main.getByText("Built in")).toHaveCount(3);
  // The path, in the order a message takes it today: the AI first (in the widget, before a conversation), then the rest.
  const path = ["AI answers first", "Spam filter", "When a conversation starts", "When a user replies", "Hand to the team"];
  const inOrder = async () => {
    const text = await main.innerText();
    const found = path.map((step) => text.indexOf(step));
    return found.every((index, i) => index >= 0 && (i === 0 || index > found[i - 1]!));
  };
  await expect.poll(inOrder).toBe(true);
  await expect(main).toContainText("On in the widget, where it answers before a conversation starts, once you've published articles");
  await expect(main.getByRole("link", { name: "Spam filter settings" })).toHaveAttribute("href", `/app/${slug}/settings/spam`);
  const started = main.getByRole("list", { name: "When a conversation starts" });
  const replied = main.getByRole("list", { name: "When a user replies" });
  await expect(replied.getByRole("listitem")).toHaveCount(1);
  await expect(replied.getByRole("listitem")).toContainText("Enterprise repliesIn Enterprise: mark priority");
  const names = () => started.getByRole("listitem").locator("[id$=-name]");
  await expect(names()).toHaveText(["First", "Second", "Third"]);
  await checkpoint(owner, "workflows");

  // Dragged: Third on top of First.
  const row = (name: string) => started.getByRole("listitem").filter({ has: owner.getByText(name, { exact: true }) });
  await row("Third").dragTo(row("First"));
  await expect(owner.getByText("Moved Third")).toBeVisible();
  await expect(names()).toHaveText(["Third", "First", "Second"]);
  await expect.poll(stored).toEqual(["Third", "First", "Later", "Second"]);

  // From the keyboard: the row's menu moves it down, past the one not shown, and its menu has the focus again.
  const menu = (name: string) => owner.getByRole("button", { name: `Actions for ${name}` });
  await menu("Third").focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
  await owner.keyboard.press("Escape");
  // Closed before the next opens: a menu closing still has its items for a moment, so two would match "Move down".
  await expect(owner.getByRole("menuitem")).toHaveCount(0);
  await menu("First").focus();
  await owner.keyboard.press("Enter");
  await owner.getByRole("menuitem", { name: "Move down" }).click();
  await expect(names()).toHaveText(["Third", "Second", "First"]);
  await expect(menu("First")).toBeFocused();
  await expect.poll(stored).toEqual(["Third", "Later", "Second", "First"]);
  await expect.poll(async () => (await order("conversation_started")).map((workflow) => workflow.name)).toEqual(["Third", "Second", "First"]);

  // A click on a row's name is a click on its title: it turns nothing off.
  await started.getByText("Second", { exact: true }).click();
  await expect(owner.getByRole("switch", { name: "Second" })).toBeChecked();

  // Turned off from the keyboard: it saves at once, and keeps the focus.
  await owner.getByRole("switch", { name: "Second" }).focus();
  await owner.keyboard.press("Space");
  await expect(owner.getByText("Second turned off")).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Second" })).not.toBeChecked();
  await expect(owner.getByRole("switch", { name: "Second" })).toBeFocused();
  await expect.poll(async () => (await order("conversation_started")).find((workflow) => workflow.name === "Second")?.enabled).toBe(false);

  // Deleted, asking first.
  await menu("First").click();
  await owner.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = owner.getByRole("alertdialog", { name: "Delete First?" });
  await expect(dialog).toContainText("It stops running for new messages. The notes it left in conversations stay.");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(owner.getByText("Deleted First")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(names()).toHaveText(["Third", "Second"]);
  // The focus goes to its neighbour's menu.
  await expect(menu("Second")).toBeFocused();
  await expect(main.getByRole("heading", { level: 2, name: /^When/ }).first()).toHaveText("When a conversation starts 2");

  // A group's last one deleted: the group says it has none, and has the focus.
  await menu("Enterprise replies").click();
  await owner.getByRole("menuitem", { name: "Delete" }).click();
  await owner.getByRole("alertdialog", { name: "Delete Enterprise replies?" }).getByRole("button", { name: "Delete" }).click();
  await expect(owner.getByText("Deleted Enterprise replies")).toBeVisible();
  await expect(main.getByText("No workflows. Replies go on to the next step.")).toBeFocused();

  // On a phone: no handle to drag, the menu moves it; the switch stays as saved.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.reload();
  await expect(names()).toHaveText(["Third", "Second"]);
  await expect(owner.getByRole("switch", { name: "Second" })).not.toBeChecked();
  await expect(started.locator("svg.lucide-grip-vertical").first()).toBeHidden();
  await menu("Second").click();
  await owner.getByRole("menuitem", { name: "Move up" }).click();
  await expect(names()).toHaveText(["Second", "Third"]);
  await expect.poll(stored).toEqual(["Second", "Third", "Later"]);
  // A switch the server refuses (the workflow was deleted meanwhile, through the API) goes back as it was.
  const third = (await order("conversation_started")).find((workflow) => workflow.name === "Third")!;
  await api(`/workflows/${third.id}`, undefined, "DELETE");
  await owner.getByRole("switch", { name: "Third" }).click();
  await expect(owner.getByText("There's no workflow with that id")).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Third" })).toBeChecked();
  // Nothing wider than the screen.
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "workflows-phone");
});
