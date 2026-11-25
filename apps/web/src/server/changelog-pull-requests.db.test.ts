import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { FAKE_MODEL_KEY, type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import {
  addChangelogPullRequests,
  addedPullRequestsAnalysed,
  createChangelogEntry,
  getChangelogEntry,
  listMissingChanges,
  publishChangelogEntry,
  removeChangelogPullRequest,
  updateChangelogEntry,
} from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** The changelog's pull requests by hand: the merged ones no entry has, adding them to the running draft, taking one out of a draft. */

// The analysis a pull request gets has its own tests (code-changes.db.test.ts, where it runs): here it's queued and never run.
// `claimFails`: pull requests whose code change can't be saved (the database refusing it).
const queue = vi.hoisted(() => ({ enqueue: vi.fn<(name: string, input: unknown) => Promise<undefined>>(async () => undefined), claimFails: new Set<number>() }));
vi.mock("@tuti/jobs", async (importOriginal) => {
  const jobs = await importOriginal<typeof import("@tuti/jobs")>();
  return {
    ...jobs,
    enqueue: queue.enqueue,
    claimCodeChange: async (...args: Parameters<typeof jobs.claimCodeChange>) => {
      if (queue.claimFails.has(args[1].number)) {
        throw new Error("The database refused it");
      }
      return jobs.claimCodeChange(...args);
    },
  };
});

let github: GithubFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let repo: string;
let repoId: number;
let next = 91_000;

beforeAll(async () => {
  github = await startGithubFake();
});
afterAll(() => github.close());
/** Today, for every date here: the list's 30 days and "since the latest entry" are counted from it. */
const NOW = new Date("2026-11-24T12:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, value);
  }
  // AI set up (what Autopilot needs): merged pull requests become code changes.
  vi.stubEnv("OPENAI_API_KEY", FAKE_MODEL_KEY);
  vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:1");
  owner = await signUp("Owner");
  project = await createProject(owner);
  // GitHub connected, with one repository included (each test its own: the fake keeps every pull request it's given).
  repoId = next++;
  repo = `acme/app-${repoId}`;
  const installation = await prisma.githubInstallation.create({ data: { projectId: project.id, installationId: repoId, accountLogin: "acme", createdById: owner.id } });
  await prisma.githubRepository.create({ data: { connectionId: installation.id, repoId, fullName: repo } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  queue.enqueue.mockReset();
  queue.enqueue.mockImplementation(async () => undefined);
  queue.claimFails.clear();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const url = (number: number) => `https://github.com/${repo}/pull/${number}`;
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const missing = async (since?: string) => (await call(listMissingChanges, team(), since ? { since } : {})).pullRequests.map((pr) => pr.number);
const add = (...numbers: number[]) => call(addChangelogPullRequests, team(), { pullRequests: numbers.map((number) => ({ repo, number })) });
const entry = (number: number) => call(getChangelogEntry, team(), { number });
/** What the team decided about each of the project's pull requests, by number. */
const decisions = () => prisma.changelogDecision.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" }, select: { number: true, takenOut: true } });
/** GitHub delivering a merge (again), as its webhook's job runs it. */
const merge = (number: number, title = `Change ${number}`) =>
  handlers.githubPullRequest(
    { installationId: repoId, action: "closed", repoId, repo, number, title, body: "", url: url(number), merged: true, labels: [], author: "octocat", mergedAt: days(60) },
    { info: () => undefined, warn: () => undefined },
  );

test("the merged pull requests no entry has: the last 30 days' or since the latest entry if that's longer ago, newest first, with what Autopilot found", async () => {
  github.pullRequest(repo, { number: 1, title: "Old news", mergedAt: days(20) });
  github.pullRequest(repo, { number: 6, title: "Long ago", mergedAt: days(45) });
  github.pullRequest(repo, { number: 7, title: "Before the last release", mergedAt: days(90) });
  github.pullRequest(repo, { number: 2, title: "Add a dark theme", mergedAt: days(3), author: "ada" });
  github.pullRequest(repo, { number: 3, title: "Bump dependencies", mergedAt: days(2) });
  github.pullRequest(repo, { number: 4, title: "Speed up search", mergedAt: days(1) });
  github.pullRequest(repo, { number: 5, title: "Not merged", open: true });
  // Nothing published yet: the last 30 days.
  expect(await missing()).toEqual([4, 3, 2, 1]);
  // Autopilot analysed three of them: #2 for users (its changelog line written), #3 nothing to do, #1 ready with only
  // docs to fix (the gate found nothing for users, so no line). One is in a draft already.
  const change = (number: number, state: "READY" | "NOTHING_TO_DO", line = false) =>
    prisma.codeChange.create({
      data: { projectId: project.id, repoId, repo, number, url: url(number), title: "t", author: "a", mergedAt: new Date(), state, forUsers: line, ...(line && { actions: { create: { kind: "CHANGELOG_LINE", probability: 1, status: "APPLIED", payload: { line: "A dark theme" } } } }) },
    });
  await Promise.all([change(2, "READY", true), change(3, "NOTHING_TO_DO"), change(1, "READY")]);
  await add(4);
  // An entry published 10 days ago changes nothing: one taken out of that draft, merged before it went out, is still looked for.
  const out = await call(createChangelogEntry, team(), { title: "Last release" });
  await call(publishChangelogEntry, team(), { number: out.number });
  const publishedOn = (date: string) => prisma.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number: out.number } }, data: { publishedAt: new Date(date) } });
  await publishedOn(days(10));

  expect((await call(listMissingChanges, team(), {})).pullRequests).toEqual([
    { repo, number: 3, title: "Bump dependencies", url: url(3), author: "octocat", mergedAt: expect.any(String), forUsers: false },
    { repo, number: 2, title: "Add a dark theme", url: url(2), author: "ada", mergedAt: expect.any(String), forUsers: true },
    { repo, number: 1, title: "Old news", url: url(1), author: "octocat", mergedAt: expect.any(String), forUsers: false },
  ]);
  // The latest entry went out longer ago than that: since then, to the moment.
  const longAgo = "2026-01-15T12:00:00.000Z";
  github.pullRequest(repo, { number: 6, title: "Long ago", mergedAt: "2026-02-01T00:00:00Z" });
  github.pullRequest(repo, { number: 7, title: "Before the last release", mergedAt: "2026-01-01T00:00:00Z" });
  await publishedOn(longAgo);
  const sinceThen = await call(listMissingChanges, team(), {});
  expect(sinceThen.since).toBe(longAgo);
  expect(sinceThen.pullRequests.map((pr) => pr.number)).toEqual([3, 2, 1, 6]);
  // Asked for from a date.
  expect(await missing("2025-12-01T00:00:00.000Z")).toEqual([3, 2, 1, 6, 7]);
  expect(await missing(days(2.5))).toEqual([3]);

  // Without GitHub connected there's nothing to read.
  await prisma.githubInstallation.delete({ where: { projectId: project.id } });
  await expect(call(listMissingChanges, team(), {})).rejects.toMatchObject({ status: 409, code: "github_not_connected" });
  await expect(add(2)).rejects.toMatchObject({ status: 409, code: "github_not_connected" });
});

