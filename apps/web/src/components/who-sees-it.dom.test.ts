// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { WhoSeesIt } = await import("./changelog");

afterEach(() => document.body.replaceChildren());

const groups = [
  { key: "enterprise", name: "Enterprise" },
  { key: "beta", name: "Beta" },
];
const upgrade = { title: "Reader groups need the Business plan", billingHref: null, note: null };

async function picker() {
  const box = document.createElement("form");
  document.body.append(box);
  const onChange = vi.fn();
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups, picked: ["enterprise"], upgrade, onChange })));
  const box_ = (key: string) => box.querySelector<HTMLInputElement>(`input[value="${key}"]`)!;
  const sent = () => box.querySelector('input[name="groupsEditable"]') !== null;
  return { box: box_, sent, onChange };
}

test("on a plan without reader groups, picking one opens the upgrade prompt and changes nothing: the save after it doesn't send the groups", async () => {
  const { box, sent, onChange } = await picker();
  await act(async () => box("beta").click());
  expect(box("beta").checked).toBe(false);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Reader groups need the Business plan");
  expect(sent()).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
});

test("unpicking one works on such a plan, and is sent", async () => {
  const { box, sent, onChange } = await picker();
  await act(async () => box("enterprise").click());
  expect(box("enterprise").checked).toBe(false);
  expect(sent()).toBe(true);
  expect(onChange).toHaveBeenCalled();
});

test("on such a plan, a group the entry is saved with can be ticked again after unticking it", async () => {
  const { box, onChange } = await picker();
  await act(async () => box("enterprise").click());
  await act(async () => box("enterprise").click());
  expect(box("enterprise").checked).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(2);
});
