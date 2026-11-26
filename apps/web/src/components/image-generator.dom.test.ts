// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const generateImage = vi.fn();
const uploadImage = vi.fn();
vi.mock("@/server/images", () => ({ generateImage }));
vi.mock("@/server/media", () => ({
  uploadStatus: async (id: string) => ({ status: "READY", src: `https://media.example/${id}-full.png`, download: `https://media.example/${id}-download.webp`, urls: {}, width: 1200, height: 630 }),
}));
vi.mock("@/lib/upload-image", () => ({ uploadImage }));

const { ImageGenerator } = await import("./image-generator");

beforeEach(() => {
  generateImage.mockReset();
  uploadImage.mockReset();
  let made = 0;
  generateImage.mockImplementation(async () => ({ image: { id: `made${++made}`, url: `https://media.example/made${made}.png`, width: 1200, height: 630 } }));
});
afterEach(() => document.body.replaceChildren());

const disabled = (button: HTMLButtonElement) => button.disabled || button.getAttribute("aria-disabled") === "true";
const image = (n: number) => ({ id: `ref${n}`, url: `https://media.example/ref${n}.png` });

async function dialog(props: Partial<Parameters<typeof ImageGenerator>[0]> = {}) {
  const box = document.createElement("div");
  document.body.append(box);
  const onUse = vi.fn();
  await act(async () =>
    createRoot(box).render(
      h(ImageGenerator, {
        projectSlug: "acme",
        open: true,
        onOpenChange: () => {},
        subtitle: "Cover for “Dark mode”",
        defaultSize: { label: "Cover", width: 1200, height: 630 },
        useLabel: "Use as cover",
        onUse,
        ...props,
      }),
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name);
  const type = async (value: string) => {
    const prompt = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, value);
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const references = () => [...document.querySelectorAll<HTMLImageElement>('ul[aria-label="References"] img')].map((each) => each.src);
  return { button, type, references, onUse, click: (name: string) => act(async () => button(name)!.click()) };
}

test("Generate sends the prompt, the cover's size and the references, in order", async () => {
  const { click, type } = await dialog({ references: [image(1), image(2)] });
  expect(document.body.textContent).toContain("Cover for “Dark mode”");
  expect(document.body.textContent).toContain("1200 × 630");
  await type("A parrot at a desk");
  await click("Generate");
  expect(generateImage).toHaveBeenCalledWith("acme", { prompt: "A parrot at a desk", width: 1200, height: 630, references: ["ref1", "ref2"] });
});

test("a preset changes the size; Custom takes two sides between 64 and 2,400 pixels", async () => {
  const { button, click, type } = await dialog();
  await type("A parrot");
  await click("1:1");
  expect(button("1:1")!.getAttribute("aria-pressed")).toBe("true");
  expect(document.body.textContent).toContain("1200 × 1200");
  await click("Custom");
  const [width, height] = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  const set = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await set(width!, "3000");
  expect(width!.getAttribute("aria-invalid")).toBe("true");
  expect(disabled(button("Generate")!)).toBe(true);
  await set(width!, "63");
  expect(disabled(button("Generate")!)).toBe(true);
  await set(width!, "800");
  await set(height!, "64");
  expect(disabled(button("Generate")!)).toBe(false);
  await click("Generate");
  expect(generateImage).toHaveBeenCalledWith("acme", expect.objectContaining({ width: 800, height: 64 }));
});

test("references are removed with ×, and at 14 no more can be added", async () => {
  const { button, click, references } = await dialog({ references: Array.from({ length: 14 }, (_, n) => image(n + 1)) });
  expect(references()).toHaveLength(14);
  expect(disabled(button("Add a reference")!)).toBe(true);
  await click("Remove reference 1");
  expect(references()).toHaveLength(13);
  expect(references()[0]).toBe("https://media.example/ref2.png");
  expect(disabled(button("Add a reference")!)).toBe(false);
});

test("an uploaded reference joins the end; a pasted image is uploaded too", async () => {
  uploadImage.mockResolvedValueOnce({ mediaId: "up1", src: "https://media.example/up1.png" }).mockResolvedValueOnce({ mediaId: "up2", src: "https://media.example/up2.png" });
  const { references } = await dialog({ references: [image(1)] });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["x"], "logo.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(uploadImage).toHaveBeenCalledWith("acme", file);
  expect(references()).toEqual(["https://media.example/ref1.png", "https://media.example/up1.png"]);
  const paste = new Event("paste", { bubbles: true }) as Event & { clipboardData: unknown };
  paste.clipboardData = { files: [new File(["y"], "shot.png", { type: "image/png" })] };
  await act(async () => document.querySelector("textarea")!.dispatchEvent(paste));
  expect(references()).toEqual(["https://media.example/ref1.png", "https://media.example/up1.png", "https://media.example/up2.png"]);
});

test("each Generate adds a try; Refine puts the picked try first among the references; Use passes the picked one at full size", async () => {
  const { button, click, type, references, onUse } = await dialog({ references: [image(1)] });
  await type("A parrot");
  await click("Generate");
  await click("Generate");
  expect(button("Try 2")!.getAttribute("aria-pressed")).toBe("true");
  await click("Try 1");
  await click("Refine this one");
  expect(references()).toEqual(["https://media.example/made1-full.png", "https://media.example/ref1.png"]);
  expect(document.activeElement).toBe(document.querySelector("textarea"));
  await click("Generate");
  expect(generateImage).toHaveBeenLastCalledWith("acme", expect.objectContaining({ references: ["made1", "ref1"] }));
  await click("Try 1");
  await click("Use as cover");
  expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: "made1", url: "https://media.example/made1-full.png", width: 1200, height: 630 }));
});