test("the list reads as far back as the date asked for, and no further: page by page, stopping at the first one last touched before it", async () => {
  // 230 merged a day apart, the latest yesterday: three pages of 100.
  for (let number = 1; number <= 230; number++) {
    github.pullRequest(repo, { number, title: `Change ${number}`, mergedAt: days(231 - number) });
  }
  const pages = () => github.reads.filter((read) => read.startsWith(`/repos/${repo}/pulls?page=`)).length;
  // The last 30 days are on the first page: one request.
  let before = pages();
  expect(await missing()).toHaveLength(30);
  expect(pages() - before).toBe(1);
  // 150 days back: into the second page, and not the third.
  before = pages();
  expect(await missing(days(150.5))).toHaveLength(150);
  expect(pages() - before).toBe(2);
  // All of them: every page there is.
  before = pages();
  expect(await missing(days(400))).toHaveLength(230);
  expect(pages() - before).toBe(3);
});

test("picked ones go into the running draft as a merge does, analysed past Autopilot's gate; one an entry has stays where it is", async () => {
  github.pullRequest(repo, { number: 2, title: "Add a dark theme", mergedAt: days(3), author: "ada" });
  github.pullRequest(repo, { number: 3, title: "Bump dependencies", mergedAt: days(2) });
  github.pullRequest(repo, { number: 5, title: "Not merged", open: true });
  // Autopilot found nothing for users in #3: someone picking it for the changelog decides otherwise, and their decision is kept.
  const ruledOut = await prisma.codeChange.create({ data: { projectId: project.id, repoId, repo, number: 3, url: url(3), title: "Bump dependencies", author: "a", mergedAt: new Date(), state: "NOTHING_TO_DO" } });

  // One that isn't a merged pull request of the project's refuses the lot: nothing is added.
  await expect(add(2, 5)).rejects.toMatchObject({ status: 400, message: `${repo}#5 isn't merged` });
  await expect(add(2, 99)).rejects.toMatchObject({ status: 400, message: `There's no pull request ${repo}#99 on the project's repositories` });
  await expect(call(addChangelogPullRequests, team(), { pullRequests: [{ repo: "someone/else", number: 2 }] })).rejects.toMatchObject({ status: 400 });
  expect(await prisma.changelogEntry.count({ where: { projectId: project.id } })).toBe(0);

  // The running draft is started for them, a line each.
  const added = await add(2, 3);
  expect(added).toEqual({ number: 1, added: [{ repo, number: 2 }, { repo, number: 3 }], alreadyIn: [] });
  const draft = await entry(1);
  expect(draft).toMatchObject({ title: "Next release", collecting: true, status: "draft" });
  expect(draft.pullRequests).toEqual([
    { repo, number: 2, url: url(2), title: "Add a dark theme" },
    { repo, number: 3, url: url(3), title: "Bump dependencies" },
  ]);
  expect(draft.body).toBe(`Add a dark theme (${repo}#2)\nBump dependencies (${repo}#3)`);
  // Each is a code change by the time this answers, the team's pick kept, and its analysis is queued past the gate: a
  // new one's, and again the one the gate had ruled out (as "Analyse anyway").
  const changes = await prisma.codeChange.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" }, select: { id: true, number: true, state: true, author: true } });
  expect(changes).toEqual([
    { id: expect.any(String), number: 2, state: "ANALYSING", author: "ada" },
    { id: ruledOut.id, number: 3, state: "ANALYSING", author: "a" },
  ]);
  expect(await decisions()).toEqual([
    { number: 2, takenOut: false },
    { number: 3, takenOut: false },
  ]);
  await addedPullRequestsAnalysed();
  expect(queue.enqueue).toHaveBeenCalledTimes(2);
  expect(queue.enqueue.mock.calls).toEqual([
    ["codeChange", { codeChangeId: changes[0]!.id, force: false, pastGate: true, resume: false }],
    ["codeChange", { codeChangeId: ruledOut.id, force: true, pastGate: true, resume: false, was: "NOTHING_TO_DO" }],
  ]);
  // Again: they're where they are, and nothing is queued twice.
  queue.enqueue.mockClear();
  expect(await add(3, 2)).toEqual({ number: 1, added: [], alreadyIn: [{ repo, number: 3 }, { repo, number: 2 }] });
  expect(queue.enqueue).not.toHaveBeenCalled();
  expect((await entry(1)).pullRequests).toHaveLength(2);
});

