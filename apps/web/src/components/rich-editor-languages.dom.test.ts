// @vitest-environment happy-dom
import { MESSAGES } from "@tuti/shared/messages";
import { NextIntlClientProvider } from "next-intl";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/rewrite", () => ({ rewriteText: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@/lib/upload-image", () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }));
vi.mock("@/server/images", () => ({ generateImage: vi.fn() }));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({}) }));

const { RichEditor } = await import("./rich-editor");
const { uploadImage } = await import("@/lib/upload-image");
const de = MESSAGES.de.editor;

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.mocked(uploadImage).mockReset();
});

/** A comment's box on a German page (the portal's provider), in a form. */
async function germanBox(initial?: object) {
  const form = document.createElement("form");
  document.body.append(form);
  const root = createRoot(form);
  roots.push(root);
  const editor = h(RichEditor, { profile: "comment", name: "content", label: "Kommentar", uploads: { projectSlug: "acme", mediaUrls: {} }, initial: initial as never });
  // (The provider's props type its children as required: they're the third argument here.)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "de", messages: MESSAGES.de, timeZone: "UTC" } as never, editor)));
  await vi.waitFor(() => expect(form.querySelector("[role=textbox]")).toBeTruthy());
  return form;
}

/** Picks `file` in the box's image picker. */
async function pick(form: HTMLElement, file: File) {
  const input = form.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
const png = () => new File(["x"], "screen.png", { type: "image/png" });
const alert = (form: HTMLElement) => form.querySelector<HTMLElement>("[role=alert]");

test("the toolbar's names are the page's", async () => {
  const form = await germanBox();
  const toolbar = form.querySelector("[role=toolbar]")!;
  expect(toolbar.getAttribute("aria-label")).toBe(de.formatting);
  expect([...toolbar.querySelectorAll("button[aria-label]")].map((button) => button.getAttribute("aria-label"))).toEqual([de.bold, de.italic, de.code, de.link, de.image]);
});

test("uploading, and waiting for it on a send: said in the page's language", async () => {
  vi.mocked(uploadImage).mockReturnValue(new Promise(() => {}));
  const form = await germanBox();
  await pick(form, png());
  expect(form.querySelector("[role=status]")!.textContent).toBe("Bild wird hochgeladen…");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(alert(form)!.textContent).toBe("Warte, bis das Bild hochgeladen ist, und versuch es dann noch einmal.");
});

test("an upload's failure here is said in the page's language; the server's words are English, marked so", async () => {
  const form = await germanBox();
  vi.mocked(uploadImage).mockRejectedValueOnce(new Error("offline"));
  await pick(form, png());
  await vi.waitFor(() => expect(alert(form)?.textContent).toBe(de.uploadFailed));
  expect(alert(form)!.hasAttribute("lang")).toBe(false);
  vi.mocked(uploadImage).mockResolvedValueOnce({ error: "screen.png couldn't be used as an image", reason: "unusable" });
  await pick(form, png());
  await vi.waitFor(() => expect(alert(form)?.textContent).toBe("screen.png konnte nicht als Bild verwendet werden"));
  vi.mocked(uploadImage).mockResolvedValueOnce({ error: "The image is taking too long. Try again.", reason: "tooLong" });
  await pick(form, png());
  await vi.waitFor(() => expect(alert(form)?.textContent).toBe(de.imageTooLong));
  expect(alert(form)!.hasAttribute("lang")).toBe(false);
  vi.mocked(uploadImage).mockResolvedValueOnce({ error: "Images can be up to 10 MB." });
  await pick(form, png());
  await vi.waitFor(() => expect(alert(form)?.textContent).toBe("Images can be up to 10 MB."));
  expect(alert(form)!.getAttribute("lang")).toBe("en");
});

test("text it can't read: why, in the page's language", async () => {
  const form = await germanBox({ type: "doc", content: [{ type: "fromTheFuture" }] });
  await vi.waitFor(() => expect(alert(form)?.textContent).toBe(de.unreadable));
});
