import { PaperclipIcon } from "lucide-react";

/** A file's size the way people read it: 340 KB, 1.2 MB. */
export function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Attachment = { id: string; filename: string; size: number; image: boolean; url: string | null };

/** What came with a message: images shown, other files to download; and what couldn't be kept. */
export function MessageAttachments({ attachments, dropped }: { attachments: Attachment[]; dropped: number }) {
  if (attachments.length === 0 && dropped === 0) {
    return null;
  }
  const images = attachments.filter((a) => a.image && a.url);
  const files = attachments.filter((a) => !a.image || !a.url);
  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((image) => (
            <a key={image.id} href={image.url!} target="_blank" rel="noreferrer" title={image.filename}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage, not an optimisable asset */}
              <img src={image.url!} alt={image.filename} className="max-h-48 max-w-full rounded-md border object-contain" />
            </a>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Attachments">
          {files.map((file) => (
            <li key={file.id} className="flex min-w-0 items-center gap-1.5 text-sm">
              <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {file.url ? (
                <a href={file.url} className="min-w-0 truncate underline underline-offset-4" download={file.filename}>
                  {file.filename}
                </a>
              ) : (
                <span className="min-w-0 truncate">{file.filename}</span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">{fileSize(file.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {dropped > 0 && (
        <p className="text-xs text-muted-foreground">
          {dropped === 1 ? "1 attachment wasn't kept" : `${dropped} attachments weren't kept`}: this server has no file storage.
        </p>
      )}
    </div>
  );
}