test("taken out before its analysis has run, an added pull request is kept out; taken out long ago, it's still listed", async () => {
  github.pullRequest(repo, { number: 2, title: "Add a dark theme", mergedAt: days(3) });
  github.pullRequest(repo, { number: 3, title: "Speed up search", mergedAt: days(60) });
  await add(2, 3);
  // Straight away: the analyses are only queued, and the team's word is kept.
  await call(removeChangelogPullRequest, team(), { number: 1, url: url(3) });
  expect(await decisions()).toEqual([
    { number: 2, takenOut: false },
    { number: 3, takenOut: true },
  ]);
  // It merged 60 days ago, further back than the list looks by default: listed all the same, as one they took out.
  expect(await missing()).toEqual([3]);
});

test("ready with only docs to fix (the gate found nothing for users), a pull request the team adds is analysed past the gate too; one that has its line isn't analysed twice", async () => {
  github.pullRequest(repo, { number: 2, title: "Add a dark theme", mergedAt: days(3) });
  github.pullRequest(repo, { number: 3, title: "Refactor the settings store", mergedAt: days(2) });
  const ready = (number: number, line: boolean) =>
    prisma.codeChange.create({
      data: { projectId: project.id, repoId, repo, number, url: url(number), title: "t", author: "a", mergedAt: new Date(days(2)), state: "READY", ...(line && { actions: { create: { kind: "CHANGELOG_LINE", probability: 1, status: "APPLIED", payload: { line: "A dark theme" } } } }) },
    });
  const [written, docsOnly] = [await ready(2, true), await ready(3, false)];

  await add(2, 3);
  await addedPullRequestsAnalysed();

  expect(queue.enqueue.mock.calls).toEqual([["codeChange", { codeChangeId: docsOnly.id, force: true, pastGate: true, resume: false, was: "READY" }]]);
  expect(await prisma.codeChange.findMany({ where: { id: { in: [written.id, docsOnly.id] } }, orderBy: { number: "asc" }, select: { number: true, state: true } })).toEqual([
    { number: 2, state: "READY" },
    { number: 3, state: "ANALYSING" },
  ]);
  // The one with its line has it in its new bullet; the other its title until its analysis writes one.
  expect((await entry(1)).body).toBe(`A dark theme\nRefactor the settings store (${repo}#3)`);
});

