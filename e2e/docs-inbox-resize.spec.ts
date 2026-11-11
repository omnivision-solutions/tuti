import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";
import { verifyEmail } from "./mail";

for (const pane of [
  { name: "docs tree", label: "Resize docs tree", selector: ".docs-tree-pane", path: "docs/collections/getting-started", min: 240, max: 440, default: 274 },
  { name: "conversation list", label: "Resize conversation list", selector: ".inbox-list-body", path: "inbox/1", min: 300, max: 520, default: 350 },
]) {
  test(`${pane.name} resizes with the mouse and keyboard and restores before hydration`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const checkpoint = checkpoints(testInfo);
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const team = await signUp(browser, APP_URL, "Tess Team");
    await createProject(team, "Acme Calendar", slug);
    await verifyEmail(team);
    const api = await apiFor(team, slug);
    await api("/collections", { name: "Getting started", icon: "rocket" });
    await api("/articles", { title: "Set up calendars and invite everyone on your team", collection: "getting-started" });
    await api("/conversations", { user: { id: "calendar-user", name: "Sam Example", email: "e2e-calendar@example.com" }, subject: "How can I share a calendar with everyone on my team?", body: "I would like to share our project calendar and keep everyone up to date." });
    await team.setViewportSize({ width: 1280, height: 900 });
    await team.goto(`/app/${slug}/${pane.path}`);
    const handle = team.getByRole("separator", { name: pane.label });
    const column = team.locator(pane.selector);
    const width = () => column.evaluate((element) => element.getBoundingClientRect().width);
    const fits = async (viewport = 1280) => {
      expect(await team.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport);
      for (const selector of [pane.name === "docs tree" ? ".docs-tree-expanded" : pane.selector, pane.name === "docs tree" ? ".docs-page-content" : ".inbox-thread"]) {
        expect(await team.locator(selector).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      }
      if (pane.name === "docs tree") {
        const title = (await team.getByRole("heading", { name: "Getting started", exact: true }).boundingBox())!;
        const actions = (await team.locator(".docs-heading-actions").boundingBox())!;
        expect(title.y + title.height <= actions.y || title.x + title.width <= actions.x).toBe(true);
      }
      if (pane.name === "conversation list") {
        if (viewport >= 1200) await expect(team.getByRole("complementary", { name: "Conversation details" })).toBeVisible();
        else await expect(team.getByRole("complementary", { name: "Conversation details" })).toBeHidden();
        expect((await team.locator("#conversation").boundingBox())!.width).toBeGreaterThan(280);
        const title = (await team.getByRole("heading", { name: "How can I share a calendar with everyone on my team?" }).boundingBox())!;
        expect(title.height).toBeLessThan(150);
      }
    };
    await expect(handle).toBeVisible();
    await expect(handle).toHaveCSS("cursor", "col-resize");
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-valuemin", String(pane.min));
    await expect(handle).toHaveAttribute("aria-valuemax", String(pane.max));
    expect(await width()).toBe(pane.default);
    const initialHandle = (await handle.boundingBox())!;
    const initialPane = (await column.boundingBox())!;
    expect(initialHandle.width).toBe(10);
    if (pane.name === "conversation list") {
      await team.getByRole("region", { name: "Conversations", exact: true }).getByRole("listitem").last().getByRole("link").first().focus();
      await team.keyboard.press("Tab");
      await expect(handle).toBeFocused();
    }
    expect(initialHandle.x + initialHandle.width / 2 - initialPane.x - initialPane.width).toBe(6);
    for (const theme of ["light", "dark"]) {
      await team.evaluate((theme) => { localStorage.setItem("theme", theme); document.documentElement.classList.remove("light", "dark"); document.documentElement.classList.add(theme); }, theme);
      await handle.evaluate((element) => element.blur());
      await team.mouse.move(0, 0);
      await checkpoint(team, `${pane.name}-${theme}-default`, { fullPage: false });
      await handle.focus();
      await team.keyboard.press("End");
      await expect(handle).toHaveAttribute("aria-valuenow", String(pane.max));
      expect(await width()).toBe(pane.max);
      await fits();
      await handle.hover();
      expect(await handle.locator("span").evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--primary)";
        document.body.append(probe);
        const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor;
        probe.remove();
        return matches;
      })).toBe(true);
      await checkpoint(team, `${pane.name}-${theme}-widened-hover`, { fullPage: false });
      await handle.dblclick();
      expect(await width()).toBe(pane.default);
    }
    // A drag keeps the cursor and selection lock even outside the gap, and clamps at both ends.
    for (const [delta, expected] of [[1500, pane.max], [-1500, pane.min]] as const) {
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await team.mouse.move(x, y);
      await team.mouse.down();
      await team.mouse.move(x + delta, y, { steps: 5 });
      await expect(team.locator("body")).toHaveCSS("cursor", "col-resize");
      await expect(team.locator("body")).toHaveCSS("user-select", "none");
      expect(await width()).toBe(expected);
      await team.mouse.up();
      await expect(team.locator("html")).not.toHaveAttribute("data-pane-resizing");
      await fits();
    }
    await handle.focus();
    await team.keyboard.press("Home");
    await team.keyboard.press("ArrowRight");
    expect(await width()).toBe(pane.min + 10);
    await team.keyboard.press("ArrowLeft");
    expect(await width()).toBe(pane.min);
    await team.keyboard.press("End");
    for (const viewport of [1024, 1200, 1280]) {
      await team.setViewportSize({ width: viewport, height: 900 });
      expect(await width()).toBe(pane.max);
      await fits(viewport);
    }
    await team.keyboard.press("ArrowLeft");
    const saved = pane.max - 10;
    expect(await width()).toBe(saved);

    // Block hydration: the inline restoration must size the server HTML itself, before React can fix it.
    await team.route(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/, (route) => route.abort());
    await team.reload({ waitUntil: "load" });
    expect(await width()).toBe(saved);
    await team.unroute(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/);
    await team.reload();
    await expect(handle).toHaveAttribute("aria-valuenow", String(saved));
    expect(await width()).toBe(saved);
    // A fresh marketing document enters the app on the client; its shell restores the preference too.
    await team.goto("/");
    await team.getByRole("link", { name: "Open app", exact: true }).first().click();
    await team.waitForURL(/\/app(?:\/|$)/);
    await team.getByRole("link", { name: pane.name === "docs tree" ? "Docs" : "Inbox", exact: true }).first().click();
    await expect(column).toBeVisible();
    expect(await width()).toBe(saved);
    await handle.dblclick();
    expect(await width()).toBe(pane.default);
    await team.reload();
    expect(await width()).toBe(pane.default);
    if (pane.name === "docs tree") {
      await team.getByRole("button", { name: "Hide the docs tree" }).click();
      await expect(handle).toBeHidden();
      await team.getByRole("button", { name: "Show the docs tree" }).click();
      expect(await width()).toBe(pane.default);
    }
    await team.goto(`/app/${slug}/${pane.path}`);
    // CSS defaults and the separator's px values agree even when the text is enlarged.
    await team.locator("html").evaluate((element) => { element.style.fontSize = "20px"; });
    expect(await width()).toBe(pane.default);
    await handle.focus();
    await team.keyboard.press("ArrowRight");
    expect(await width()).toBe(pane.default + 10);
    await handle.dblclick();
    await team.locator("html").evaluate((element) => { element.style.removeProperty("font-size"); });
    for (const viewport of [{ width: 820, height: 1000 }, { width: 390, height: 844 }]) {
      await team.setViewportSize(viewport);
      await expect(handle).toBeHidden();
    }
    await checkpoint(team, `${pane.name}-phone`, { fullPage: false });
  });
}
