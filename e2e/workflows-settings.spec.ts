import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
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
  for (const name of ["First", "Second", "Third"]) {
    await api("/workflows", { name, trigger: "conversation_started", actions: [{ kind: "mark_priority" }] });
  }
  await api("/workflows", { name: "Enterprise replies", trigger: "user_replied", conditions: [{ kind: "in_group", group: "enterprise" }], actions: [{ kind: "mark_priority" }] });
  /** The trigger's list, top to bottom, as the API runs it. */
  const order = async (trigger: string) =>
    ((await api("/workflows", undefined, "GET")) as unknown as { workflows: { name: string; trigger: string; enabled: boolean }[] }).workflows.filter((workflow) => workflow.trigger === trigger);

  // Under Spam in the menu; the path top to bottom, the built-in steps fixed in it.
  await owner.goto(`/app/${slug}/settings/spam`);
  await owner.locator(`a[href="/app/${slug}/settings/workflows"]`).click();
  await owner.waitForURL(`**/app/${slug}/settings/workflows`);
  await expect(owner).toHaveTitle(/Workflows · Settings · Acme/);
  const main = owner.getByRole("main");
  await expect(main.getByRole("heading", { level: 2, name: /^When/ })).toHaveText(["When a conversation starts 3", "When a user replies 1"]);
  await expect(main.getByText("Built in")).toHaveCount(3);
  await expect(main.getByRole("link", { name: "Spam filter settings" })).toHaveAttribute("href", `/app/${slug}/settings/spam`);
  const started = main.getByRole("list", { name: "When a conversation starts" });
  const replied = main.getByRole("list", { name: "When a user replies" });
  await expect(replied.getByRole("listitem")).toHaveCount(1);
  await expect(replied.getByRole("listitem")).toContainText("Enterprise repliesIn Enterprise: mark priority");
  const names = () => started.getByRole("listitem").locator("label");
  await expect(names()).toHaveText(["First", "Second", "Third"]);
  await checkpoint(owner, "workflows");

  // Dragged: Third on top of First.
  const row = (name: string) => started.getByRole("listitem").filter({ has: owner.getByText(name, { exact: true }) });
  await row("Third").dragTo(row("First"));
  await expect(owner.getByText("Moved Third")).toBeVisible();
  await expect(names()).toHaveText(["Third", "First", "Second"]);
  await expect.poll(async () => (await order("conversation_started")).map((workflow) => workflow.name)).toEqual(["Third", "First", "Second"]);

  // From the keyboard: the row's menu moves it down, and its menu has the focus again.
  const menu = (name: string) => owner.getByRole("button", { name: `Actions for ${name}` });
  await menu("Third").focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
  await owner.getByRole("menuitem", { name: "Move down" }).click();
  await expect(names()).toHaveText(["First", "Third", "Second"]);
  await expect(menu("Third")).toBeFocused();
  await expect.poll(async () => (await order("conversation_started")).map((workflow) => workflow.name)).toEqual(["First", "Third", "Second"]);

  // Turned off: it saves at once.
  await owner.getByRole("switch", { name: "Second" }).uncheck();
  await expect(owner.getByText("Second turned off")).toBeVisible();
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
  await expect(main.getByRole("heading", { level: 2, name: /^When/ }).first()).toHaveText("When a conversation starts 2");

  // On a phone: no handle to drag, the menu moves it; the switch stays as saved.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.reload();
  await expect(names()).toHaveText(["Third", "Second"]);
  await expect(owner.getByRole("switch", { name: "Second" })).not.toBeChecked();
  await expect(started.locator("svg.lucide-grip-vertical").first()).toBeHidden();
  await menu("Second").click();
  await owner.getByRole("menuitem", { name: "Move up" }).click();
  await expect(names()).toHaveText(["Second", "Third"]);
  await expect.poll(async () => (await order("conversation_started")).map((workflow) => workflow.name)).toEqual(["Second", "Third"]);
  // Nothing wider than the screen.
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "workflows-phone");
});