test("on a queue that refuses it, a pull request the gate had ruled out is added all the same, its code change put back as it was", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  github.pullRequest(repo, { number: 3, title: "Bump dependencies", mergedAt: days(2) });
  const ruledOut = await prisma.codeChange.create({
    data: { projectId: project.id, repoId, repo, number: 3, url: url(3), title: "Bump dependencies", author: "a", mergedAt: new Date(days(2)), state: "NOTHING_TO_DO", reason: "Only dependencies changed." },
  });
  queue.enqueue.mockRejectedValueOnce(new Error("Hatchet is unreachable"));

  expect(await add(3)).toEqual({ number: 1, added: [{ repo, number: 3 }], alreadyIn: [] });

  expect(queue.enqueue).toHaveBeenCalledTimes(1);
  // Not left analysing with no run to finish it: as the gate left it, to ask for again.
  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: ruledOut.id }, select: { state: true, reason: true } })).toEqual({
    state: "NOTHING_TO_DO",
    reason: "Only dependencies changed.",
  });
  expect(await decisions()).toEqual([{ number: 3, takenOut: false }]);
  expect((await entry(1)).pullRequests).toEqual([{ repo, number: 3, url: url(3), title: "Bump dependencies" }]);
});

test("on a queue that refuses it, one with no code change before is failed for the retry sweep, not left analysing", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  github.pullRequest(repo, { number: 6, title: "Add a dark theme", mergedAt: days(2) });
  queue.enqueue.mockRejectedValueOnce(new Error("Hatchet is unreachable"));

  expect(await add(6)).toMatchObject({ added: [{ repo, number: 6 }] });

  expect(await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 6 }, select: { state: true, retryAt: true, retryPastGate: true } })).toEqual({
    state: "FAILED",
    retryAt: expect.any(Date),
    retryPastGate: true,
  });
});

