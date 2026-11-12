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
        for (const [property, value] of colours) {
          if (value && value !== "none" && !value.startsWith("url(") && isGreen(value)) {
            const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
            found.add(`<${element.tagName.toLowerCase()}${pseudo ?? ""} class="${String(element.getAttribute("class") ?? "").slice(0, 80)}"> "${name}" ${property}: ${value}`);
          }
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
    [visitor, "/sign-up"],
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
        await expect(launcher).toHaveCSS("background-color", "rgb(124, 58, 237)");
      }
      expect(await greens(page), `${scheme} ${path}`).toEqual([]);
    }
    await checkpoint(reader, `post-voted-${scheme}`);
  }
  // The widget's panel opened from the launcher, with its header in the accent.
  await reader.goto(`/feedback/feature-requests/${planned.number}`);
  await reader.locator('body > button[aria-controls="tuti-widget"]').click();
  const panel = reader.frameLocator("#tuti-widget iframe");
  await expect(panel.getByRole("navigation", { name: "Widget" })).toBeVisible();
  expect(await greens(reader)).toEqual([]);
  await checkpoint(reader, "widget-open-dark");
});
