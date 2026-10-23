import type { GithubApi } from "./github-api";

/**
 * What a code change reads of a merged pull request, with the installation's token: its text, labels,
 * commits, changed files and diff. The diff goes to the AI provider only: never logged or stored.
 * Before that, files nobody needs to read (lockfiles, generated files, binaries) and files that hold
 * secrets are left out, secret-looking strings are masked, and the whole is capped.
 */
export type PullRequestRead = {
  title: string;
  body: string;
  labels: string[];
  author: string;
  mergedAt: string;
  commits: string[];
  /** Every changed file; `left` says why its diff isn't in `diff`. */
  files: { path: string; status: string; additions: number; deletions: number; left?: LeftOut }[];
  diff: string;
};

export type LeftOut = "lockfile" | "generated" | "binary" | "secrets" | "size";

/**
 * The diff's cap, in characters. Decision models answer best under about 32 KB of text (Jev's long
 * context mode beyond it is slower and less accurate), and the pull request's text and the post or
 * article it's asked about need room too. ponytail: files past it are only listed; split a big one
 * into several decisions if they turn out to matter.
 */
export const DIFF_CAP = 20_000;
/** One file's share at most, so a big one doesn't crowd out the rest. */
const FILE_CAP = 6_000;
const BODY_CAP = 4_000;
const COMMITS_CAP = 50;

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
  "packages.lock.json",
  "flake.lock",
]);
const GENERATED = [
  /(^|\/)(dist|build|out|vendor|node_modules|__snapshots__|\.next|coverage)\//,
  /\.min\.(js|css)$/,
  /\.(map|snap)$/,
  /\.generated\.[^/]+$/,
  /\.pb\.go$/,
  /_pb2\.py$/,
];
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svg|psd|ai|sketch|fig|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|webm|wav|ogg|flac|exe|dll|so|dylib|a|o|class|wasm|bin|dat|db|sqlite3?|pyc)$/i;
const SECRET_FILES = [
  /(^|\/)\.env($|\.)/,
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|tfvars|tfstate)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc|\.htpasswd|\.git-credentials)$/,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
];

/** Why a file's diff isn't read, or undefined to read it. */
export function leftOut(path: string): Exclude<LeftOut, "size"> | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (SECRET_FILES.some((pattern) => pattern.test(path))) {
    return "secrets";
  }
  if (LOCKFILES.has(name)) {
    return "lockfile";
  }
  if (BINARY.test(name)) {
    return "binary";
  }
  if (GENERATED.some((pattern) => pattern.test(path))) {
    return "generated";
  }
  return undefined;
}

const MASK = "[secret]";
const SECRETS: [RegExp, string][] = [
  // A private key, to its end (or the end of the text, if the diff was cut).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Tokens with a known shape: GitHub, OpenAI and OpenRouter, Slack, AWS, Google, GitLab, Stripe, JWTs, Tuti's own.
  [
    /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|A[KS]IA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|[sr]k_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|tuti_[A-Za-z0-9_-]{20,})/g,
    MASK,
  ],
  // The password in a connection string (postgres://user:password@host).
  [/\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@'"]{1,200}:)[^\s@/'"]{1,200}@/gi, `$1${MASK}@`],
  // A quoted value given to something named like a secret: password: "…", apiKey = '…'.
  [/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(["'])[^"'\s]{8,}\2/gi, `$1$2${MASK}$2`],
  // An env-style line: SOMETHING_SECRET=value.
  [/^([+ -]?\s*(?:export\s+)?[A-Z0-9_]{0,60}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]{0,60}\s*=\s*)\S{8,}$/gm, `$1${MASK}`],
];

/** The text with secret-looking strings masked. */
export function maskSecrets(text: string): string {
  return SECRETS.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);
}

/** At most `length` characters of the text, all of it masked first, so the cut can't leave part of a secret unmasked. */
const maskedStart = (text: string, length: number) => maskSecrets(text).slice(0, length);

type GithubPull = {
  title: string;
  body: string | null;
  user: { login: string } | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  labels: { name: string }[];
};
type GithubFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
type GithubContent = { type?: string; encoding?: string; content?: string };

/** Reads a merged pull request for its code change (see PullRequestRead). Throws if GitHub can't say. */
export async function readPullRequest(api: GithubApi, repo: string, number: number): Promise<PullRequestRead> {
  const base = `/repos/${repo}/pulls/${number}`;
  const [pull, commits, files] = await Promise.all([
    api.get<GithubPull>(base),
    // GitHub lists at most 250 commits and 3,000 files for a pull request.
    api.list<{ commit: { message: string } }>(`${base}/commits`, (page) => page as { commit: { message: string } }[], 3),
    api.list<GithubFile>(`${base}/files`, (page) => page as GithubFile[], 30),
  ]);
  const read: PullRequestRead = {
    title: pull.title,
    body: maskedStart(pull.body ?? "", BODY_CAP),
    labels: pull.labels.map((label) => label.name),
    author: pull.user?.login ?? "",
    mergedAt: pull.merged_at ?? new Date().toISOString(),
    // Newest last, like GitHub; the first lines say most.
    commits: commits.slice(-COMMITS_CAP).map((c) => maskedStart(c.commit.message.split("\n")[0]!, 200)),
    files: [],
    diff: "",
  };
  const parts: string[] = [];
  let size = 0;
  for (const file of files) {
    const entry: PullRequestRead["files"][number] = { path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions };
    read.files.push(entry);
    entry.left = leftOut(file.filename);
    if (entry.left) {
      continue;
    }
    if (size >= DIFF_CAP) {
      entry.left = "size";
      continue;
    }
    // GitHub leaves out the patch of a file whose diff is too big: the new version's start says what it is.
    let text = file.patch;
    if (text === undefined && file.status !== "removed" && pull.merge_commit_sha) {
      text = await fileStart(api, repo, file.filename, pull.merge_commit_sha);
    }
    if (text === undefined) {
      entry.left = "size";
      continue;
    }
    const part = `--- ${file.filename} (${file.status}, +${file.additions} -${file.deletions})${file.patch === undefined ? ", whole file" : ""}\n${maskedStart(text, Math.min(FILE_CAP, DIFF_CAP - size))}`;
    parts.push(part);
    size += part.length;
  }
  read.diff = parts.join("\n");
  return read;
}

/** A text file's start at a commit, or undefined for a binary file or one GitHub won't send (over 1 MB). */
async function fileStart(api: GithubApi, repo: string, path: string, ref: string): Promise<string | undefined> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const content = await api.find<GithubContent>(`/repos/${repo}/contents/${encoded}?ref=${ref}`);
  if (content?.type !== "file" || content.encoding !== "base64" || !content.content) {
    return undefined;
  }
  const text = Buffer.from(content.content, "base64").toString("utf8");
  return text.includes("\u0000") ? undefined : maskSecrets(text);
}