test("one that failed before, picked on a queue that refuses it: its retry runs past the gate", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  github.pullRequest(repo, { number: 8, title: "Add a dark theme", mergedAt: days(2) });
  await prisma.codeChange.create({
    data: { projectId: project.id, repoId, repo, number: 8, url: url(8), title: "t", author: "a", mergedAt: new Date(days(2)), state: "FAILED", reason: "The AI provider didn't answer.", retryAt: new Date(), retryPastGate: false },
  });
  queue.enqueue.mockRejectedValueOnce(new Error("Hatchet is unreachable"));

  await add(8);

  expect(await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 8 }, select: { state: true, retryPastGate: true } })).toEqual({ state: "FAILED", retryPastGate: true });
});

test("on a queue that refuses it, one a run started on meanwhile isn't failed", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  github.pullRequest(repo, { number: 6, title: "Add a dark theme", mergedAt: days(2) });
  // Another run (a merge delivered meanwhile) starts on it while this one is being queued; then queueing fails.
  queue.enqueue.mockImplementationOnce(async () => {
    await prisma.codeChange.updateMany({ where: { projectId: project.id, number: 6 }, data: { state: "ANALYSING", updatedAt: new Date(Date.now() + 60_000) } });
    throw new Error("Hatchet is unreachable");
  });

  await add(6);

  expect(await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 6 }, select: { state: true, retryAt: true } })).toEqual({ state: "ANALYSING", retryAt: null });
});

test("a queue that refuses puts back only its own claim: one made meanwhile, still running, stays", async () => {
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  github.pullRequest(repo, { number: 3, title: "Bump dependencies", mergedAt: days(2) });
  const ruledOut = await prisma.codeChange.create({
    data: { projectId: project.id, repoId, repo, number: 3, url: url(3), title: "Bump dependencies", author: "a", mergedAt: new Date(days(2)), state: "NOTHING_TO_DO", reason: "Only dependencies changed." },
  });
  // While this run is being queued, another claims the code change (a later run, analysing it now); then queueing fails.
  queue.enqueue.mockImplementationOnce(async () => {
    await prisma.codeChange.update({ where: { id: ruledOut.id }, data: { updatedAt: new Date(Date.now() + 60_000) } });
    throw new Error("Hatchet is unreachable");
  });

  await add(3);

  expect(await prisma.codeChange.findUniqueOrThrow({ where: { id: ruledOut.id }, select: { state: true } })).toEqual({ state: "ANALYSING" });
});

test("one taken out of a draft goes with its line, is missing again, and can go into the next; a published entry's stay", async () => {
  github.pullRequest(repo, { number: 2, title: "Add a dark theme", mergedAt: days(3) });
  github.pullRequest(repo, { number: 3, title: "Speed up search", mergedAt: days(2) });
  await add(2, 3);
  // The team wrote something of their own under the list.
  const written = await entry(1);
  await call(updateChangelogEntry, team(), { number: 1, content: { type: "doc", content: [...written.content.content!, { type: "paragraph", content: [{ type: "text", text: "Thanks for the feedback!" }] }] } });

  // It ships later: out of this draft, its line with it; the rest of the text stays.
  const without = await call(removeChangelogPullRequest, team(), { number: 1, url: url(3) });
  expect(without.pullRequests).toEqual([{ repo, number: 2, url: url(2), title: "Add a dark theme" }]);
  expect(without.body).toBe(`Add a dark theme (${repo}#2)\nThanks for the feedback!`);
  // In no entry now: it's listed again, to add to the next one.
  expect(await missing()).toEqual([3]);
  await expect(call(removeChangelogPullRequest, team(), { number: 1, url: url(3) })).rejects.toMatchObject({ status: 404, message: "This entry has no such pull request" });
  await expect(call(removeChangelogPullRequest, team(), { number: 7, url: url(2) })).rejects.toMatchObject({ status: 404 });

  // Published, an entry keeps its pull requests; the one taken out is still listed, and the next draft takes it.
  await call(publishChangelogEntry, team(), { number: 1 });
  await expect(call(removeChangelogPullRequest, team(), { number: 1, url: url(2) })).rejects.toMatchObject({ status: 409, code: "published" });
  expect(await missing()).toEqual([3]);
  expect(await add(3)).toEqual({ number: 2, added: [{ repo, number: 3 }], alreadyIn: [] });
  expect((await entry(2)).pullRequests).toEqual([{ repo, number: 3, url: url(3), title: "Speed up search" }]);
  expect(await missing()).toEqual([]);
});

