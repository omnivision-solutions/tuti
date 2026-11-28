// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// A save that never answers: the dialog stays in its saving state.
const update = vi.fn(() => new Promise(() => {}));
// Turning a board on or off: each answers when the test says so.
const answers: (() => void)[] = [];
const setOff = vi.fn(() => new Promise<object>((resolve) => answers.push(() => resolve({}))));
// One client for the page, as the provider's.
const client = { boards: { update: { mutate: update }, setOff: { mutate: setOff } } };
vi.mock("@/components/trpc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/components/trpc")>()), useTRPCClient: () => client }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/label-translations", () => ({}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const { BoardMenu, BoardOnButton, EditBoardDialog } = await import("./boards");
const { InOrderProvider } = await import("./trpc");

beforeEach(() => {
  vi.clearAllMocks();
  answers.length = 0;
});

/** Feedback → Boards → Edit: its Save, after the board's Translations (outside its form). */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

const board = { id: "b1", name: "Ideas", slug: "ideas", description: null, postButton: null, titlePlaceholder: null, detailsPlaceholder: null, postVisibility: "PUBLIC" as const };

test("Save keeps keyboard focus while the board saves, says so, and can't be pressed again meanwhile", async () => {
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(h(EditBoardDialog, { projectSlug: "acme", board })));
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Edit")!.click());
  const save = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((button) => button.textContent === "Save")!;
  save.focus();
  await act(async () => save.click());
  expect(update).toHaveBeenCalledTimes(1);
  // Not `disabled` (the browser would move focus off it): marked disabled for assistive tech, and focus stays on it.
  expect(save.textContent).toBe("Saving…");
  expect(save.hasAttribute("disabled")).toBe(false);
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(save);
  await act(async () => save.click());
  expect(update).toHaveBeenCalledTimes(1);
});

test("Turn on, then Turn off from the board's menu before it's done: the second waits for the first, so the board ends off", async () => {
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  roots.push(root);
  const props = { projectSlug: "acme", boardId: "b1", name: "Ideas", off: true, teamOnly: false, stuck: false };
  // Off on screen, as the page shows it till its refresh: Turn on beside the menu; the menu's own Turn off, as after a refresh.
  await act(async () => root.render(h(InOrderProvider, null, h(BoardOnButton, props), h(BoardMenu, { ...props, off: false, deletable: false }))));
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Turn on")!.click());
  await act(async () => document.querySelector<HTMLElement>('[aria-label="More for Ideas"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Turn off")!.click());
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Turn off")!.click());
  // The second isn't sent while the first is on its way: tRPC calls don't wait for each other, server actions did.
  expect(setOff.mock.calls).toEqual([[{ project: "acme", board: "b1", off: false }]]);
  await act(async () => answers.shift()!());
  expect(setOff.mock.calls).toEqual([[{ project: "acme", board: "b1", off: false }], [{ project: "acme", board: "b1", off: true }]]);
});
