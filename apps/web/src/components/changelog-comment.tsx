"use client";

import type { Doc } from "@tuti/content";
import { useActionState, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { type EditorUploads, RichEditor } from "@/components/rich-editor";
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
  const [deleting, startDelete] = useTransition();
  const errorId = useId();
  const [state, save, saving] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await editChangelogComment(projectSlug, number, commentId, prev, formData);
    if (!result.error) {
      setEditing(false);
    }
    return result;
  }, {});

  if (editing) {
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
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="outline" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <>
      {children}
      {(canEdit || canDelete) && (
        <div className="flex items-center gap-4">
          {canEdit && (
            <button type="button" className={ACTION} aria-label="Edit your comment" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger
                render={<button type="button" className={ACTION} aria-label={canEdit ? "Delete your comment" : `Delete ${author}'s comment`} disabled={deleting} />}
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
                    onClick={() =>
                      startDelete(async () => {
                        const result = await deleteChangelogComment(projectSlug, number, commentId);
                        if (result.error) {
                          toast.error(result.error);
                        } else {
                          toast.success("Comment deleted");
                        }
                      })
                    }
                  >
                    Delete comment
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