test("analysis off: taken out long after it merged, a pull request is still listed, and a merge delivered again leaves it out", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  github.pullRequest(repo, { number: 3, title: "Speed up search", mergedAt: days(60), author: "ada" });
  await merge(3, "Speed up search");
  expect(await prisma.codeChange.count({ where: { projectId: project.id } })).toBe(0);
  expect((await entry(1)).pullRequests).toEqual([{ repo, number: 3, url: url(3), title: "Speed up search" }]);

  // It ships later: taken out, with no code change to say so on, and kept as GitHub has it.
  await call(removeChangelogPullRequest, team(), { number: 1, url: url(3) });
  expect(await prisma.changelogDecision.findMany({ where: { projectId: project.id }, select: { repoId: true, repo: true, number: true, url: true, title: true, author: true, mergedAt: true, takenOut: true } })).toEqual([
    { repoId, repo, number: 3, url: url(3), title: "Speed up search", author: "ada", mergedAt: new Date(days(60)), takenOut: true },
  ]);
  expect(await missing()).toEqual([3]);
  // GitHub delivering the merge again doesn't put it back.
  await merge(3, "Speed up search");
  expect((await entry(1)).pullRequests).toEqual([]);
  expect(await missing()).toEqual([3]);
});

test("taken out, a pull request is listed under its repository's name now, and not once the project no longer includes it", async () => {
  github.pullRequest(repo, { number: 3, title: "Speed up search", mergedAt: days(60) });
  await add(3);
  await call(removeChangelogPullRequest, team(), { number: 1, url: url(3) });
  // Renamed: listed under the new name (the one adding it goes by).
  const renamed = `${repo}-renamed`;
  await prisma.githubRepository.update({ where: { repoId }, data: { fullName: renamed } });
  expect((await call(listMissingChanges, team(), {})).pullRequests).toMatchObject([{ repo: renamed, number: 3 }]);
  // Removed from the project's repositories: not offered (adding it would be refused).
  await prisma.githubRepository.delete({ where: { repoId } });
  expect(await missing()).toEqual([]);
});

test("a renamed repository's pull requests an entry has aren't missing, and adding one again doesn't put it in twice", async () => {
  github.pullRequest(repo, { number: 8, title: "Add a dark theme", mergedAt: days(3) });
  // Merged before the rename: its code change and the draft's row keep the page GitHub gave then (the merge's analysis
  // isn't run here: its code change is made as it would be).
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  await merge(8, "Add a dark theme");
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: true } });
  await prisma.codeChange.create({ data: { projectId: project.id, repoId, repo, number: 8, url: url(8), title: "Add a dark theme", author: "a", mergedAt: new Date(days(3)), state: "READY", forUsers: true } });
  const renamed = `${repo}-renamed`;
  await prisma.githubRepository.update({ where: { repoId }, data: { fullName: renamed } });
  github.pullRequest(renamed, { number: 8, title: "Add a dark theme", mergedAt: days(3) });

  expect(await missing()).toEqual([]);
  expect(await call(addChangelogPullRequests, team(), { pullRequests: [{ repo: renamed, number: 8 }] })).toEqual({ number: 1, added: [], alreadyIn: [{ repo: renamed, number: 8 }] });
  expect((await entry(1)).pullRequests).toEqual([{ repo, number: 8, url: url(8), title: "Add a dark theme" }]);
});

