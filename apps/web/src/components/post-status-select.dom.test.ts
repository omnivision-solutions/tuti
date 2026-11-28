// @vitest-environment happy-dom
import type { PostStatus } from "@tuti/db";
import { act, createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each status save answers when the test says so.
const answers: (() => void)[] = [];
const mutate = vi.fn(() => new Promise<object>((resolve) => answers.push(() => resolve({}))));
// One client for the page, as the provider's.
const client = { posts: { update: { mutate } } };
const refresh = vi.fn();
vi.mock("@/components/trpc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/components/trpc")>()), useTRPCClient: () => client }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { useSavePostStatus } = await import("./post-status-select");
const { InOrderProvider } = await import("./trpc");

beforeEach(() => {
  vi.clearAllMocks();
  answers.length = 0;
});
afterEach(() => document.body.replaceChildren());

/** A card's way to change its status: the roadmap's drag and each card's menu are such components, side by side. */
const saves: Record<string, (status: PostStatus) => Promise<{ error?: string }>> = {};
function Card({ name, number }: { name: string; number: number }) {
  const save = useSavePostStatus("acme");
  useEffect(() => {
    saves[name] = (status) => save(number, status);
  });
  return null;
}

test("two status changes on the roadmap go through posts.update one after the other, in the order made: the page's one queue", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(h(InOrderProvider, null, h(Card, { name: "drag", number: 1 }), h(Card, { name: "menu", number: 1 }))));
  let first!: Promise<unknown>;
  let second!: Promise<unknown>;
  await act(async () => {
    first = saves.drag!("IN_PROGRESS");
    second = saves.menu!("COMPLETED");
  });
  // The second isn't sent while the first is on its way (server actions ran one at a time; tRPC calls don't).
  expect(mutate.mock.calls).toEqual([[{ project: "acme", number: 1, status: "in_progress" }]]);
  await act(async () => answers.shift()!());
  await first;
  expect(mutate.mock.calls).toEqual([[{ project: "acme", number: 1, status: "in_progress" }], [{ project: "acme", number: 1, status: "completed" }]]);
  await act(async () => answers.shift()!());
  await second;
  // Saved, the page again each time: the columns move.
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

test("a refused or failed change answers its error for the toast, and leaves the page as it is", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(h(Card, { name: "menu", number: 7 })));
  mutate.mockRejectedValueOnce(new Error("offline"));
  expect(await saves.menu!("PLANNED")).toEqual({ error: "Something went wrong. Try again." });
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("saved, the page's refresh runs in the caller's transition, so its control stays pending till the new status shows", async () => {
  const transition = vi.fn((refresh: () => void) => refresh());
  let save!: ReturnType<typeof useSavePostStatus>;
  function Menu() {
    const saving = useSavePostStatus("acme", transition);
    useEffect(() => {
      save = saving;
    });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(h(Menu)));
  let saved!: Promise<unknown>;
  await act(async () => {
    saved = save(3, "PLANNED");
  });
  await act(async () => answers.shift()!());
  expect(await saved).toEqual({});
  expect(transition).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
