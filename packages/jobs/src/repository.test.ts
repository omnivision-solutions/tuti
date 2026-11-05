import { type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { runTool, type ToolContext } from "./docs-agent-tools";
import { installationApi } from "./github-api";
import { readRepository, type Repository, tarEntries } from "./repository";

let github: GithubFake;
beforeAll(async () => {
  github = await startGithubFake();
});
afterAll(() => github.close());
beforeEach(() => {
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, value);
  }
});

const longPath = `src/${"deeply-nested-folder/".repeat(6)}settings-page.tsx`;

const read = async (files: Record<string, string>, limits?: Parameters<typeof readRepository>[3]) => {
  github.repository("acme/app", { commit: "merge-sha", files });
  return readRepository(await installationApi(1), "acme/app", "merge-sha", limits);
};

test("the merge commit's archive is read into memory: its top folder stripped, long paths through pax, binaries, big files and secrets left out", async () => {
  const repository = (await read(
    {
      "README.md": "# Acme\n",
      [longPath]: "export const title = 'Settings';\n",
      "logo.bin": "PNG\u0000\u0001binary",
      "assets/blob": "PNG\u0000\u0001binary",
      "data/big.json": "x".repeat(2_000),
      ".env": "API_KEY=secret-value\n",
    },
    { fileBytes: 1_000 },
  )) as Repository;
  expect(Object.fromEntries(repository.files)).toEqual({ "README.md": "# Acme\n", [longPath]: "export const title = 'Settings';\n" });
  expect(Object.fromEntries(repository.skipped)).toEqual({
    "logo.bin": "it's a binary file",
    "assets/blob": "it's a binary file",
    "data/big.json": "it's over 1,000 bytes",
    ".env": "it may hold secrets",
  });
  expect(github.reads).toContain("/repos/acme/app/tarball/merge-sha");
});

test("an archive over the total limit, or one that can't be downloaded, says so instead", async () => {
  expect(await read({ "a.txt": "a".repeat(5_000), "b.txt": "b".repeat(5_000) }, { archiveBytes: 6_000 })).toEqual({
    unavailable: "The repository is over 0.006 MB unpacked",
  });
  expect(await readRepository(await installationApi(1), "acme/app", "no-such-commit")).toEqual({
    unavailable: "The repository couldn't be downloaded: GitHub /repos/acme/app/tarball/no-such-commit answered 404",
  });
});

