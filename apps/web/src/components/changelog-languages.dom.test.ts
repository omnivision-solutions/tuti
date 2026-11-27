// @vitest-environment happy-dom
import { act, createContext, createElement as h, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const saveChangelogVersion = vi.fn();
const keepChangelogVersionUpToDate = vi.fn();
vi.mock("@/server/changelog", () => ({ saveChangelogVersion, keepChangelogVersionUpToDate }));
// The editor's saving context (its Save in the top bar says when it's saving), without the rest of the changelog editor.
const setPending = vi.fn();
const ChangelogSavingContext = createContext<{ setPending: (pending: boolean) => void } | null>(null);
vi.mock("@/components/changelog", () => ({ ChangelogSavingContext, ChangelogSaveButton: () => null }));
const router = { refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: ({ href, ...props }: { href: string }) => h("a", { href, ...props }) }));
vi.mock("@/server/media", () => ({ uploadStatus: vi.fn() }));
vi.mock("@/server/images", () => ({ generateImage: vi.fn() }));
// The editor's Ask AI (its server action reads the app's addresses as it loads): unused here, and kept offline.
vi.mock("@/server/rewrite", () => ({}));
vi.mock("@/lib/upload-image", () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }));
const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
vi.mock("sonner", () => ({ toast }));

const { ChangelogVersionEditor } = await import("./changelog-languages");
const { versionFormKey, versionTextKey } = await import("@/lib/changelog-versions");
type VersionView = import("./changelog-languages").VersionView;
const { forgetPageTries } = await import("./rich-editor");

/** A changelog entry's version form (the language pill's other languages): saving, Keep up to date, and what they keep. */

