import { pipeline, Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

import type { GithubApi } from "./github-api";
import { leftOut } from "./pull-request";

/**
 * A repository at a commit, for the docs agent's tools: its text files by path, held in memory (nothing to clean up, and
 * no path can reach the disk), and the files left out with why.
 */
export type Repository = { files: Map<string, string>; skipped: Map<string, string> };

/** Unpacked, the archive's limit (bigger: the agent works from the diff) and each file's (bigger: left out). */
export const REPOSITORY_LIMITS = { archiveBytes: 200_000_000, fileBytes: 1_000_000 };

/** How much of a file's start is looked at for a NUL byte, as git does to tell a binary. */
const BINARY_SNIFF = 8_000;

/**
 * The repository at a commit, from its archive through the GitHub App (`/tarball/<sha>`, which redirects to codeload).
 * Without it (too big, or the download failed) says why, so the agent can work from the diff and the help center.
 */
export async function readRepository(
  api: GithubApi,
  repo: string,
  sha: string,
  limits: Partial<typeof REPOSITORY_LIMITS> = {},
): Promise<Repository | { unavailable: string }> {
  const { archiveBytes, fileBytes } = { ...REPOSITORY_LIMITS, ...limits };
  const abort = new AbortController();
  try {
    const response = await api.download(`/repos/${repo}/tarball/${encodeURIComponent(sha)}`, abort.signal);
    let unpacked = 0;
    // Errors reach the loop below through the last stream (the callback only keeps them from going unhandled).
    const tar = pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createGunzip(), () => {});
    const files = new Map<string, string>();
    const skipped = new Map<string, string>();
    for await (const entry of tarEntries(tar, fileBytes, (bytes) => (unpacked += bytes) > archiveBytes)) {
      // GitHub puts everything in one folder (<owner>-<repo>-<sha>/).
      const path = entry.path.slice(entry.path.indexOf("/") + 1);
      if (!path) {
        continue;
      }
      const why = leftOut(path);
      if (why) {
        skipped.set(path, why === "secrets" ? "it may hold secrets" : `it's a ${why} file`);
      } else if (!entry.data) {
        skipped.set(path, `it's over ${fileBytes.toLocaleString("en")} bytes`);
      } else if (entry.data.subarray(0, BINARY_SNIFF).includes(0)) {
        skipped.set(path, "it's a binary file");
      } else {
        files.set(path, entry.data.toString("utf8"));
      }
    }
    if (unpacked > archiveBytes) {
      return { unavailable: `The repository is over ${archiveBytes / 1e6} MB unpacked` };
    }
    return { files, skipped };
  } catch (error) {
    return { unavailable: `The repository couldn't be downloaded: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    abort.abort();
  }
}

const BLOCK = 512;

/**
 * A tar archive's regular files (ustar, with pax extended headers for long paths, as `git archive` writes them), as they
 * stream in: each file's data, or null for one over `fileBytes` (not held). `over` hears each block read and stops it
 * when it says so.
 */
export async function* tarEntries(
  stream: AsyncIterable<Buffer>,
  fileBytes: number,
  over: (bytes: number) => boolean,
): AsyncGenerator<{ path: string; data: Buffer | null }> {
  const chunks = stream[Symbol.asyncIterator]();
  try {
    yield* entries(chunks, fileBytes, over);
  } finally {
    // Stops the download too, when it ends early.
    await chunks.return?.();
  }
}

async function* entries(
  chunks: AsyncIterator<Buffer>,
  fileBytes: number,
  over: (bytes: number) => boolean,
): AsyncGenerator<{ path: string; data: Buffer | null }> {
  let pending: Buffer = Buffer.alloc(0);
  let stopped = false;
  // The next n bytes, kept or only skipped; null at the end of the stream.
  const take = async (n: number, keep: boolean): Promise<Buffer | null> => {
    const parts: Buffer[] = [];
    for (let got = 0; got < n; ) {
      if (pending.length === 0) {
        const next = await chunks.next();
        if (next.done) {
          if (got === 0) {
            return null;
          }
          throw new Error("the archive ended early");
        }
        pending = next.value;
      }
      const part = pending.subarray(0, n - got);
      pending = pending.subarray(part.length);
      got += part.length;
      if (keep) {
        parts.push(part);
      }
      if (over(part.length)) {
        stopped = true;
        return null;
      }
    }
    return Buffer.concat(parts);
  };
  const text = (block: Buffer, start: number, length: number) => {
    const field = block.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? length : end).toString("utf8");
  };
  // Stopped by `over`, or the archive is cut short.
  const ended = () => {
    if (!stopped) {
      throw new Error("the archive ended early");
    }
  };
  let pax: Record<string, string> = {};
  for (;;) {
    const header = await take(BLOCK, true);
    // Two zero blocks end the archive; a stream that stops before them was cut short.
    if (!header) {
      return ended();
    }
    if (header.every((byte) => byte === 0)) {
      return;
    }
    const type = String.fromCharCode(header[156]!);
    const prefix = text(header, 345, 155);
    const name = text(header, 0, 100);
    const size = Number(pax.size ?? parseInt(text(header, 124, 12).trim() || "0", 8));
    const path = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    pax = {};
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      const records = await take(padded, true);
      if (!records) {
        return ended();
      }
      pax = paxRecords(records.subarray(0, size));
      continue;
    }
    // A regular file; anything else (folders, links, the global header) is skipped.
    const keep = (type === "0" || type === "\0") && size <= fileBytes;
    const data = await take(padded, keep);
    if (!data && padded > 0) {
      return ended();
    }
    if (type === "0" || type === "\0") {
      yield { path, data: keep ? data!.subarray(0, size) : null };
    }
  }
}

/** A pax extended header's records: "<length> <key>=<value>\n", the length counting the whole record. */
function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  for (let at = 0; at < data.length; ) {
    const space = data.indexOf(0x20, at);
    const length = parseInt(data.subarray(at, space).toString(), 10);
    if (space === -1 || !(length > 0)) {
      break;
    }
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}