test("an error from the action is said in the result area", async () => {
  generateImage.mockResolvedValueOnce({ error: "This project is out of credits" });
  const { click, type } = await dialog();
  await type("A parrot");
  await click("Generate");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("This project is out of credits");
});

test("Uses AI credits is said only where credits are on", async () => {
  await dialog();
  expect(document.body.textContent).not.toContain("Uses AI credits");
  document.body.replaceChildren();
  await dialog({ credits: true });
  expect(document.body.textContent).toContain("Uses AI credits");
});

test("the + menu adds the logo and this entry's images; Media library is there, off", async () => {
  const { click, references } = await dialog({ references: [image(1)], fromHere: { label: "From this entry", images: [image(2), image(3)] }, logo: image(9) });
  const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((each) => (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name);
  await click("Add a reference");
  expect(item("Media librarySoon")!.getAttribute("aria-disabled")).toBe("true");
  await act(async () => item("Your logo")!.click());
  expect(references()).toEqual(["https://media.example/ref1.png", "https://media.example/ref9.png"]);
  await click("Add a reference");
  await act(async () => item("From this entry")!.click());
  await vi.waitFor(() => expect(item("Image 2")).toBeTruthy());
  await act(async () => item("Image 2")!.click());
  expect(references()).toEqual(["https://media.example/ref1.png", "https://media.example/ref9.png", "https://media.example/ref3.png"]);
});

test("removing a reference moves focus to the next one's ×, or to + after the last", async () => {
  const { button, click } = await dialog({ references: [image(1), image(2)] });
  await click("Remove reference 1");
  expect(document.activeElement).toBe(button("Remove reference 1"));
  await click("Remove reference 1");
  expect(document.activeElement).toBe(button("Add a reference"));
});

test("after a failed try, the error replaces the image and its actions: nothing acts on a try that isn't shown", async () => {
  generateImage.mockResolvedValueOnce({ image: { id: "made1", url: "https://media.example/made1.png", width: 1200, height: 630 } }).mockResolvedValueOnce({ error: "The AI couldn't make the image. Try again in a moment." });
  const { button, click, type } = await dialog();
  await type("A parrot");
  await click("Generate");
  expect(button("Use as cover")).toBeTruthy();
  expect(document.querySelector<HTMLAnchorElement>("a[download]")!.href).toBe("https://media.example/made1-download.webp");
  await click("Generate");
  expect(document.querySelector('[role="alert"]')).toBeTruthy();
  expect(button("Use as cover")).toBeUndefined();
  expect(button("Refine this one")).toBeUndefined();
  await click("Try 1");
  expect(button("Use as cover")).toBeTruthy();
});

test("while a reference uploads, + stays focusable (focus isn't dropped) but doesn't open its menu", async () => {
  let finish!: (value: unknown) => void;
  uploadImage.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const { button } = await dialog();
  const add = button("Add a reference")!;
  add.focus();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [new File(["x"], "logo.png", { type: "image/png" })], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  // Off to the keyboard and screen readers, but not natively disabled: browsers move focus off a disabled button (to <body>).
  expect(add.getAttribute("aria-disabled")).toBe("true");
  expect(add.disabled).toBe(false);
  expect(document.activeElement).toBe(add);
  await act(async () => add.click());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => finish({ mediaId: "up1", src: "https://media.example/up1.png" }));
  expect(disabled(add)).toBe(false);
});
