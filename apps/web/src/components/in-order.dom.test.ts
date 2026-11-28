// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { InOrderProvider, useInOrder } from "./trpc";

afterEach(() => document.body.replaceChildren());

/** A page with one component that saves through the page's queue: `save` queues a save. */
async function page() {
  let queue!: ReturnType<typeof useInOrder>;
  function Saver() {
    queue = useInOrder();
    return null;
  }
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(h(InOrderProvider, null, h(Saver))));
  return { save: (fn: () => Promise<unknown>) => queue(fn), leave: () => act(async () => root.unmount()) };
}

test("a page's saves wait for each other, and a new page starts with a fresh queue, whatever the last one left", async () => {
  const first = await page();
  // A save that never settles…
  void first.save(() => new Promise(() => {}));
  const waiting = vi.fn(async () => {});
  void first.save(waiting);
  await act(async () => {});
  // …holds back that page's next one.
  expect(waiting).not.toHaveBeenCalled();
  await first.leave();

  // The next page isn't held back by it.
  const next = await page();
  const fresh = vi.fn(async () => {});
  await act(async () => next.save(fresh));
  expect(fresh).toHaveBeenCalledTimes(1);
});
