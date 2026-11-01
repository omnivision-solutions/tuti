"use client";

import { PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { fileSize } from "@/components/inbox/message-attachments";
import { Button } from "@/components/ui/button";

/** Asks the server where to upload a file (the team's reply, the widget): the URL to PUT it to, the type it was signed with, and its id. */
export type StartUpload = (file: { filename: string; contentType: string; size: number }) => Promise<{ error: string } | { id: string; contentType: string; uploadUrl: string }>;

/** A file attached: `startedAt`, when its upload started (unsent, the server deletes it a day after). */
export type Upload = { key: string; name: string; size: number; startedAt: number; id?: string; error?: string };

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Files attached to a message being written: each uploads as it's picked, straight to the media
 * storage, and its id goes with the message once it's there. However an upload fails, the file says so.
 * `initial`: files uploaded already (a draft's, kept), attached as it starts.
 */
export function useUploads(start: StartUpload, initial: Upload[] = []) {
  const [uploads, setUploads] = useState<Upload[]>(initial);
  const update = (key: string, change: Partial<Upload>) => setUploads((current) => current.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const attach = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const key = crypto.randomUUID();
      setUploads((current) => [...current, { key, name: file.name, size: file.size, startedAt: Date.now() }]);
      if (file.size > MAX_FILE_BYTES) {
        update(key, { error: "Over 10 MB" });
        continue;
      }
      void (async () => {
        try {
          const started = await start({ filename: file.name, contentType: file.type || "application/octet-stream", size: file.size });
          if ("error" in started) {
            update(key, { error: started.error });
            return;
          }
          const put = await fetch(started.uploadUrl, { method: "PUT", body: file, headers: { "content-type": started.contentType } });
          update(key, put.ok ? { id: started.id } : { error: "Couldn't upload it" });
        } catch {
          update(key, { error: "Couldn't upload it" });
        }
      })();
    }
  };

  return {
    uploads,
    attach,
    remove: (key: string) => setUploads((current) => current.filter((u) => u.key !== key)),
    /** Once a message is sent: the files that went with it go, and any attached meanwhile stay. */
    sent: (ids: string[]) => setUploads((current) => current.filter((u) => !u.id || !ids.includes(u.id))),
    /** The uploaded files' ids, to send. */
    ids: uploads.flatMap((u) => (u.id ? [u.id] : [])),
    uploading: uploads.some((u) => !u.id && !u.error),
  };
}

/** The files to send, each with its size, "Uploading…" or why it failed, and a button to remove it. */
export function UploadList({ uploads, remove }: Pick<ReturnType<typeof useUploads>, "uploads" | "remove">) {
  if (uploads.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-1" aria-label="Files to send">
      {uploads.map((u) => (
        <li key={u.key} className="flex min-w-0 items-center gap-1.5 text-sm">
          <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{u.name}</span>
          <span className={u.error ? "shrink-0 text-xs text-destructive" : "shrink-0 text-xs text-muted-foreground"}>
            {u.error ?? (u.id ? fileSize(u.size) : "Uploading…")}
          </span>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${u.name}`} onClick={() => remove(u.key)}>
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** "Attach files": picks files for `attach`. */
export function AttachButton({ attach }: { attach: (files: FileList | null) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="Files to attach"
        onChange={(event) => {
          attach(event.target.files);
          event.target.value = "";
        }}
      />
      <Button type="button" variant="ghost" size="sm" onClick={() => picker.current?.click()}>
        <PaperclipIcon />
        Attach files
      </Button>
    </>
  );
}
