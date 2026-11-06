import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(new URL("./claude-hub.sh", import.meta.url));

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const run = (args: string[], env: Record<string, string> = {}) => {
  const { PATH, HOME } = process.env;
  return spawnSync("bash", [script, ...args], { env: { PATH, HOME, ...env }, encoding: "utf8" });
};
const names = (url: string) => run(["names"], { CLIPROXY_URL: url }).stdout.split("\n").filter(Boolean);

const file = (text: string) => {
  const directory = mkdtempSync(join(tmpdir(), "claude-hub-"));
  directories.push(directory);
  const path = join(directory, "out");
  writeFileSync(path, text);
  return path;
};
const secrets = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-example",
  CLIPROXY_API_KEY: "sk-cpa-ci-example",
  CLIPROXY_URL: "https://hub-host.example-net.ts.net:8317",
};
const check = (paths: string[], env: Record<string, string> = secrets) => run(["check", ...paths], env).status;

test("a full name gives the host and its network's name", () => {
  expect(names(secrets.CLIPROXY_URL)).toEqual(["hub-host.example-net.ts.net", "example-net.ts.net"]);
  expect(names("https://user@hub-host.example-net.ts.net/v1")).toEqual(["hub-host.example-net.ts.net", "example-net.ts.net"]);
});

test("a short name gives nothing: it would match ordinary words", () => {
  expect(names("http://hub:8317")).toEqual([]);
  expect(names("")).toEqual([]);
});

test("an IP address gives the whole address, never a part of it", () => {
  expect(names("http://100.101.5.7:8317")).toEqual(["100.101.5.7"]);
  expect(names("http://[fd7a:115c:a1e0::1]:8317")).toEqual(["fd7a:115c:a1e0::1"]);
});

test("clean text passes", () => {
  expect(check([file("Bumped next; see the GitHub hub docs.")])).toBe(0);
});

test("a credential or the hub's address, in any case, fails", () => {
  for (const leak of ["sk-ant-oat-example", "SK-CPA-CI-EXAMPLE", "HUB-HOST.example-net.ts.net", "example-net.TS.NET"]) {
    expect(check([file("clean"), file(`text ${leak} text`)]), leak).toBe(1);
  }
  const ipv6 = { ...secrets, CLIPROXY_URL: "http://[fd7a:115c:a1e0::1]:8317" };
  expect(check([file("at FD7A:115C:A1E0::1")], ipv6)).toBe(1);
});

test("a missing file fails", () => {
  expect(check([join(tmpdir(), "claude-hub-missing")])).toBe(1);
});

test("an empty value doesn't match everything, and no values at all passes", () => {
  expect(check([file("anything")], { CLIPROXY_API_KEY: "sk-cpa-ci-example" })).toBe(0);
  expect(check([file("anything")], {})).toBe(0);
});

test("check needs a file", () => {
  expect(run(["check"], secrets).status).not.toBe(0);
});