test("an archive cut short between files is an error, not a smaller repository", async () => {
  const header = Buffer.alloc(512);
  header.write("app/a.txt", 0);
  header.write(`${(2).toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  const file = Buffer.concat([header, Buffer.from("hi"), Buffer.alloc(510)]);
  const read = async (chunks: Buffer[]) => {
    const paths: string[] = [];
    for await (const entry of tarEntries((async function* () { yield* chunks; })(), 1_000, () => false)) paths.push(entry.path);
    return paths;
  };
  expect(await read([file, Buffer.alloc(1024)])).toEqual(["app/a.txt"]);
  await expect(read([file])).rejects.toThrow("the archive ended early");
});

const repository: Repository = {
  files: new Map([
    ["src/app.ts", "const a = 1;\nexport function exportCsv() {}\nconst token = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n"],
    ["src/lib/util.ts", "export const EXPORT_LIMIT = 10;\n"],
    ["docs/README.md", "x".repeat(100)],
    ["slow.txt", `${"a".repeat(40)}!`],
    ["src/config.ts", `${"x".repeat(285)} "sk-abcdefghijklmnopqrstuvwxyz0123";`],
  ]),
  skipped: new Map([["logo.png", "it's a binary file"]]),
};
const context = (limits?: ToolContext["limits"]): ToolContext => ({ projectId: "unused", repository, limits });
const call = (name: string, args: unknown, limits?: ToolContext["limits"]) => runTool(context(limits), { name, arguments: JSON.stringify(args) });

test("list_files lists the paths under a prefix (the left-out ones marked), capped", async () => {
  expect(await call("list_files", { prefix: "src" })).toBe("src/app.ts\nsrc/config.ts\nsrc/lib/util.ts");
  expect(await call("list_files", { prefix: "./src/lib/" })).toBe("src/lib/util.ts");
  expect(await call("list_files", {})).toBe("docs/README.md\nlogo.png (left out: it's a binary file)\nslow.txt\nsrc/app.ts\nsrc/config.ts\nsrc/lib/util.ts");
  expect(await call("list_files", { prefix: "sr" })).toBe("No files under sr.");
  expect(await call("list_files", {}, { listChars: 10 })).toBe("docs/READM\n[cut at 10 characters]");
});

test("read_file reads a file's text (secrets masked), capped, and says why it can't", async () => {
  expect(await call("read_file", { path: "/src/lib/util.ts" })).toBe("export const EXPORT_LIMIT = 10;\n");
  expect(await call("read_file", { path: "src/app.ts" })).toContain("const token = '[secret]'");
  expect(await call("read_file", { path: "docs/README.md" }, { fileChars: 10 })).toBe("xxxxxxxxxx\n[cut at 10 characters]");
  expect(await call("read_file", { path: "logo.png" })).toBe("logo.png isn't readable here: it's a binary file.");
  expect(await call("read_file", { path: "src/missing.ts" })).toBe("There's no file at src/missing.ts in the repository.");
  expect(await call("read_file", { path: "../../etc/passwd" })).toBe("There's no file at ../../etc/passwd in the repository.");
  expect(await call("read_file", { path: "src/../../etc/passwd" })).toBe("There's no file at src/../../etc/passwd in the repository.");
});

test("search_code finds lines case-insensitively, capped, and answers an invalid or slow pattern", async () => {
  expect(await call("search_code", { pattern: "export_?(csv|limit)" })).toBe("src/app.ts:2: export function exportCsv() {}\nsrc/lib/util.ts:1: export const EXPORT_LIMIT = 10;");
  expect(await call("search_code", { pattern: "token" })).toBe("src/app.ts:3: const token = '[secret]';");
  // Masked before the line is cut, and before the pattern sees it.
  expect(await call("search_code", { pattern: "x{200}" })).toBe(`src/config.ts:1: ${"x".repeat(285)} "[secret]";`);
  expect(await call("search_code", { pattern: "sk-abc" })).toBe("No lines match sk-abc.");
  expect(await call("search_code", { pattern: "export" }, { searchLines: 1 })).toBe("src/app.ts:2: export function exportCsv() {}\n[more lines match; the first 1 are shown]");
  expect(await call("search_code", { pattern: "export" }, { searchChars: 8 })).toBe("src/app.\n[cut at 8 characters]");
  expect(await call("search_code", { pattern: "nothing-here" })).toBe("No lines match nothing-here.");
  expect(await call("search_code", { pattern: "(unclosed" })).toBe("Invalid pattern: Invalid regular expression: /(unclosed/i: Unterminated group");
  // Never finishes on slow.txt's line.
  expect(await call("search_code", { pattern: "^(a+)+$" }, { searchMs: 300 })).toBe("Search took too long; try a simpler pattern.");
});

test("bad arguments, an unknown tool and a missing repository come back as sentences, not throws", async () => {
  expect(await runTool(context(), { name: "read_file", arguments: "{not json" })).toBe("The arguments aren't JSON: {not json");
  expect(await call("read_file", {})).toMatch(/^Bad arguments for read_file: path: /);
  expect(await call("delete_file", { path: "a" })).toBe("There's no tool named delete_file.");
  for (const name of ["constructor", "toString", "__proto__"]) {
    expect(await call(name, {})).toBe(`There's no tool named ${name}.`);
  }
  expect(await runTool({ projectId: "unused", repository: { unavailable: "it's over 200 MB" } }, { name: "list_files", arguments: "{}" })).toBe(
    "The repository isn't available (it's over 200 MB); work from the diff.",
  );
});
