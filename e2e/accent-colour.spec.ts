import { randomUUID } from "node:crypto";

import pg from "pg";

import { expect, type Page, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

/**
 * Every colour an element of the page shows (text, fill, its drawn edges, outline, SVG paint, gradient and shadow
 * colours; ::before and ::after too) that is green: Tuti's own accent, on a portal whose team picked another. Allowed:
 * "Powered by tuti" (Tuti's own mark) and a status's colour (Completed is green whatever the accent: it says what
 * happened, docs/design.md → Accent colour).
 */
function greens(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    // A CSS colour as the browser paints it, in OKLCH (hue in degrees): null where nothing shows.
    const oklch = (css: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data as unknown as number[];
      if (a! < 8) {
        return null;
      }
      const linear = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const [R, G, B] = [linear(r!), linear(g!), linear(b!)];
      const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
      const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
      const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
      const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
      const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      return { c: Math.hypot(A, Bb), h: ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360 };
    };
    // Tuti's green is hue ~155; Completed's 150. Low chroma (greys with a tint of the paper) isn't a colour.
    const isGreen = (css: string) => {
      const colour = oklch(css);
      return !!colour && colour.c >= 0.04 && colour.h >= 130 && colour.h <= 175;
    };
    const colourIn = /(?:rgba?|oklch|oklab|lab|lch|hsla?|color)\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-f]{3,8}\b/gi;
    const found = new Set<string>();
    const allowed = (element: Element) => element.closest('a[href="https://tuti.so"]') || element.closest('[class*="status-completed"]');
    for (const element of document.querySelectorAll("body *")) {
      if (allowed(element)) {
        continue;
      }
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) {
        continue;
      }
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (style.display === "none" || style.visibility === "hidden" || (pseudo && style.content === "none")) {
          continue;
        }
        const colours: [string, string][] = [
          ["color", style.color],
          ["background-color", style.backgroundColor],
          ["fill", style.fill],
          ["stroke", style.stroke],
          ["caret-color", style.caretColor],
          ["text-decoration-color", style.textDecorationColor],
          ["outline-color", style.outlineColor],
        ];
        for (const side of ["top", "right", "bottom", "left"] as const) {
          if (parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) {
            colours.push([`border-${side}-color`, style.getPropertyValue(`border-${side}-color`)]);
          }
        }
        for (const property of ["background-image", "box-shadow"] as const) {
          for (const colour of style.getPropertyValue(property).match(colourIn) ?? []) {
            colours.push([property, colour]);
          }
        }
        // The first green of each element (its caret and underline are its text's colour too).
        const green = colours.find(([, value]) => value && value !== "none" && !value.startsWith("url(") && isGreen(value));
        if (green) {
          const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
          found.add(`<${element.tagName.toLowerCase()}${pseudo ?? ""} class="${String(element.getAttribute("class") ?? "").slice(0, 80)}"> "${name}" ${green[0]}: ${green[1]}`);
        }
      }
    }
    return [...found];
  });
}

