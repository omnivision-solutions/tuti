// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { WidgetIcon } from "@/lib/widget-icons";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/server/widget", () => ({ saveWidgetSettings: vi.fn() }));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({}) }));

const { saveWidgetSettings } = await import("@/server/widget");
const { WidgetSettings } = await import("./widget-settings");

const saves = vi.mocked(saveWidgetSettings);

beforeEach(() => saves.mockReset());
afterEach(() => document.body.replaceChildren());

/** The settings as the page has them, with `icon` stored (and `iconImage`, the team's upload); rendered again with each refresh's icon. */
async function page(icon: WidgetIcon, iconImage: { id: string; url: string } | null = null) {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const refresh = (stored: WidgetIcon) =>
    act(async () =>
      root.render(
        h(WidgetSettings, {
          projectSlug: "acme",
          label: "Help",
          color: "#0f766e",
          defaultColor: "#0f766e",
          colorFollows: true,
          position: "bottom-right",
          links: [],
          icon: stored,
          iconImage,
          upgrade: null,
          title: "",
          greeting: "",
          hidden: [],
          onPortal: false,
          popup: false,
        }),
      ),
    );
  await refresh(icon);
  const radio = (value: WidgetIcon) => box.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
  return {
    refresh,
    pick: (value: WidgetIcon) => act(async () => radio(value).click()),
    remove: () => act(async () => box.querySelector<HTMLButtonElement>('button[aria-label="Remove your icon"]')!.click()),
    // "Save changes" submits the form. As an event: happy-dom's requestSubmit finds the colour's "#0f766e" a pattern
    // mismatch, and gives a submitter FormData refuses.
    save: () => act(async () => void box.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))),
    picked: () => box.querySelector<HTMLInputElement>('input[name="icon"]:checked')?.value,
  };
}

test("a save's own refresh, landing after a pick made since, keeps that pick", async () => {
  saves.mockResolvedValue({});
  const { refresh, pick, save, picked } = await page("chat");
  await pick("help");
  await save();
  expect(saves).toHaveBeenCalledOnce();
  await pick("megaphone");
  await refresh("help");
  expect(picked()).toBe("megaphone");
});

test("the uploaded icon, saved and removed before the save's own refresh, stays removed", async () => {
  saves.mockResolvedValue({});
  const { refresh, pick, remove, save, picked } = await page("chat", { id: "m1", url: "https://tuti.example/i.png" });
  await pick("image");
  await save();
  expect(saves).toHaveBeenCalledOnce();
  // Remove picks the chat bubble again: a pick since the save.
  await remove();
  expect(picked()).toBe("chat");
  await refresh("image");
  expect(picked()).toBe("chat");
});

test("a teammate's icon, refreshed in while a save is waiting for its own, is followed; then the save's own, stored last", async () => {
  saves.mockResolvedValue({});
  const { refresh, pick, save, picked } = await page("chat");
  await pick("help");
  await save();
  await refresh("lightbulb");
  expect(picked()).toBe("lightbulb");
  // Nothing picked since the save: its own refresh shows what's stored now, this page's icon.
  await refresh("help");
  expect(picked()).toBe("help");
});

test("after a save that failed, a refresh with the icon it sent is a teammate's, and is followed", async () => {
  saves.mockResolvedValue({ error: "Couldn't save that. Try again." });
  const { refresh, pick, save, picked } = await page("chat");
  await pick("help");
  await save();
  expect(saves).toHaveBeenCalledOnce();
  await pick("megaphone");
  await refresh("help");
  expect(picked()).toBe("help");
});
