// @vitest-environment happy-dom
import { act, createElement as h, useContext, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/rewrite", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/images", () => ({ generateImage: vi.fn() }));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({}) }));
vi.mock("@/lib/upload-image", () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const { ChangelogSaveButton, ChangelogSaving, ChangelogSavingContext } = await import("./changelog");

/** The changelog editor's Save in the top bar (ChangelogSaveButton): while saving, it keeps keyboard focus and does nothing. */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

test("Save keeps keyboard focus while its save is pending, and can't be pressed again meanwhile", async () => {
  const submitted = vi.fn((event: Event) => event.preventDefault());
  let setPending = (_: boolean) => {};
  // What the form's save sets: the top bar's Save reads it from ChangelogSaving.
  function Pending() {
    const saving = useContext(ChangelogSavingContext);
    useEffect(() => {
      setPending = (pending) => saving?.setPending(pending);
    }, [saving]);
    return null;
  }
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  await act(async () =>
    root.render(h(ChangelogSaving, null, h("form", { id: "entry", onSubmit: submitted }), h(ChangelogSaveButton, { form: "entry" }), h(Pending))),
  );
  const save = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  save.focus();
  await act(async () => setPending(true));
  // Not `disabled` (the browser would move focus off it): marked disabled for assistive tech, and focus stays on it.
  expect(save.textContent).toBe("Saving…");
  expect(save.hasAttribute("disabled")).toBe(false);
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(save);
  // Pressed again while it saves: nothing is sent.
  await act(async () => save.click());
  expect(submitted).not.toHaveBeenCalled();
});
