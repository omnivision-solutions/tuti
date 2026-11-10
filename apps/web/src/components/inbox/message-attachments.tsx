import { fileSize } from "@tuti/content/media";
import { PaperclipIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A file's size the way people read it: 340 KB, 1.2 MB. */
export { fileSize };

type Attachment = { id: string; filename: string; size: number; image: boolean; url: string | null };

/**
 * What came with a message: images shown, other files to download; and what couldn't be kept (`imported`: from
 * another tool, for any reason: too big, unreachable, no media storage).
 */
export function MessageAttachments({ attachments, dropped, imported = false, cards = false }: { attachments: Attachment[]; dropped: number; imported?: boolean; cards?: boolean }) {
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
        <ul className={cn("flex flex-col gap-1", cards && "mt-2")} aria-label="Attachments">
          {files.map((file) => (
            <li key={file.id} className={cn("flex min-w-0 items-center gap-1.5 text-sm", cards && "grid min-w-55 grid-cols-[1.875rem_minmax(0,1fr)] gap-x-2.25 gap-y-0 rounded-[0.4375rem] bg-card/80 px-2.25 py-1.75 max-md:min-w-0")}>
              <PaperclipIcon className={cn("size-3.5 shrink-0 text-muted-foreground", cards && "row-span-2 row-start-1 h-8 w-7.5 rounded-[0.3125rem] bg-secondary p-1.75")} aria-hidden />
              {file.url ? (
                <a href={file.url} className={cn("min-w-0 truncate underline underline-offset-4", cards && "text-xs leading-5 font-[550] no-underline")} download={file.filename}>
                  {file.filename}
                </a>
              ) : (
                <span className="min-w-0 truncate">{file.filename}</span>
              )}
              <span className={cn("shrink-0 text-xs text-muted-foreground", cards && "col-start-2")}>{fileSize(file.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {dropped > 0 && (
        <p className="text-xs text-muted-foreground">
          {imported
            ? `${dropped === 1 ? "1 attachment wasn't" : `${dropped} attachments weren't`} brought across from Featurebase.`
            : `${dropped === 1 ? "1 attachment wasn't kept" : `${dropped} attachments weren't kept`}: this server has no file storage.`}
        </p>
      )}
    </div>
  );
}