const roots: Root[] = [];
/** The images' addresses the page passes (its media map), for the next render. */
let shownMedia: Record<string, string> | null = null;
beforeEach(() => {
  saveChangelogVersion.mockReset();
  keepChangelogVersionUpToDate.mockReset();
  setPending.mockReset();
  shownMedia = null;
  router.refresh.mockReset();
  toast.error.mockReset();
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
const view: VersionView = { code: "de", name: "Deutsch", state: "current", keepUpToDate: true, version: "v1", waiting: null, title: "Dunkler Modus", content: doc, own: true };

async function form(props: Partial<typeof view> = {}) {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  const render = (changes: Partial<typeof view>) =>
    act(async () =>
      root.render(
        // In Strict Mode, as Next renders the app in development: state initializers and effects run twice.
        h(StrictMode, null, h(
          ChangelogSavingContext,
          { value: { setPending } },
          // Keyed as the page keys it (versionFormKey, versionTextKey), so a re-render here remounts the form exactly where the page would.
          h(ChangelogVersionEditor, {
            key: versionFormKey({ ...view, ...changes }),
            formKey: versionTextKey({ ...view, ...changes }),
            projectSlug: "acme",
            number: 1,
            defaultName: "English",
            view: { ...view, ...changes },
            mediaUrls: shownMedia,
            languages,
          }),
        )),
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
  keepChangelogVersionUpToDate.mockResolvedValue({ version: "v-kept" });
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
  // The page's new read (the entry or the product setting changed meanwhile, the text didn't): a save goes with the token
  // its own toggle got back, not the page's, so the server refuses an edit made before a change it didn't see.
  expect(document.querySelector<HTMLInputElement>('input[name="version"]')!.value).toBe("v-kept");
  // Turned on elsewhere (a teammate), then off by a save of this text: the switch shows the server's value each time.
  await render({ keepUpToDate: true, version: "v3" });
  expect(keep().checked).toBe(true);
  await render({ keepUpToDate: false, version: "v4" });
  expect(keep().checked).toBe(false);
});

test("turning Keep up to date on over the team's own text asks first", async () => {
  keepChangelogVersionUpToDate.mockResolvedValue({ version: "v-kept" });
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

test("the switch goes from the page's latest read, not the token the text was loaded with; refused as changed, it says so and goes back", async () => {
  keepChangelogVersionUpToDate.mockResolvedValueOnce({ error: "changed", changed: true }).mockResolvedValueOnce({ version: "v-on" });
  const { render } = await form({ keepUpToDate: false, state: "current" });
  // The English edited since, the page read again: a new token, the same text.
  await render({ keepUpToDate: false, state: "translating", version: "v2" });
  await act(async () => keep().click());
  expect(keepChangelogVersionUpToDate).toHaveBeenLastCalledWith("acme", 1, "de", true, "v2");
  // Nothing typed (the switch's own click isn't an edit): the page is read again.
  expect(router.refresh).toHaveBeenCalledTimes(1);
  expect(toast.error).toHaveBeenCalledWith("It changed meanwhile: shown as it is now. Try again.");
  expect(keep().checked).toBe(false);
  // The page read again (the action refreshed it): the next try goes from that read.
  await render({ keepUpToDate: false, state: "translating", version: "v3" });
  await act(async () => keep().click());
  expect(keepChangelogVersionUpToDate).toHaveBeenLastCalledWith("acme", 1, "de", true, "v3");
  expect(keep().checked).toBe(true);
  // Nothing typed: Save goes from the newest read, here the one its own toggle got back.
  expect(document.querySelector<HTMLInputElement>('input[name="version"]')!.value).toBe("v-on");
});

test("a first toggle (no version yet) gives Save the new version's token, so the next save isn't refused", async () => {
  keepChangelogVersionUpToDate.mockResolvedValue({ version: "v-made" });
  saveChangelogVersion.mockResolvedValue({ version: "v-saved" });
  await form({ state: "unwritten", keepUpToDate: false, version: "v-none" });
  await act(async () => keep().click());
  expect(keepChangelogVersionUpToDate).toHaveBeenCalledWith("acme", 1, "de", true, "v-none");
  await submit();
  expect((saveChangelogVersion.mock.calls[0]![4] as FormData).get("version")).toBe("v-made");
});

test("a toggle's token is taken for Save only where the form's text goes from the read it acted on; edits from an older read keep its token", async () => {
  keepChangelogVersionUpToDate.mockResolvedValue({ version: "v-after" });
  saveChangelogVersion.mockResolvedValue({ version: "v-saved" });
  const { render } = await form({ keepUpToDate: true, version: "v1" });
  await act(async () => type(title(), "Bearbeitet"));
  // The English edited meanwhile: the page's new read, the form's text still from v1.
  await render({ keepUpToDate: true, version: "v2" });
  await act(async () => keep().click());
  expect(keepChangelogVersionUpToDate).toHaveBeenCalledWith("acme", 1, "de", false, "v2");
  await submit();
  // Still v1's: the server refuses an edit made before the English changed.
  expect((saveChangelogVersion.mock.calls[0]![4] as FormData).get("version")).toBe("v1");
});

test("a toggle refused as changed with edits typed keeps them: the page isn't read again over them", async () => {
  keepChangelogVersionUpToDate.mockResolvedValue({ error: "changed", changed: true });
  await form({ keepUpToDate: true });
  await act(async () => type(title(), "Korrigiert, nicht gespeichert"));
  await act(async () => keep().click());
  expect(router.refresh).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("It changed meanwhile. Copy your edits, then reload.");
  expect(title().value).toBe("Korrigiert, nicht gespeichert");
  expect(keep().checked).toBe(true);
});

test("the version's language is on its title and text only, the default language's while it's still that text; the line and errors stay the app's", async () => {
  saveChangelogVersion.mockResolvedValue({ error: "It or the entry changed since you opened it" });
  await form();
  const text = () => document.querySelector('[role="textbox"][aria-label="What changed"]')!;
  expect(title().lang).toBe("de");
  expect(text().getAttribute("lang")).toBe("de");
  await submit();
  const error = [...document.querySelectorAll("p, div")].find((each) => each.textContent === "It or the entry changed since you opened it")!;
  expect(error.closest("[lang]")).toBeNull();
  expect(document.querySelectorAll("[lang]")).toHaveLength(2);
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  await form({ state: "unwritten", keepUpToDate: false, own: false });
  expect(title().lang).toBe("en");
  expect(text().getAttribute("lang")).toBe("en");
});

test("an edit in the text that fires no input event (Enter, paste, drop) counts as typed: a refused toggle doesn't read the page again over it", async () => {
  keepChangelogVersionUpToDate.mockResolvedValue({ error: "changed", changed: true });
  await form({ keepUpToDate: true });
  const editor = (document.querySelector('[role="textbox"][aria-label="What changed"]') as HTMLElement & { editor: { commands: { insertContent: (text: string) => void } } }).editor;
  await act(async () => editor.commands.insertContent(" Neu."));
  await act(async () => keep().click());
  expect(router.refresh).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("It changed meanwhile. Copy your edits, then reload.");
});

test("text typed while the toggle's request is on its way counts: its refusal doesn't read the page again over it", async () => {
  let answer = (_: unknown) => {};
  keepChangelogVersionUpToDate.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await form({ keepUpToDate: true });
  await act(async () => keep().click());
  await act(async () => type(title(), "Während der Anfrage getippt"));
  await act(async () => answer({ error: "changed", changed: true }));
  expect(router.refresh).not.toHaveBeenCalled();
  expect(title().value).toBe("Während der Anfrage getippt");
});

test("a form with nothing typed goes from the page's new read; one with edits keeps the token they were made from", async () => {
  saveChangelogVersion.mockResolvedValue({ version: "v-saved" });
  const { render } = await form({ version: "v1" });
  // The page read again (the English edited, say), the text the same: nothing typed, so Save goes from it.
  await render({ version: "v2" });
  await submit();
  expect((saveChangelogVersion.mock.calls[0]![4] as FormData).get("version")).toBe("v2");
  // Edited, then read again: the edit keeps the token it was made from, so the server refuses it.
  await act(async () => type(title(), "Bearbeitet"));
  await render({ version: "v3" });
  await submit();
  expect((saveChangelogVersion.mock.calls[1]![4] as FormData).get("version")).toBe("v-saved");
});

test("text shown in the version's place (its first translation on its way, or failing) carries the default language's lang", async () => {
  await form({ state: "waiting", keepUpToDate: true, own: false, title: "Dark mode" });
  expect(title().lang).toBe("en");
  expect(document.querySelector('[role="textbox"][aria-label="What changed"]')!.getAttribute("lang")).toBe("en");
});

test("text typed while a save is on its way stays unsaved: a later read's token isn't taken for it", async () => {
  let answer = (_: unknown) => {};
  saveChangelogVersion.mockReturnValueOnce(new Promise((resolve) => (answer = resolve))).mockResolvedValue({ version: "v-later" });
  const { render } = await form({ version: "v1" });
  await act(async () => type(title(), "Erste Fassung"));
  await submit();
  // Typed while the save is on its way.
  await act(async () => type(title(), "Zweite Fassung"));
  await act(async () => answer({ version: "v-saved" }));
  // The page reads again (the English edited, say): the form still has an unsaved edit, so it keeps its own save's token.
  await render({ version: "v-new" });
  await submit();
  expect((saveChangelogVersion.mock.calls[1]![4] as FormData).get("version")).toBe("v-saved");
});

test("typing while a save is on its way survives the page's next read, which shows what the save stored: the form isn't remounted", async () => {
  let answer = (_: unknown) => {};
  saveChangelogVersion.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  const { render } = await form({ version: "v1" });
  await act(async () => type(title(), "Gespeicherter Titel"));
  await submit();
  await act(async () => type(title(), "Gespeicherter Titel, weiter getippt"));
  await act(async () => answer({ version: "v-saved" }));
  // The page reads again after the save: the title and text it stored.
  await render({ version: "v-saved", title: "Gespeicherter Titel" });
  expect(title().value).toBe("Gespeicherter Titel, weiter getippt");
});

test("with nothing typed, a new read's title and text are set in place, and its token taken with them", async () => {
  saveChangelogVersion.mockResolvedValue({ version: "v-saved" });
  const { render } = await form({ version: "v1" });
  const editorText = () => document.querySelector('[role="textbox"][aria-label="What changed"]')!.textContent;
  // A teammate's save (or a translation) lands: its text comes with the new read.
  const newer = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Neue Fassung." }] }] };
  await render({ version: "v2", title: "Neuer Titel", content: newer });
  expect(title().value).toBe("Neuer Titel");
  expect(editorText()).toContain("Neue Fassung.");
  // Set in place, not typed: Save goes from that read.
  await submit();
  expect((saveChangelogVersion.mock.calls[0]![4] as FormData).get("version")).toBe("v2");
});

test("a new read with an image mounts the form afresh, its image shown from the page's addresses", async () => {
  const { render } = await form({ version: "v1" });
  const id = "newimage0000000000001";
  shownMedia = { [`m/${id}/960.webp`]: `https://media.example/${id}-960.webp` };
  const content = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Siehe unten." }] }, { type: "image", attrs: { mediaId: id, width: "100", align: "center", alt: "", w: 1000, h: 500 } }] };
  await render({ version: "v2", content });
  expect(document.querySelector(`img[src*="${id}"]`)).not.toBeNull();
});

test("text in a new read this editor can't read stays read-only, as on a first read", async () => {
  const { render } = await form({ version: "v1" });
  expect(document.querySelector('[role="textbox"][aria-label="What changed"]')!.getAttribute("contenteditable")).toBe("true");
  const content = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Neu." }] }, { type: "futureBlock" }] };
  await render({ version: "v2", content: content as never });
  expect(document.querySelector('[role="textbox"][aria-label="What changed"]')!.getAttribute("contenteditable")).toBe("false");
});

test("a save's answer that comes after a newer read leaves the newer read's token", async () => {
  let answer = (_: unknown) => {};
  saveChangelogVersion.mockReturnValueOnce(new Promise((resolve) => (answer = resolve))).mockResolvedValue({ version: "v-next" });
  const { render } = await form({ version: "v1" });
  await submit();
  // A newer read lands first (a teammate's save, a translation): the form is mounted afresh with it.
  await render({ version: "v2", title: "Von jemand anderem" });
  // Typed in the newer form before the late answer comes: the answer, for a form no longer shown, touches neither.
  await act(async () => type(title(), "Von jemand anderem, ergänzt"));
  await act(async () => answer({ version: "v-late" }));
  // Another read with new text: the typing is carried on, from the newer read's token.
  await render({ version: "v3", title: "Noch neuer" });
  expect(title().value).toBe("Von jemand anderem, ergänzt");
  await submit();
  expect((saveChangelogVersion.mock.calls[1]![4] as FormData).get("version")).toBe("v2");
});

test("a save's answer that comes after the same text's newer read was taken keeps that read's token", async () => {
  let answer = (_: unknown) => {};
  saveChangelogVersion.mockReturnValueOnce(new Promise((resolve) => (answer = resolve))).mockResolvedValue({ version: "v-next" });
  const { render } = await form({ version: "v1" });
  // Saved as it is (to clear a mark, say), nothing typed; a newer read with the same text lands before its answer.
  await submit();
  await render({ version: "v2" });
  await act(async () => answer({ version: "v-late" }));
  await submit();
  expect((saveChangelogVersion.mock.calls[1]![4] as FormData).get("version")).toBe("v2");
});