test("never asked the gate (analysed only past it, as the team's pick is): the list doesn't say whether users see it", async () => {
  github.pullRequest(repo, { number: 9, title: "Bump dependencies", mergedAt: days(3) });
  // Picked, analysed past the gate (its line written, as every such run writes one), then taken out again.
  await prisma.codeChange.create({
    data: { projectId: project.id, repoId, repo, number: 9, url: url(9), title: "t", author: "a", mergedAt: new Date(days(3)), state: "READY", actions: { create: { kind: "CHANGELOG_LINE", probability: 1, status: "APPLIED", payload: { line: "Dependencies" } } } },
  });
  expect((await call(listMissingChanges, team(), {})).pullRequests).toMatchObject([{ number: 9, forUsers: null }]);
});

test("the gate's word is the one its analysis saved, also where the team took the pull request out before its line was written", async () => {
  github.pullRequest(repo, { number: 4, title: "Add a dark theme", mergedAt: days(3) });
  // Ready, the gate saying users see it, and no changelog line (the team took it out first).
  await prisma.codeChange.create({ data: { projectId: project.id, repoId, repo, number: 4, url: url(4), title: "t", author: "a", mergedAt: new Date(days(3)), state: "READY", forUsers: true } });
  expect((await call(listMissingChanges, team(), {})).pullRequests).toMatchObject([{ number: 4, forUsers: true }]);
});

test("a repository with more pull requests since the date asked for than are read at once: the answer says how far back it reaches", async () => {
  // 2,100 merged an hour apart: the newest 2,000 are read (20 pages of 100).
  for (let number = 1; number <= 2100; number++) {
    github.pullRequest(repo, { number, title: `Change ${number}`, mergedAt: new Date(NOW.getTime() - (2101 - number) * 3_600_000).toISOString() });
  }
  const read = await call(listMissingChanges, team(), { since: days(200) });
  // The oldest of those last changed 2,000 hours ago: everything merged since then is listed, and nothing claims more.
  expect(read.since).toBe(new Date(NOW.getTime() - 2000 * 3_600_000).toISOString());
  expect(read.pullRequests).toHaveLength(2000);
  expect(read.pullRequests.at(-1)!.number).toBe(101);
});

test("one whose code change can't be saved is added all the same, and the rest are still analysed", async () => {
  github.pullRequest(repo, { number: 2, title: "Add a dark theme", mergedAt: days(3) });
  github.pullRequest(repo, { number: 3, title: "Speed up search", mergedAt: days(2) });
  queue.claimFails.add(2);
  const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

  expect(await add(2, 3)).toEqual({ number: 1, added: [{ repo, number: 2 }, { repo, number: 3 }], alreadyIn: [] });

  await addedPullRequestsAnalysed();
  const three = await prisma.codeChange.findFirstOrThrow({ where: { projectId: project.id, number: 3 }, select: { id: true } });
  expect(queue.enqueue.mock.calls).toEqual([["codeChange", { codeChangeId: three.id, force: false, pastGate: true, resume: false }]]);
  expect(warn).toHaveBeenCalledWith("A pull request added to the changelog couldn't be analysed", expect.objectContaining({ number: 2 }));
  warn.mockRestore();
});

test("in-process, a ruled-out pull request analysed some other way before its turn comes isn't analysed again", async () => {
  github.pullRequest(repo, { number: 2, title: "Add a dark theme", mergedAt: days(3) });
  github.pullRequest(repo, { number: 3, title: "Bump dependencies", mergedAt: days(2) });
  const ruledOut = await prisma.codeChange.create({ data: { projectId: project.id, repoId, repo, number: 3, url: url(3), title: "Bump dependencies", author: "a", mergedAt: new Date(days(2)), state: "NOTHING_TO_DO" } });
  // #2's analysis takes a while (the analyses run one after another after the request answers)...
  let finish: () => void = () => undefined;
  queue.enqueue.mockImplementationOnce(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
  await add(2, 3);
  // ...and meanwhile someone ran "Analyse anyway" on #3, which is done.
  await prisma.codeChange.update({ where: { id: ruledOut.id }, data: { state: "READY", forUsers: true } });
  finish();
  await addedPullRequestsAnalysed();

  expect(queue.enqueue).toHaveBeenCalledTimes(1);
  expect(queue.enqueue.mock.calls[0]![1]).toMatchObject({ force: false });
});
