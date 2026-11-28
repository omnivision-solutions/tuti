// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/images", () => ({}));
vi.mock("@/server/rewrite", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
const mutate = vi.fn<(input: Record<string, unknown>) => Promise<object>>(async () => ({}));
vi.mock("@/components/trpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trpc")>()),
  useTRPCClient: () => ({ changelogStyle: { update: { mutate } } }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {} }) }));

const { ChangelogStyleForm } = await import("./changelog");

afterEach(() => {
  mutate.mockClear();
  document.body.replaceChildren();
});

const style = { tone: "Short and plain.", examples: [2], screenshotMarkers: true, coverDesign: "pattern" as const, coverBackground: { id: "media-1", url: "/media/media-1" } };
const published = [
  { number: 2, title: "Dark mode", sample: false },
  { number: 1, title: "Faster search", sample: false },
];

/** Settings → Changelog's form saved as it opened: what it sends to changelogStyle.update. */
async function saved(model: boolean) {
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(ChangelogStyleForm, { projectSlug: "acme", model: model ? h("div", null, "AI model") : null, ...style, published })));
  await act(async () => box.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mutate).toHaveBeenCalledTimes(1);
  return mutate.mock.calls[0]![0];
}

test("without AI, the form sends the cover's fields only: what drafts follow stays as it is", async () => {
  expect(await saved(false)).toEqual({ project: "acme", coverDesign: "pattern", coverBackground: "media-1" });
});

test("with AI, it sends how drafts are written too: the tone, the examples and the screenshot markers", async () => {
  expect(await saved(true)).toEqual({ project: "acme", tone: "Short and plain.", examples: [2], screenshotMarkers: true, coverDesign: "pattern", coverBackground: "media-1" });
});
