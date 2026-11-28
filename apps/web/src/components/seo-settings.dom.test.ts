// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const refresh = vi.fn();
const mutate = vi.fn(async () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({ branding: { update: { mutate } } }), errorMessage: String }));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/media", () => ({}));

const { SeoSettings } = await import("./seo-settings");

afterEach(() => document.body.replaceChildren());

test("a save through tRPC refreshes the page, which shows what's saved, as the server action's refresh did", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () =>
    createRoot(box).render(h(SeoSettings, { projectSlug: "acme", name: "Acme", title: "Old title", description: "", image: null, titleMax: 70, descriptionMax: 160 })),
  );
  box.querySelector<HTMLInputElement>("#seo-title")!.value = "New title";
  await act(async () => box.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mutate).toHaveBeenCalledWith({ project: "acme", seo: { title: "New title", description: "" }, seoImage: null });
  expect(refresh).toHaveBeenCalledTimes(1);
});
