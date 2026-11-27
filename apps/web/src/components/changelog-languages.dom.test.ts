// @vitest-environment happy-dom
import { act, createContext, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const saveChangelogVersion = vi.fn();
const keepChangelogVersionUpToDate = vi.fn();
vi.mock("@/server/changelog", () => ({ saveChangelogVersion, keepChangelogVersionUpToDate }));
// The editor's saving context (its Save in the top bar says when it's saving), without the rest of the changelog editor.
const setPending = vi.fn();
const ChangelogSavingContext = createContext<{ setPending: (pending: boolean) => void } | null>(null);
vi.mock("@/components/changelog", () => ({ ChangelogSavingContext, ChangelogSaveButton: () => null }));
vi.mock("next/link", () => ({ default: ({ href, ...props }: { href: string }) => h("a", { href, ...props }) }));
vi.mock("@/server/media", () => ({ uploadStatus: vi.fn() }));
vi.mock("@/server/images", () => ({ generateImage: vi.fn() }));
vi.mock("@/lib/upload-image", () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }));
const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
vi.mock("sonner", () => ({ toast }));

const { ChangelogVersionForm } = await import("./changelog-languages");
type VersionView = import("./changelog-languages").VersionView;
const { forgetPageTries } = await import("./rich-editor");

/** A changelog entry's version form (the language pill's other languages): saving, Keep up to date, and what they keep. */

const roots: Root[] = [];
beforeEach(() => {
  saveChangelogVersion.mockReset();
  keepChangelogVersionUpToDate.mockReset();
  setPending.mockReset();
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  forgetPageTries();
});

const doc = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Wechsle das Design." }] }] };
const languages = [
  { code: "en", name: "English", state: "default" as const, href: "/app/acme/changelog/1" },
  { code: "de", name: "Deutsch", state: "current" as const, href: "/app/acme/changelog/1?language=de" },
];
const view: VersionView = { code: "de", name: "Deutsch", state: "current", keepUpToDate: true, version: "v1", waiting: null, title: "Dunkler Modus", content: doc };

async function form(props: Partial<typeof view> = {}) {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  const render = (changes: Partial<typeof view>) =>
    act(async () =>
      root.render(
        h(ChangelogSavingContext, { value: { setPending } }, h(ChangelogVersionForm, { projectSlug: "acme", number: 1, defaultName: "English", view: { ...view, ...changes }, mediaUrls: null, languages })),
      ),
    );
  await render(props);
  return { render };
}

const title = () => document.querySelector<HTMLInputElement>('input[name="title"]')!;
const keep = () => document.querySelector<HTMLInputElement>('[role="switch"]')!;
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = () => act(async () => void document.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));

test("a failed save keeps what was typed and says why; the top bar's Save shows it's saving meanwhile", async () => {
  let answer = (_: unknown) => {};
  saveChangelogVersion.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await form();
  type(title(), "Dunkler Modus für alle");
  await submit();
  expect(setPending).toHaveBeenLastCalledWith(true);
  // The version read goes with it.
  expect((saveChangelogVersion.mock.calls[0]![4] as FormData).get("version")).toBe("v1");
  await act(async () => answer({ error: "It or the entry changed since you opened it" }));
  expect(setPending).toHaveBeenLastCalledWith(false);
  expect(title().value).toBe("Dunkler Modus für alle");
  expect(document.body.textContent).toContain("It or the entry changed since you opened it");
});

test("Keep up to date follows what's saved, and unsaved edits stay as it changes", async () => {
  keepChangelogVersionUpToDate.mockResolvedValue({});
  const { render } = await form();
  expect(keep().checked).toBe(true);
  type(title(), "Noch nicht gespeichert");
  keep().focus();
  await act(async () => keep().click());
  expect(keepChangelogVersionUpToDate).toHaveBeenCalledWith("acme", 1, "de", false, "v1");
  // The page's next read: saved off, the same text.
  await render({ keepUpToDate: false, version: "v2" });
  expect(keep().checked).toBe(false);
  // The same switch: keyboard focus stays on it.
  expect(document.activeElement).toBe(keep());
  expect(title().value).toBe("Noch nicht gespeichert");
  // The page's new read (the entry or the product setting changed meanwhile, the text didn't): a save still goes with the
  // token the text was loaded with, so the server refuses it rather than marking the edit up to date.
  expect(document.querySelector<HTMLInputElement>('input[name="version"]')!.value).toBe("v1");
  // Turned on elsewhere (a teammate), then off by a save of this text: the switch shows the server's value each time.
  await render({ keepUpToDate: true, version: "v3" });
  expect(keep().checked).toBe(true);
  await render({ keepUpToDate: false, version: "v4" });
  expect(keep().checked).toBe(false);
});

test("turning Keep up to date on over the team's own text asks first", async () => {
  keepChangelogVersionUpToDate.mockResolvedValue({});
  await form({ state: "written", keepUpToDate: false });
  await act(async () => keep().click());
  expect(keepChangelogVersionUpToDate).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Translate it again?");
  const button = [...document.querySelectorAll("button")].find((each) => each.textContent === "Translate again")!;
  await act(async () => button.click());
  expect(keepChangelogVersionUpToDate).toHaveBeenCalledWith("acme", 1, "de", true, "v1");
});

test("a save that leaves the text as it was is what the next save goes from; the switch ignores changes while it saves, keeping focus", async () => {
  saveChangelogVersion.mockResolvedValueOnce({ version: "v2" }).mockResolvedValueOnce({ version: "v3" });
  await form({ state: "setting", keepUpToDate: false });
  // Saved unchanged (to clear the product setting's mark), then again: the second goes with the first's new token.
  await submit();
  await submit();
  expect((saveChangelogVersion.mock.calls[1]![4] as FormData).get("version")).toBe("v2");
  let answer = (_: unknown) => {};
  keepChangelogVersionUpToDate.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await form({ code: "de", keepUpToDate: true });
  const second = document.querySelectorAll<HTMLInputElement>('[role="switch"]')[1]!;
  second.focus();
  await act(async () => second.click());
  expect(second.disabled).toBe(false);
  expect(second.getAttribute("aria-disabled")).toBe("true");
  await act(async () => second.click());
  expect(keepChangelogVersionUpToDate).toHaveBeenCalledTimes(1);
  await act(async () => answer({}));
  expect(document.activeElement).toBe(second);
});
