import type { ArticleCandidate, PostCandidate } from "./code-change-decisions";
import type { PullRequestRead } from "./pull-request";

/**
 * The evaluation set for code changes' decisions (code-change-decisions.live.test.ts): merged pull
 * requests of a made-up product (Pebble, a team task tracker), with posts and articles and the
 * proposals a careful team member would expect. Where a reasonable person could go either way, the
 * case accepts both. Add a case for every decision a team tells us was wrong.
 */

type Expected<T> = T | T[];

export type EvalCase = {
  name: string;
  pr: PullRequestRead;
  /** Does anything users see change? */
  users: boolean;
  /** What users would read about it (the summary the writing model gives), for cases users see. */
  summary?: string;
  posts?: { post: keyof typeof POSTS; expect: Expected<"RESOLVES" | "MOVES_FORWARD" | "LINKS" | null>; named?: boolean }[];
  articles?: { article: keyof typeof ARTICLES; expect: Expected<"ARTICLE_EDIT" | null> }[];
  newArticle?: Expected<boolean>;
};

const POSTS = {
  darkMode: ["Dark mode", "The white background hurts my eyes at night. Please add a dark theme."],
  csv: ["Export tasks to CSV", "We report on our tasks every month and need them in a spreadsheet."],
  recurring: ["Recurring tasks", "Let a task repeat every week, or every month on a date, like our Monday stand-up and the monthly invoice run."],
  slack: ["Slack notifications", "Post to our Slack channel when a task is assigned and when it's done."],
  shortcuts: ["More keyboard shortcuts", "Let me assign a task with A and set its due date with D, without the mouse."],
  reminders: ["Due date reminders", "Email me the day before a task is due, I keep missing deadlines."],
  search: ["Search is slow", "Searching takes several seconds on our big project, and it doesn't find words in descriptions."],
  attachments: ["Attach files to tasks", "Let us attach PDFs and screenshots to a task instead of linking to Drive."],
  bulk: ["Bulk edit tasks", "Select many tasks and change their assignee or status at once."],
  twoFactor: ["Two-factor authentication", "Our security review requires 2FA for every tool we use."],
} as const;

const ARTICLES = {
  exporting: ["Exporting your data", "You can export a project as JSON from Settings → Export. CSV isn't available yet: paste the JSON into a converter."],
  notifications: [
    "Notifications",
    "Pebble emails you when a task is assigned to you. Turn emails off in Profile → Notifications. Pebble doesn't send reminders about due dates.",
  ],
  shortcuts: ["Keyboard shortcuts", "Press ? to see every shortcut. N creates a task, / jumps to search and E edits the selected task."],
  signingIn: ["Signing in", "Sign in with your email and password, or with Google. Forgot your password? Use Reset password on the sign-in page."],
  dueDates: ["Due dates", "Give a task a due date from its side panel. Overdue tasks turn red on the board. When a task is done, click Archive."],
  searching: ["Searching tasks", "Type in the search box at the top of any page. Search matches task titles only."],
} as const;

export const post = (key: keyof typeof POSTS, named = false): PostCandidate => ({
  id: key,
  number: Object.keys(POSTS).indexOf(key) + 1,
  title: POSTS[key][0],
  body: POSTS[key][1],
  status: "OPEN",
  named,
});
export const article = (key: keyof typeof ARTICLES): ArticleCandidate => ({ id: key, title: ARTICLES[key][0], body: ARTICLES[key][1] });

const pr = (title: string, files: [string, string][], { body = "", labels = [] as string[], commits = [title] } = {}): PullRequestRead => ({
  title,
  body,
  labels,
  author: "dev",
  mergedAt: "2026-10-01T12:00:00Z",
  commits,
  files: files.map(([path]) => ({ path, status: "modified", additions: 10, deletions: 2 })),
  diff: files.map(([path, patch]) => `--- ${path} (modified, +10 -2)\n${patch}`).join("\n"),
});

