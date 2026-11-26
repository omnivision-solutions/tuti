// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/images", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { FeaturedImage } = await import("./changelog");

afterEach(() => document.body.replaceChildren());

const entry = { number: 1, title: "Dark mode", cover: null } as unknown as Parameters<typeof FeaturedImage>[0]["entry"];
const generator = { credits: true, paused: false, logo: null, bodyImages: [] };

async function band(props: Partial<Parameters<typeof FeaturedImage>[0]>) {
  const box = document.createElement("form");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(FeaturedImage, { projectSlug: "acme", entry, onBusy: () => {}, onChange: () => {}, ...props })));
  return [...box.querySelectorAll("button")].find((each) => each.textContent?.trim() === "Generate");
}

test("Generate is offered only where the server makes images; out of credits it shows, off, saying why", async () => {
  expect(await band({ generator: null })).toBeUndefined();
  document.body.replaceChildren();
  const offered = (await band({ generator }))!;
  expect(offered.getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => offered.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Cover for “Dark mode”");
  document.body.replaceChildren();
  const paused = (await band({ generator: { ...generator, paused: true } }))!;
  expect(paused.getAttribute("aria-disabled")).toBe("true");
  expect(paused.title).toBe("This project is out of credits");
});