test("a portal with its own accent colour shows no trace of Tuti's green: every kind of page and the widget, in light and dark", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // A purple accent and a font of the project's own (Settings → Branding).
  await api("/branding", { color: "#7c3aed", fonts: { heading: "playfair-display", body: null } }, "PATCH");

  // Something on every page: ideas in each status (one voted for, one with the team's reply), a changelog entry built
  // from one, a docs article, Messages on.
  const post = (title: string) => api("/posts", { board: "feature-requests", title, body: "Details of the idea." }) as unknown as Promise<{ number: number }>;
  const planned = await post("Calendar sync");
  const progress = await post("Dark mode for the dashboard");
  const shipped = await post("Export to CSV");
  await post("Slack notifications");
  await api(`/posts/${planned.number}`, { status: "planned", eta: "2030-01" }, "PATCH");
  await api(`/posts/${progress.number}`, { status: "in_progress" }, "PATCH");
  await api(`/posts/${shipped.number}`, { status: "completed" }, "PATCH");
  await api(`/posts/${planned.number}/comments`, { body: "We're on it: it's next after dark mode." });
  const entry = (await api("/changelog", { title: "CSV export is here", body: "Download any report as a CSV file.", tags: ["new"], posts: [shipped.number] })) as unknown as {
    number: number;
  };
  await api(`/changelog/${entry.number}/publish`, { announce: true });
  const article = await api("/articles", { title: "Getting started", body: "Create a board, then share your portal.\n\n## Invite your team\n\nOpen Settings, then Team." });
  await api(`/articles/${article.slug}/publish`, {});
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  await client.query(`UPDATE project SET "supportInbox" = true WHERE slug = $1`, [slug]);
  await client.end();

  // A reader, signed in on the portal, who has voted.
  const reader = await signUp(browser, portalUrl(slug), "Ada Reader");
  await reader.goto(`/feedback/feature-requests/${planned.number}`);
  await reader.getByRole("button", { name: /^Upvote \(/ }).click();
  await expect(reader.getByRole("button", { name: /^Upvoted \(/ })).toBeVisible();
  const visitor = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();

  const pages: [Page, string][] = [
    [reader, "/feedback"],
    [reader, "/feedback/feature-requests"],
    [reader, `/feedback/feature-requests/${planned.number}`],
    [reader, `/feedback/feature-requests/${shipped.number}`],
    [reader, "/roadmap"],
    [reader, "/changelog"],
    [reader, `/changelog/${entry.number}`],
    [reader, "/docs"],
    [reader, `/docs/${article.slug}`],
    [reader, "/docs?q=board"],
    [reader, "/account"],
    [reader, "/no-such-page"],
    [visitor, "/sign-in"],
    [visitor, "/forgot-password"],
    [visitor, `/feedback/feature-requests/${planned.number}`],
    [reader, "/widget"],
    [reader, "/widget?tab=feedback"],
    [reader, "/widget?tab=docs"],
    [reader, "/widget?tab=messages"],
    [reader, "/widget?tab=whats-new"],
  ];
  for (const scheme of ["light", "dark"] as const) {
    for (const [page, path] of pages) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(path);
      await expect(page.locator("main").first()).toBeVisible();
      // The accent is the project's: the page took it.
      await expect.poll(() => page.locator("html").evaluate((html) => getComputedStyle(html).getPropertyValue("--primary").trim())).toBe("#7c3aed");
      if (!path.startsWith("/widget")) {
        // The widget's launcher, the loader's own button on the page, without a colour of its own: the accent too.
        const launcher = page.locator('body > button[aria-controls="tuti-widget"]');
        await expect(launcher).toBeVisible();
        await expect.soft(launcher).toHaveCSS("background-color", "rgb(124, 58, 237)");
      }
      expect.soft(await greens(page), `${scheme} ${path}`).toEqual([]);
      await checkpoint(page, `${scheme} ${path}`);
    }
  }
  // The portal's shared look (docs/design.md → Portals → Accent, Surfaces), in light and dark: "Powered by tuti" in Tuti's
  // own green, whatever the accent; secondary buttons and vote boxes grey fills without an edge, a vote cast the accent's
  // tint; rows split by the light divider; cards without an outline in light, a faint ring in dark; the scrollbar's room
  // always kept, so the header never shifts.
  // A colour token as the browser computes an element's colour (custom properties keep the CSS's own spelling).
  const token = (page: Page, name: string) =>
    page.evaluate((n) => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.color = `var(${n})`;
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    }, name);
  const ringOf = (shadow: string) => /[a-z]+\([^)]*\) 0px 0px 0px 1px/.exec(shadow)?.[0] ?? "";
  for (const scheme of ["light", "dark"] as const) {
    await reader.emulateMedia({ colorScheme: scheme });
    await reader.goto("/feedback/feature-requests");
    const main = reader.getByRole("main");
    await expect(reader.locator("html")).toHaveCSS("scrollbar-gutter", "stable");
    await expect(reader.locator('a[href="https://tuti.so"] svg path').first()).toHaveCSS("fill", await token(reader, "--tuti"));
    const secondary = await token(reader, "--secondary");
    const getUpdates = reader.getByRole("button", { name: "Get updates" }).filter({ visible: true }).first();
    await expect(getUpdates).toHaveCSS("background-color", secondary);
    await expect(getUpdates).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    const notVoted = main.getByRole("button", { name: /^Upvote \(/ }).first();
    await expect(notVoted).toHaveCSS("background-color", secondary);
    await expect(notVoted).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    const voted = main.getByRole("button", { name: /^Remove vote \(/ });
    await expect(voted).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    if (scheme === "light") {
      expect(await voted.evaluate((button) => getComputedStyle(button).backgroundColor)).toMatch(/^oklch\(0\.955 0\.035 29[0-9.]+\)$/);
    }
    await expect(main.locator("ul.divide-y > li").nth(1)).toHaveCSS("border-top-color", await token(reader, "--divider"));
    await reader.goto("/roadmap");
    const card = reader.getByRole("main").getByRole("listitem").filter({ hasText: "Calendar sync" }).first();
    const ring = ringOf(await card.evaluate((element) => getComputedStyle(element).boxShadow));
    if (scheme === "light") {
      expect(ring === "" || ring.startsWith("rgba(0, 0, 0, 0)")).toBe(true);
    } else {
      expect(ring).toContain(await token(reader, "--divider"));
    }
  }
  // The widget's panel takes the portal's look (docs/design.md → Portals → Widget), in light and dark: the project's fonts,
  // one surface of rows split by the divider (no cards), the open tab a neutral pill (not the accent), vote boxes grey
  // fills, and a vote cast the accent's tint with a ring.
  await reader.setViewportSize({ width: 400, height: 600 });
  for (const scheme of ["light", "dark"] as const) {
    await reader.emulateMedia({ colorScheme: scheme });
    await reader.goto("/widget");
    await expect(reader.getByText("Acme", { exact: true })).toHaveCSS("font-family", /playfairDisplay/);
    const surface = await token(reader, "--card");
    await expect(reader.getByRole("main")).toHaveCSS("background-color", surface);
    const send = reader.getByRole("link", { name: /^Send us a message/ });
    await expect(send).toHaveCSS("border-top-width", "0px");
    const ideaRow = reader.getByRole("link", { name: /^Share an idea/ }).locator("..");
    await expect(ideaRow).toHaveCSS("border-bottom-width", "1px");
    await expect(ideaRow).toHaveCSS("border-bottom-color", await token(reader, "--divider"));
    const home = reader.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Home" });
    await expect(home.locator("span").first()).toHaveCSS("background-color", await token(reader, "--accent"));
    await expect(home.locator("svg")).toHaveCSS("color", await token(reader, "--foreground"));
    await checkpoint(reader, `widget home ${scheme}`);

    await reader.goto("/widget?tab=feedback");
    const ideas = reader.getByRole("region", { name: "Ideas" });
    const notVoted = ideas.getByRole("button", { name: /^Upvote \(/ }).first();
    await expect(notVoted).toHaveCSS("background-color", await token(reader, "--secondary"));
    await expect(notVoted).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    const voted = ideas.getByRole("button", { name: /^Remove vote \(/ });
    await expect(voted).toHaveCSS("background-color", await token(reader, "--soft"));
    await expect.poll(() => voted.evaluate((button) => getComputedStyle(button).boxShadow)).toMatch(/inset/);
    await expect(ideas.getByRole("listitem").first()).toHaveCSS("border-bottom-color", await token(reader, "--divider"));
    await expect(ideas.getByRole("list")).toHaveCSS("border-top-width", "0px");
    await checkpoint(reader, `widget feedback ${scheme}`);
  }
  await reader.setViewportSize({ width: 1280, height: 720 });

  // The widget and the app keep the browser's scrollbar (it's only the portal's pages that keep its room).
  await reader.goto("/widget");
  await expect(reader.locator("html")).toHaveCSS("scrollbar-gutter", "auto");
  await owner.goto(`/app/${slug}`);
  await expect(owner.locator("html")).toHaveCSS("scrollbar-gutter", "auto");

  // On a phone, the header's menu marks the open part with a neutral fill, not the accent nor Tuti's green.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.emulateMedia({ colorScheme: "light" });
  await reader.goto("/feedback/feature-requests");
  await reader.getByRole("button", { name: "Menu" }).click();
  const menu = reader.getByRole("dialog", { name: "Menu" });
  const open = menu.getByRole("navigation", { name: "Portal" }).locator('[aria-current="page"]');
  await expect(open).toHaveText("Feedback");
  expect(await open.evaluate((link) => getComputedStyle(link).backgroundColor)).toBe(await token(reader, "--accent"));
  expect(await greens(reader)).toEqual([]);
  await checkpoint(reader, "phone-menu");
  await reader.setViewportSize({ width: 1280, height: 720 });
  await reader.emulateMedia({ colorScheme: "dark" });

  // The widget's panel opened from the launcher, with its header in the accent.
  await reader.goto(`/feedback/feature-requests/${planned.number}`);
  await reader.locator('body > button[aria-controls="tuti-widget"]').click();
  const panel = reader.frameLocator("#tuti-widget iframe");
  await expect(panel.getByRole("navigation", { name: "Widget" })).toBeVisible();
  expect(await greens(reader)).toEqual([]);
  await checkpoint(reader, "widget-open-dark");

  // Settings → Widget: the launcher's colour is the accent until the team gives it one of its own, and back.
  await owner.goto(`/app/${slug}/settings/widget`);
  const hex = owner.getByLabel("Colour", { exact: true });
  await expect(hex).toHaveValue("#7c3aed");
  const useAccent = owner.getByRole("button", { name: "Use the accent colour" });
  await expect(useAccent).toHaveCount(0);
  await hex.fill("#0f766e");
  await useAccent.click();
  await expect(hex).toHaveValue("#7c3aed");
  await expect(useAccent).toHaveCount(0);
  // A colour of its own, saved, stays its own when the accent becomes the same colour...
  await hex.fill("#0f766e");
  const save = owner.getByRole("button", { name: "Save changes" });
  await save.click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await api("/branding", { color: "#0f766e" }, "PATCH");
  await owner.reload();
  await expect(hex).toHaveValue("#0f766e");
  // ...until the team says it follows the accent again: then it does, through later changes to the accent.
  await useAccent.click();
  await expect(useAccent).toHaveCount(0);
  await save.click();
  await expect(owner.getByText("Widget saved").last()).toBeVisible();
  await api("/branding", { color: "#7c3aed" }, "PATCH");
  await owner.reload();
  await expect(hex).toHaveValue("#7c3aed");
  await expect(useAccent).toHaveCount(0);
});

test("a vote cast and a reaction of yours show more than a tint, with Tuti's green or a near-black accent", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/posts", { board: "feature-requests", title: "Calendar sync" });
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  const entry = (await api("/changelog", { title: "CSV export is here", body: "Download any report as a CSV file.", tags: ["new"] })) as unknown as { number: number };
  await api(`/changelog/${entry.number}/publish`, {});

  const reader = await signUp(browser, portalUrl(slug), "Ada Reader");
  await reader.setViewportSize({ width: 1280, height: 900 });
  const main = reader.getByRole("main");
  const rowOf = (title: string) => main.getByRole("listitem").filter({ has: reader.getByRole("link", { name: title, exact: true }) });
  // A 1px ring in a colour that shows (the tint alone can be the grey's twin): the box-shadow's, if any.
  const ring = (locator: ReturnType<typeof reader.locator>) =>
    locator.evaluate((element) => {
      const shadow = getComputedStyle(element).boxShadow;
      const found = /([a-z]+\([^)]*\)) 0px 0px 0px 1px/.exec(shadow)?.[1] ?? "";
      return found && !/^rgba\([^)]*, 0\)$/.test(found) && !/\/ 0\)$/.test(found) ? found : "";
    });
  await reader.goto("/feedback/feature-requests");
  await rowOf("Calendar sync").getByRole("button", { name: /^Upvote \(/ }).click();
  await expect(rowOf("Calendar sync").getByRole("button", { name: /^Remove vote \(/ })).toBeEnabled();
  await reader.goto(`/changelog/${entry.number}`);
  const thumbs = main.getByRole("button", { name: /^React with 👍/ });
  await thumbs.click();
  await expect(thumbs).toHaveAttribute("aria-pressed", "true");
  await expect(thumbs).toBeEnabled();

  for (const color of [null, "#222222"]) {
    if (color) {
      await api("/branding", { color }, "PATCH");
    }
    await reader.goto("/feedback/feature-requests");
    await expect.soft.poll(() => ring(rowOf("Calendar sync").getByRole("button", { name: /^Remove vote \(/ })), `${color} vote cast`).not.toBe("");
    expect.soft(await ring(rowOf("Dark mode").getByRole("button", { name: /^Upvote \(/ })), `${color} no vote`).toBe("");
    await checkpoint(reader, `board ${color ?? "default"}`, { fullPage: false });
    await reader.goto(`/changelog/${entry.number}`);
    await expect(thumbs).toHaveAttribute("aria-pressed", "true");
    expect.soft(await ring(thumbs), `${color} reaction of yours`).not.toBe("");
    expect.soft(await ring(main.getByRole("button", { name: /^React with 🎉/ })), `${color} no reaction`).toBe("");
    // Keyboard focus still shows on it: the focus ring replaces the thin one.
    const unfocused = await thumbs.evaluate((element) => getComputedStyle(element).boxShadow);
    await main.getByRole("button", { name: /^React with ❤️/ }).focus();
    await reader.keyboard.press("Shift+Tab");
    await expect(thumbs).toBeFocused();
    // (polled: the button's shadow transitions)
    await expect.soft.poll(() => thumbs.evaluate((element) => getComputedStyle(element).boxShadow), `${color} focused reaction of yours`).not.toBe(unfocused);
    await checkpoint(reader, `changelog ${color ?? "default"}`, { fullPage: false });
  }
});
