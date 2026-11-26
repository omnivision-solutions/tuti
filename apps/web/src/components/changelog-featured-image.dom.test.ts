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
  // Its reason is its description, and the empty band's line instead of the hint: seen by everyone, touch screens too.
  const reason = document.getElementById(paused.getAttribute("aria-describedby")!)!;
  expect(reason.textContent).toBe("This project is out of credits");
  expect(reason.className).not.toContain("sr-only");
  expect(document.body.textContent).not.toContain("or drop one here");
  // Over a cover, the tooltip shows it; it's still the button's description.
  document.body.replaceChildren();
  const withCover = { ...entry, cover: { id: "cover1", url: "https://media.example/cover1.png" } } as typeof entry;
  const overCover = (await band({ entry: withCover, generator: { ...generator, paused: true } }))!;
  expect(document.getElementById(overCover.getAttribute("aria-describedby")!)?.textContent).toBe("This project is out of credits");
});

test("From this entry lists the form's cover first, then the text's images, the cover once", async () => {
  const cover = { id: "cover1", url: "https://media.example/cover1.png" };
  const other = { id: "body2", url: "https://media.example/body2.png" };
  const withCover = { ...entry, cover } as typeof entry;
  const generate = (await band({ entry: withCover, generator: { ...generator, bodyImages: [cover, other] } }))!;
  await act(async () => generate.click());
  const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((each) => (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name);
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.getAttribute("aria-label") === "Add a reference")!;
  await act(async () => add.click());
  await act(async () => item("From this entry")!.click());
  await vi.waitFor(() => expect(item("Image 1")).toBeTruthy());
  const listed = [...document.querySelectorAll<HTMLElement>('[role="menuitem"][aria-label^="Image"] img')].map((each) => each.getAttribute("src"));
  expect(listed).toEqual([cover.url, other.url]);
});
