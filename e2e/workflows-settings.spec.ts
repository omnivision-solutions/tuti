import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { spendCredits } from "./credits";
import { query } from "./db";
import { APP_URL } from "./env";
import { apiFor, createProject, holdActions, signUp } from "./helpers";

test("an owner sees the path in Settings → Workflows, reorders a trigger's workflows by dragging and from the menu, turns one off and deletes one, on a phone too", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
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
  await expect(main.getByRole("heading", { level: 2, name: /^When/ })).toHaveText(["When a conversation starts 3", "When a user replies 1", "When a conversation is about to go to a person 0"]);
  await expect(main.getByText("Built in")).toHaveCount(3);
  // The path, in the order a message takes it: the AI answers once the message triggers have run.
  const path = ["Spam filter", "When a conversation starts", "When a user replies", "AI answers first", "When a conversation is about to go to a person", "Hand to the team"];
  const inOrder = async () => {
    const text = await main.innerText();
    const found = path.map((step) => text.indexOf(step));
    return found.every((index, i) => index >= 0 && (i === 0 || index > found[i - 1]!));
  };
  await expect.poll(inOrder).toBe(true);
  // No published articles yet: off for now, whatever its switches say (its own journey below).
  await expect(main).toContainText("Off for now: No published articles");
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

  // From the keyboard: the row's menu moves it down, past the one not shown, and its menu has the focus again. Once the
  // drag's save has landed: the menus are disabled while one saves.
  await expect(started).not.toHaveAttribute("aria-busy", "true");
  const menu = (name: string) => owner.getByRole("button", { name: `Actions for ${name}` });
  await menu("Third").focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
  await owner.keyboard.press("Escape");
  // Closed before the next opens: a menu closing still has its items for a moment, so two would match "Move down".
  await expect(owner.getByRole("menuitem")).toHaveCount(0);
  // A row's name opens its editor (its own journey, workflow-editor.spec.ts), and each group adds one there.
  await expect(started.getByRole("link", { name: "Second" })).toHaveAttribute("href", /\/settings\/workflows\/[^/]+$/);
  await expect(main.getByRole("link", { name: "Add workflow when a user replies" })).toHaveAttribute("href", `/app/${slug}/settings/workflows/new?trigger=user_replied`);

  // The page's saves held until the switch below has been turned, so the move lands after the focus went on.
  const release = await holdActions(owner);
  await menu("First").focus();
  await owner.keyboard.press("Enter");
  await owner.getByRole("menuitem", { name: "Move down" }).click();
  await expect(names()).toHaveText(["Third", "Second", "First"]);
  await expect(menu("First")).toBeFocused();

  // Turned off from the keyboard while the move saves: it saves at once, and keeps the focus once the move has landed.
  await expect(owner.getByRole("menuitem")).toHaveCount(0);
  await owner.getByRole("switch", { name: "Second" }).focus();
  await owner.keyboard.press("Space");
  await expect(owner.getByRole("switch", { name: "Second" })).not.toBeChecked();
  await expect(owner.getByRole("switch", { name: "Second" })).toBeFocused();
  await release();
  await expect(owner.getByText("Moved First")).toBeVisible();
  await expect(started).not.toHaveAttribute("aria-busy", "true");
  await expect(owner.getByText("Second turned off")).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Second" })).not.toBeChecked();
  await expect(owner.getByRole("switch", { name: "Second" })).toBeFocused();
  await expect.poll(stored).toEqual(["Third", "Later", "Second", "First"]);
  await expect.poll(async () => (await order("conversation_started")).map((workflow) => workflow.name)).toEqual(["Third", "Second", "First"]);
  await expect.poll(async () => (await order("conversation_started")).find((workflow) => workflow.name === "Second")?.enabled).toBe(false);

  const thirdSwitch = owner.getByRole("switch", { name: "Third" });
  // Turned off, but stored on (as when a teammate turns it back on as this saves; here a trigger on its row in the
  // journeys' own database keeps it on): once nothing saves, the switch shows what's stored, not the turn.
  const thirdId = (await order("conversation_started")).find((workflow) => workflow.name === "Third")!.id;
  const keepOn = `e2e_keep_on_${randomUUID().replaceAll("-", "")}`;
  await query(`CREATE FUNCTION ${keepOn}() RETURNS trigger AS $$ BEGIN NEW.enabled := true; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await query(`CREATE TRIGGER ${keepOn} BEFORE UPDATE ON workflow FOR EACH ROW WHEN (NEW.id = '${thirdId}') EXECUTE FUNCTION ${keepOn}()`);
  try {
    await thirdSwitch.click();
    await expect(owner.getByText("Third turned off")).toBeVisible();
    await expect(thirdSwitch).toBeChecked();
  } finally {
    await query(`DROP TRIGGER ${keepOn} ON workflow`);
    await query(`DROP FUNCTION ${keepOn}()`);
  }

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
  // The live stream never opens from here on: opening (or reopening), it refreshes the page, which could take the row
  // deleted below away and hide whether a refused switch goes back on.
  await owner.route("**/api/live?*", () => {});
  await owner.reload();
  await expect(names()).toHaveText(["Third", "Second"]);
  await expect(owner.getByRole("switch", { name: "Second" })).not.toBeChecked();
  await expect(started.locator("svg.lucide-grip-vertical").first()).toBeHidden();
  await menu("Second").click();
  await owner.getByRole("menuitem", { name: "Move up" }).click();
  await expect(names()).toHaveText(["Second", "Third"]);
  await expect.poll(stored).toEqual(["Second", "Third", "Later"]);
  // The move landed on the page too, so its refresh doesn't come after the delete below and take the row away.
  await expect(started).not.toHaveAttribute("aria-busy", "true");
  // A switch the server refuses (the workflow was deleted meanwhile, through the API) goes back as it was, then the row
  // goes once the page catches up. Every server action here refreshes the page when it answers, a refused one too (the
  // proxy sets the last project's cookie on each request, which Next takes as a change): that refresh is held until the
  // switch has been checked, so only the switch's own handling of the refusal can have put it back on.
  let refreshed!: () => void;
  const held = new Promise<void>((done) => (refreshed = done));
  const holdRefresh = async (route: Route) => {
    if (route.request().method() === "GET" && route.request().headers()["rsc"]) await held;
    await route.fallback();
  };
  await owner.route("**/*", holdRefresh);
  const third = (await order("conversation_started")).find((workflow) => workflow.name === "Third")!;
  await api(`/workflows/${third.id}`, undefined, "DELETE");
  await owner.getByRole("switch", { name: "Third" }).click();
  await expect(owner.getByText("There's no workflow with that id")).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Third" })).toBeChecked();
  refreshed();
  await owner.unroute("**/*", holdRefresh);
  await expect(owner.getByRole("switch", { name: "Third" })).toHaveCount(0);
  await expect(names()).toHaveText(["Second"]);
  // Nothing wider than the screen.
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "workflows-phone");
});

test("an owner turns AI answers first off and on for the widget and email, names its emails, and sees what keeps it off", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.setViewportSize({ width: 1280, height: 900 });
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const main = owner.getByRole("main");
  const row = main.getByRole("listitem").filter({ hasText: "AI answers first" });

  // Nothing published: off for now, said on the row and on its page.
  await owner.goto(`/app/${slug}/settings/workflows`);
  await expect(row).toContainText("Off for now: No published articles");
  await row.getByRole("link", { name: "AI answers first settings" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/workflows/ai-first`);
  await expect(owner).toHaveTitle(/AI answers first · Workflows · Settings · Acme/);
  await expect(main.getByRole("status")).toHaveText(/Off for nowNo published articles/);
  const widget = main.getByRole("switch", { name: "Widget" });
  const email = main.getByRole("switch", { name: "Email" });
  const name = main.getByRole("textbox", { name: "Name on emails" });
  await expect(widget).toBeChecked();
  await expect(email).not.toBeChecked();
  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("placeholder", "Acme");

  // Widget off, email on, a name: saved, as the API reads it.
  await widget.click();
  await email.click();
  await name.fill("Ada");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("AI answers first saved")).toBeVisible();
  await expect.poll(async () => api("/ai-first", undefined, "GET")).toMatchObject({ widget: false, email: true, name: "Ada", offFor: ["no_articles"] });

  // An article published: on, for email alone.
  const article = await api("/articles", { title: "Exporting", body: "Settings → Export downloads everything as CSV." });
  await api(`/articles/${article.slug}/publish`, {});
  await owner.reload();
  await expect(main.getByRole("status")).toHaveCount(0);
  await expect(email).toBeChecked();
  await expect(name).toHaveValue("Ada");
  await checkpoint(owner, "ai-first");
  await main.getByRole("region", { name: "AI answers first" }).getByRole("link", { name: "Workflows" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/workflows`);
  await expect(row).toContainText("On for email");

  // Out of AI credits: off for now, for that.
  await spendCredits(slug);
  await owner.reload();
  await expect(row).toContainText("Off for now: Out of AI credits");

  // Both off, then the widget on again from its page; the name cleared.
  await row.getByRole("link", { name: "AI answers first settings" }).click();
  await expect(main.getByRole("status")).toHaveText(/Out of AI credits/);
  await email.click();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("AI answers first saved")).toBeVisible();
  await owner.goto(`/app/${slug}/settings/workflows`);
  await expect(row).toContainText("Off");
  await row.getByRole("link", { name: "AI answers first settings" }).click();
  await widget.click();
  await name.fill("");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("AI answers first saved")).toBeVisible();
  await expect.poll(async () => api("/ai-first", undefined, "GET")).toMatchObject({ widget: true, email: false, name: null });

  // On a phone.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.reload();
  await expect(widget).toBeVisible();
  await checkpoint(owner, "ai-first-phone");
});
