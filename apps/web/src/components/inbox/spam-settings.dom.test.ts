// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const mutate = vi.fn<(input: Record<string, unknown>) => Promise<object>>(async () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/trpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trpc")>()),
  useTRPCClient: () => ({ spam: { update: { mutate } } }),
}));

const { SpamSettings } = await import("./spam-settings");

afterEach(() => document.body.replaceChildren());

const submit = (form: HTMLFormElement) => act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const sent = () => mutate.mock.calls.map(([input]) => Object.keys(input).filter((key) => key !== "project"));

test("the screen's saves land in the order made: one waits for the one before it, from any card", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () =>
    createRoot(box).render(h(SpamSettings, { projectSlug: "acme", settings: { rules: [], allowed: [], guidance: "" }, maxValue: 200, maxGuidance: 500, supportAddress: "" })),
  );
  let release!: () => void;
  mutate.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({}))));
  // The guidance first, held on its way…
  const guidance = box.querySelector<HTMLTextAreaElement>("#spam-guidance")!;
  guidance.value = "SEO pitches are spam";
  await submit(guidance.form!);
  // …then a rule, from another card: it waits.
  const value = box.querySelector<HTMLInputElement>('[aria-label="Value"]')!;
  value.value = "spam.example";
  await submit(value.form!);
  expect(sent()).toEqual([["guidance"]]);
  await act(async () => release());
  expect(sent()).toEqual([["guidance"], ["addRules"]]);
});