export const CASES: EvalCase[] = [
  {
    name: "a dark theme",
    pr: pr(
      "Add a dark theme",
      [
        ["src/settings/appearance.tsx", '+<Select label="Theme" options={["Light", "Dark", "System"]} value={theme} onChange={setTheme} />'],
        ["src/styles/theme.css", "+.dark { --background: #111; --foreground: #eee; }"],
      ],
      { body: "Adds Settings → Appearance with Light, Dark and System." },
    ),
    users: true,
    summary: "You can now switch Pebble to a dark theme, or follow your system's setting, in Settings → Appearance.",
    posts: [
      { post: "darkMode", expect: "RESOLVES" },
      { post: "csv", expect: null },
      { post: "shortcuts", expect: null },
    ],
    articles: [{ article: "shortcuts", expect: null }],
  },
  {
    name: "CSV exports",
    pr: pr(
      "Export tasks as CSV",
      [
        ["src/settings/export.tsx", '+<Button onClick={() => download("csv")}>Export as CSV</Button>'],
        ["src/server/export.ts", "+export function toCsv(tasks: Task[]) {\n+  return [HEADER, ...tasks.map(row)].join(\"\\n\");\n+}"],
      ],
      { body: "Settings → Export now offers CSV next to JSON." },
    ),
    users: true,
    summary: "You can now export a project's tasks as a CSV file from Settings → Export, as well as JSON.",
    posts: [
      { post: "csv", expect: "RESOLVES" },
      { post: "bulk", expect: null },
    ],
    articles: [
      { article: "exporting", expect: "ARTICLE_EDIT" },
      { article: "searching", expect: null },
    ],
    newArticle: false,
  },
  {
    name: "a dependency bump",
    pr: pr("Bump eslint from 9.2 to 10.0", [["package.json", '-    "eslint": "^9.2.0",\n+    "eslint": "^10.0.0",']], { labels: ["dependencies"] }),
    users: false,
  },
  {
    name: "a refactor",
    pr: pr(
      "Move the task store into hooks",
      [
        ["src/tasks/store.ts", "-export class TaskStore {\n+export function useTasks() {"],
        ["src/tasks/board.tsx", "-const tasks = store.tasks;\n+const tasks = useTasks();"],
      ],
      { body: "No behaviour change: the board reads tasks through hooks now." },
    ),
    users: false,
  },
  {
    name: "a CI change",
    pr: pr("CI: cache the pnpm store", [[".github/workflows/ci.yml", "+      - uses: actions/cache@v4\n+        with:\n+          path: ~/.pnpm-store"]]),
    users: false,
  },
  {
    name: "due date reminders",
    pr: pr(
      "Email a reminder the day before a task is due",
      [
        ["src/jobs/reminders.ts", "+// Every morning: tasks due tomorrow, one email per assignee.\n+export async function sendReminders() {"],
        ["src/emails/reminder.tsx", "+<Text>{task.title} is due tomorrow.</Text>"],
        ["src/profile/notifications.tsx", '+<Switch label="Due date reminders" name="reminders" defaultChecked />'],
      ],
    ),
    users: true,
    summary: "Pebble now emails assignees the day before a task is due. You can turn these reminders off in Profile → Notifications.",
    posts: [
      { post: "reminders", expect: "RESOLVES" },
      { post: "slack", expect: ["LINKS", null] },
      { post: "attachments", expect: null },
    ],
    articles: [
      { article: "notifications", expect: "ARTICLE_EDIT" },
      { article: "dueDates", expect: ["ARTICLE_EDIT", null] },
    ],
    newArticle: false,
  },
  {
    name: "faster search, in descriptions too",
    pr: pr(
      "Search: full-text index over titles and descriptions",
      [
        ["db/migrations/0042_search.sql", "+CREATE INDEX task_search ON task USING gin (to_tsvector('simple', title || ' ' || description));"],
        ["src/server/search.ts", "-  where: { title: { contains: q } },\n+  where: sql`to_tsvector('simple', title || ' ' || description) @@ plainto_tsquery(${q})`,"],
      ],
      { body: "Search now uses a full-text index (about 10x faster on big projects) and matches descriptions as well as titles." },
    ),
    users: true,
    summary: "Search is much faster on big projects, and it now finds words in task descriptions as well as titles.",
    posts: [
      { post: "search", expect: "RESOLVES" },
      { post: "darkMode", expect: null },
    ],
    articles: [{ article: "searching", expect: "ARTICLE_EDIT" }],
    newArticle: false,
  },
  {
    name: "recurring tasks, weekly only",
    pr: pr(
      "Recurring tasks: repeat daily or weekly",
      [
        ["src/tasks/repeat.tsx", '+<Select label="Repeat" options={["Never", "Every day", "Every week"]} />'],
        ["src/jobs/recurrence.ts", "+// Monthly repeats come in a follow-up.\n+export function nextOccurrence(task: Task) {"],
      ],
      { body: "Tasks can repeat every day or every week. Monthly repeats on a date come next." },
    ),
    users: true,
    summary: "Tasks can now repeat every day or every week: pick it under Repeat in a task's side panel. Monthly repeats are coming.",
    posts: [
      { post: "recurring", expect: "MOVES_FORWARD" },
      { post: "bulk", expect: null },
    ],
    articles: [{ article: "dueDates", expect: ["ARTICLE_EDIT", null] }],
    newArticle: true,
  },
  {
    name: "Slack, when a task is done",
    pr: pr(
      "Slack: post to a channel when a task is done",
      [
        ["src/integrations/slack.ts", "+export async function postDone(task: Task) {\n+  await slack.chat.postMessage({ channel, text: `${task.title} is done` });"],
        ["src/settings/integrations.tsx", '+<Button onClick={connectSlack}>Connect Slack</Button>'],
      ],
      { body: "Connect Slack in Settings → Integrations and pick a channel; Pebble posts there when a task is done. Assignments come later." },
    ),
    users: true,
    summary: "You can now connect Slack in Settings → Integrations, and Pebble posts in the channel you pick when a task is done.",
    posts: [
      { post: "slack", expect: "MOVES_FORWARD" },
      { post: "reminders", expect: ["LINKS", null] },
    ],
    articles: [{ article: "notifications", expect: ["ARTICLE_EDIT", null] }],
    newArticle: true,
  },
  {
    name: "a fix to a shortcut",
    pr: pr("Fix: pressing N twice opened two new-task dialogs", [["src/shortcuts.ts", "-  onKey('n', openNewTask);\n+  onKey('n', () => !dialogOpen && openNewTask());"]]),
    users: true,
    summary: "Pressing N quickly twice no longer opens two new-task dialogs.",
    posts: [
      { post: "shortcuts", expect: ["LINKS", null] },
      { post: "csv", expect: null },
    ],
    articles: [{ article: "shortcuts", expect: null }],
    newArticle: false,
  },
  {
    name: "two-factor authentication",
    pr: pr(
      "Two-factor authentication with authenticator apps",
      [
        ["src/profile/security.tsx", '+<Button onClick={enrol}>Set up two-factor authentication</Button>'],
        ["src/auth/sign-in.tsx", '+{needsCode && <Input label="6-digit code from your authenticator app" />}'],
      ],
    ),
    users: true,
    summary: "You can now protect your account with two-factor authentication from Profile → Security: after your password, Pebble asks for a code from your authenticator app.",
    posts: [
      { post: "twoFactor", expect: "RESOLVES" },
      { post: "attachments", expect: null },
    ],
    articles: [{ article: "signingIn", expect: "ARTICLE_EDIT" }],
  },
  {
    name: "the repository's README",
    pr: pr("README: how to run Pebble locally", [["README.md", "+## Local setup\n+\n+1. `pnpm install`\n+2. `pnpm dev`"]]),
    users: false,
  },
  {
    name: "a renamed button",
    pr: pr("Rename the Archive button to Close", [["src/tasks/actions.tsx", '-<Button>Archive</Button>\n+<Button>Close</Button>']]),
    users: true,
    summary: "The Archive button on tasks is now called Close.",
    posts: [{ post: "bulk", expect: null }],
    articles: [
      { article: "dueDates", expect: "ARTICLE_EDIT" },
      { article: "exporting", expect: null },
    ],
    newArticle: false,
  },
  {
    name: "attachments",
    pr: pr(
      "Attachments: upload images and PDFs to a task",
      [
        ["src/tasks/attachments.tsx", '+<Dropzone accept="image/*,application/pdf" maxSize={10 * MB} onDrop={upload} />'],
        ["src/server/uploads.ts", "+export async function upload(taskId: string, file: File) {"],
      ],
      { body: "Drop files on a task's side panel, up to 10 MB each." },
    ),
    users: true,
    summary: "You can now attach images and PDFs (up to 10 MB each) to a task by dropping them on its side panel.",
    posts: [
      { post: "attachments", expect: "RESOLVES" },
      { post: "twoFactor", expect: null },
    ],
    articles: [{ article: "dueDates", expect: null }],
    newArticle: true,
  },
  {
    name: "logging slow queries",
    pr: pr("Log queries slower than 500 ms", [["src/server/db.ts", "+db.on('query', (q) => q.duration > 500 && logger.warn('slow query', { ms: q.duration }));"]]),
    users: false,
  },
  {
    name: "a named post it doesn't resolve",
    pr: pr("Prepare the task panel for keyboard actions (tuti#5)", [["src/tasks/panel.tsx", "-<div className=\"panel\">\n+<div className=\"panel\" tabIndex={-1} ref={panelRef}>"]], {
      body: "Groundwork for tuti#5: the panel can take focus. No new shortcuts yet.",
    }),
    users: false,
  },
  {
    name: "a named post it resolves",
    pr: pr(
      "Shortcuts: A assigns, D sets the due date (tuti#5)",
      [
        ["src/shortcuts.ts", "+  onKey('a', openAssignee);\n+  onKey('d', openDueDate);"],
        ["src/shortcuts-help.tsx", "+<Row keys=\"A\">Assign the selected task</Row>\n+<Row keys=\"D\">Set its due date</Row>"],
      ],
      { body: "Closes tuti#5." },
    ),
    users: true,
    summary: "Two new keyboard shortcuts: A assigns the selected task and D sets its due date.",
    posts: [
      { post: "shortcuts", expect: "RESOLVES", named: true },
      { post: "reminders", expect: null },
    ],
    articles: [{ article: "shortcuts", expect: "ARTICLE_EDIT" }],
    newArticle: false,
  },
];
