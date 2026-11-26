// @vitest-environment happy-dom
import { act, createElement as h, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { ChangelogSaving, ChangelogSavingContext, WhoSeesIt } = await import("./changelog");

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

test("Publish is told of an unsaved pick only while the picker that has it is there: once the form is replaced (new saved text), the pick and the hold go together", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const root = createRoot(box);
  const Held = () => h("output", null, String(useContext(ChangelogSavingContext)?.groupsChanged));
  const render = (picker: boolean) =>
    act(async () => root.render(h(ChangelogSaving, null, h(Held), picker && h(WhoSeesIt, { groups, picked: [], upgrade: null, onChange: () => {} }))));
  await render(true);
  expect(box.querySelector("output")?.textContent).toBe("false");
  await act(async () => box.querySelector<HTMLInputElement>('input[value="beta"]')!.click());
  expect(box.querySelector("output")?.textContent).toBe("true");
  await render(false);
  expect(box.querySelector("output")?.textContent).toBe("false");
});

test("while a save runs the picks wait: one made then would be dropped as the picker starts afresh after it", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const onChange = vi.fn();
  await act(async () => createRoot(box).render(h(WhoSeesIt, { groups, picked: [], upgrade: null, saving: true, onChange })));
  const beta = box.querySelector<HTMLInputElement>('input[value="beta"]')!;
  // Off, but focusable: the keyboard keeps its place.
  expect(beta.getAttribute("aria-disabled")).toBe("true");
  expect(beta.disabled).toBe(false);
  beta.focus();
  await act(async () => beta.click());
  expect(beta.checked).toBe(false);
  expect(document.activeElement).toBe(beta);
  expect(box.querySelector('input[name="groupsEditable"]')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

test("Email only is sent only once it changes, and holds Publish until saved; with no groups, it's all there is", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const root = createRoot(box);
  const Held = () => h("output", null, String(useContext(ChangelogSavingContext)?.groupsChanged));
  await act(async () => root.render(h(ChangelogSaving, null, h(Held), h(WhoSeesIt, { groups: [], picked: [], emailOnly: true, upgrade: null, onChange: () => {} }))));
  expect(box.querySelector('input[name="groups"]')).toBeNull();
  const only = box.querySelector<HTMLInputElement>('input[name="emailOnly"]')!;
  expect(only.checked).toBe(true);
  expect(box.querySelector('input[name="emailOnlyEditable"]')).toBeNull();
  await act(async () => only.click());
  expect(only.checked).toBe(false);
  expect(box.querySelector('input[name="emailOnlyEditable"]')).not.toBeNull();
  expect(box.querySelector("output")?.textContent).toBe("true");
});

test("Email only says what happens where no email can go (published without it, or a private portal): listed nowhere, the team's only", async () => {
  const box = document.createElement("form");
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(h(WhoSeesIt, { groups: [], picked: [], emailable: false, upgrade: null, onChange: () => {} })));
  expect(box.textContent).toContain("Listed nowhere: only your team sees it.");
  expect(box.textContent).not.toContain("Emailed to subscribers");
  await act(async () => root.render(h(WhoSeesIt, { groups: [], picked: [], upgrade: null, onChange: () => {} })));
  expect(box.textContent).toContain("Emailed to subscribers and listed nowhere.");
});
