import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/images", () => ({}));
vi.mock("@/server/rewrite", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({}) }));
// Rendered on its own, outside the app router: the form refreshes the page after a save.
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {} }) }));

const { ChangelogStyleForm, changelogStyleSaved } = await import("./changelog");

/** Settings → Changelog's form opens with nothing to save: what it says is saved is what its fields hold, as sent. */

const style = { tone: "Short and plain.", examples: [2], screenshotMarkers: true, coverDesign: "pattern" as const, coverBackground: { id: "media-1", url: "/media/media-1" } };
const published = [{ number: 2, title: "Dark mode" }];

/** The named fields the form is sent with, in order, as FormData would read them. */
function fields(html: string): [string, string][] {
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  const found: [string, string][] = [];
  for (const [tag] of form.matchAll(/<(input|textarea)\b[^>]*>(?:[^<]*<\/textarea>)?/g)) {
    const attr = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const name = attr("name");
    const type = attr("type");
    if (!name || type === "file" || ((type === "radio" || type === "checkbox") && !/\schecked(=""|\s|>)/.test(tag))) {
      continue;
    }
    found.push([name, tag.startsWith("<textarea") ? tag.replace(/^<textarea[^>]*>|<\/textarea>$/g, "") : (attr("value") ?? "on")]);
  }
  return found;
}

const render = (model: unknown) => renderToStaticMarkup(createElement(ChangelogStyleForm, { projectSlug: "acme", model: model as never, ...style, published }));

test("without AI, the form is the cover's fields only, and what's saved lists those only", () => {
  const html = render(null);
  expect(html).not.toContain("Drafting with AI");
  expect(fields(html)).toEqual(changelogStyleSaved({ drafting: false, ...style }));
  expect(fields(html).map(([name]) => name)).toEqual(["coverDesign", "coverBackground", "coverBackgroundUrl"]);
});

test("with AI, the form has how drafts are written too, and what's saved matches it", () => {
  const html = render(createElement("p", null, "AI model"));
  expect(html).toContain("Drafting with AI");
  expect(fields(html)).toEqual(changelogStyleSaved({ drafting: true, ...style }));
});
