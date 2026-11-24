"use client";

import type { Doc } from "@tuti/content";
import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  uploads,
  children,
}: {
  projectSlug: string;
  number: number;
  commentId: string;
  author: string;
  doc: Doc;
  canEdit: boolean;
  canDelete: boolean;
  uploads?: EditorUploads;
  children: React.ReactNode;
}) {
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
    return <EditForm projectSlug={projectSlug} number={number} commentId={commentId} doc={doc} uploads={uploads} onDone={() => setEditing(false)} />;
  }
  return (
    <>
      {children}
      {(canEdit || canDelete) && (
        <div className="flex items-center gap-4">
          {canEdit && (
            <button ref={editButton} type="button" className={ACTION} aria-label="Edit your comment" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger
                render={<button type="button" className={ACTION} aria-label={canEdit ? "Delete your comment" : `Delete ${author}'s comment`} aria-disabled={deleting || undefined} />}
              >
                Delete
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
                  <AlertDialogDescription>It&apos;s gone for good, for everyone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    // Once: a second press while it runs would find it gone.
                    disabled={deleting}
                    focusableWhenDisabled
                    onClick={() =>
                      startDelete(async () => {
                        const result = await deleteChangelogComment(projectSlug, number, commentId);
                        if (result.error) {
                          toast.error(result.error);
                          // Deleted meanwhile (another tab, the team): the list as it is now, which takes this comment (and
                          // its Delete) away: the keyboard goes to the heading then, as below.
                          gone.current = true;
                          router.refresh();
                        } else {
                          toast.success("Comment deleted");
                          document.getElementById(COMMENTS_HEADING)?.focus();
                        }
                      })
                    }
                  >
                    {deleting ? "Deleting…" : "Delete comment"}
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
  projectSlug,
  number,
  commentId,
  doc,
  uploads,
  onDone,
}: {
  projectSlug: string;
  number: number;
  commentId: string;
  doc: Doc;
  uploads?: EditorUploads;
  onDone: () => void;
}) {
  const errorId = useId();
  const [state, save, saving] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await editChangelogComment(projectSlug, number, commentId, prev, formData);
    if (!result.error) {
      onDone();
      toast.success("Comment saved");
    }
    return result;
  }, {});
  return (
    <form action={save} className="flex flex-col gap-2">
      <Field data-invalid={state.error ? true : undefined}>
        <RichEditor
          profile="comment"
          name="content"
          label="Edit your comment"
          initial={doc}
          uploads={uploads}
          invalid={!!state.error}
          describedBy={errorId}
          onCreate={(editor) => editor.commands.focus("end")}
        />
        {state.error && <FieldError id={errorId}>{state.error}</FieldError>}
      </Field>
      <div className="flex justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="outline" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
