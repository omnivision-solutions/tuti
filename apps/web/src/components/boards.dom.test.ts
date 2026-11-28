// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

// A save that never answers: the dialog stays in its saving state.
vi.mock("@/server/boards", () => ({ updateBoard: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/server/label-translations", () => ({}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const { EditBoardDialog } = await import("./boards");

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
  const { updateBoard } = await import("@/server/boards");
  save.focus();
  await act(async () => save.click());
  expect(updateBoard).toHaveBeenCalledTimes(1);
  // Not `disabled` (the browser would move focus off it): marked disabled for assistive tech, and focus stays on it.
  expect(save.textContent).toBe("Saving…");
  expect(save.hasAttribute("disabled")).toBe(false);
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(save);
  await act(async () => save.click());
  expect(updateBoard).toHaveBeenCalledTimes(1);
});
