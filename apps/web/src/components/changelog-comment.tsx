"use client";

import type { Doc } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";
import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { type EditorUploads, RichEditor } from "@/components/rich-editor";
import { COMMENTS_HEADING } from "@/lib/comment-threads";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import type { FormState } from "@/server/form-state";
import { deleteChangelogComment, editChangelogComment } from "@/server/changelog";

const ACTION = "inline-flex h-8 items-center rounded-lg px-1.5 -mx-1.5 text-sm font-medium text-muted-foreground hover:text-foreground";

/**
 * A comment on a changelog entry: its text (`children`), and under it Edit (its author's: the text becomes its editor)
 * and Delete (its author's, or the team's in the app).
 */
export function ChangelogComment({
  projectSlug,
  number,
  commentId,
  author,
  doc,
  canEdit,
  canDelete,
  mine = canEdit,
  uploads,
  mediaUrls,
  onEdit = (prev, formData) => editChangelogComment(projectSlug, number, commentId, prev, formData),
  onDelete = () => deleteChangelogComment(projectSlug, number, commentId),
  children,
}: {
  projectSlug: string;
  number: number;
  commentId: string;
  author: string;
  doc: Doc;
  canEdit: boolean;
  canDelete: boolean;
  /** Its author's (Delete says "your"); by default whoever may edit it. */
  mine?: boolean;
  uploads?: EditorUploads;
  /** Its images' signed URLs, for its editor when there are no `uploads`. */
  mediaUrls?: MediaUrls | null;
  /** Saves an edit, and deletes it (the widget's act for whoever the customer's page signed in); the portal's server actions by default. */
  onEdit?: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** `waiting`: refused before anything was sent (the widget, signing someone in): it's still there. */
  onDelete?: () => Promise<FormState & { waiting?: boolean }>;
  children: React.ReactNode;
}) {
  const t = useTranslations("changelog");
  const f = useTranslations("feedback");
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  // Saved or cancelled: back on Edit, where the keyboard was.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      editButton.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);
  const [deleting, startDelete] = useTransition();
  const router = useRouter();
  // Its Delete pressed for a comment that's gone: once the list drops it, the keyboard goes to the comments' heading.
  const gone = useRef(false);
  useEffect(
    () => () => {
      if (gone.current) {
        document.getElementById(COMMENTS_HEADING)?.focus();
      }
    },
    [],
  );

  if (editing) {
    return <EditForm save={onEdit} doc={doc} uploads={uploads} mediaUrls={mediaUrls} onDone={() => setEditing(false)} />;
  }
  return (
    <>
      {children}
      {(canEdit || canDelete) && (
        <div className="flex items-center gap-4">
          {canEdit && (
            <button ref={editButton} type="button" className={ACTION} aria-label={t("editYours")} onClick={() => setEditing(true)}>
              {t("edit")}
            </button>
          )}
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger
                render={<button type="button" className={ACTION} aria-label={mine ? t("deleteYours") : t("deleteTheirs", { name: author })} aria-disabled={deleting || undefined} />}
              >
                {t("delete")}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("deleteDescription")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{f("cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    // Once: a second press while it runs would find it gone.
                    disabled={deleting}
                    focusableWhenDisabled
                    onClick={() =>
                      startDelete(async () => {
                        const result = await onDelete();
                        if (result.error) {
                          toast.error(result.error);
                          // Deleted meanwhile (another tab, the team): the list as it is now, which takes this comment (and
                          // its Delete) away: the keyboard goes to the heading then, as below.
                          if (!result.waiting) {
                            gone.current = true;
                            router.refresh();
                          }
                        } else {
                          toast.success(t("deleted"));
                          document.getElementById(COMMENTS_HEADING)?.focus();
                        }
                      })
                    }
                  >
                    {deleting ? t("deleting") : t("deleteComment")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}
    </>
  );
}

/** Its author's editor for it, in place of its text; made afresh each time Edit opens it (no error from last time). */
function EditForm({
  save: send,
  doc,
  uploads,
  mediaUrls,
  onDone,
}: {
  save: (prev: FormState, formData: FormData) => Promise<FormState>;
  doc: Doc;
  uploads?: EditorUploads;
  mediaUrls?: MediaUrls | null;
  onDone: () => void;
}) {
  const t = useTranslations("changelog");
  const f = useTranslations("feedback");
  const errorId = useId();
  const [state, save, saving] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await send(prev, formData);
    if (!result.error) {
      onDone();
      toast.success(t("saved"));
    }
    return result;
  }, {});
  return (
    <form action={save} className="flex flex-col gap-2">
      <Field data-invalid={state.error ? true : undefined}>
        <RichEditor
          profile="comment"
          name="content"
          label={t("editYours")}
          initial={doc}
          uploads={uploads}
          mediaUrls={mediaUrls}
          invalid={!!state.error}
          describedBy={errorId}
          onCreate={(editor) => editor.commands.focus("end")}
        />
        {state.error && <FieldError id={errorId}>{state.error}</FieldError>}
      </Field>
      <div className="flex justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          {f("cancel")}
        </Button>
        <Button type="submit" variant="outline" disabled={saving}>
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </form>
  );
}
