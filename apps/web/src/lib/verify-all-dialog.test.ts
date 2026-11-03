import { expect, test } from "vitest";

import { shownRun, watchedRun } from "./verify-all-dialog";

const run = (id: string, state: "running" | "done" | "stopped") => ({ id, state });

/** The dialog's renders: each the page's latest and whether it's open, carrying what it watches from one to the next. */
function renders(steps: { open: boolean; latest: ReturnType<typeof run> | null; started?: ReturnType<typeof run> }[]) {
  let watching: ReturnType<typeof run> | null = null;
  return steps.map(({ open, latest, started }) => {
    watching = watchedRun(open, latest, started ?? watching);
    return shownRun(latest, watching);
  });
}

test("closed while a run goes on, then opened once it's done: the next one's cost, not the finished run", () => {
  expect(
    renders([
      { open: true, latest: run("a", "running") },
      { open: false, latest: run("a", "running") },
      { open: false, latest: run("a", "done") },
      { open: true, latest: run("a", "done") },
    ]),
  ).toEqual([run("a", "running"), run("a", "running"), null, null]);
});

test("open while it runs and ends, it shows the end; started from it, the run it got back till the page catches up", () => {
  expect(
    renders([
      { open: true, latest: run("a", "running") },
      { open: true, latest: run("a", "done") },
    ]),
  ).toEqual([run("a", "running"), run("a", "done")]);
  expect(
    renders([
      { open: true, latest: run("old", "done") },
      { open: true, latest: run("old", "done"), started: run("b", "running") },
      { open: true, latest: run("b", "running") },
      { open: true, latest: run("b", "done") },
    ]),
  ).toEqual([null, run("b", "running"), run("b", "running"), run("b", "done")]);
});
