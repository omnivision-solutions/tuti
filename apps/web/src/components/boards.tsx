"use client";

import { cn } from "cn";
import { useActionState, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

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
import { keepingFields } from "@/lib/forms";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BOARD_TEXT_DEFAULTS, BOARD_TEXT_LIMITS, boardTexts } from "@/lib/board-texts";
import { createBoard, deleteBoard, updateBoard } from "@/server/boards";
import type { FormState } from "@/server/form-state";

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateBoardForm({ projectSlug }: { projectSlug: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await createBoard(projectSlug, prev, formData);
    if (!result.error) {
      formRef.current?.reset();
      setSlug("");
      setSlugEdited(false);
      toast.success("Board created");
    }
    return result;
  }, {});

  return (
    <form ref={formRef} {...keepingFields(action)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="board-name">Name</FieldLabel>
          <Input
            id="board-name"
            name="name"
            placeholder="Bug reports"
            required
            onChange={(e) => !slugEdited && setSlug(slugify(e.target.value))}
          />
        </Field>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="board-slug">URL</FieldLabel>
          <Input
            id="board-slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            required
            aria-invalid={state.error ? true : undefined}
          />
          <FieldDescription>On your portal at /feedback/{slug || "<url>"}.</FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="board-description">Description</FieldLabel>
          <Textarea id="board-description" name="description" rows={2} placeholder="Optional, shown on the board" />
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Creating…" : "Create board"}
        </Button>
      </FieldGroup>
    </form>
  );
}

type BoardFields = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  postButton: string | null;
  titlePlaceholder: string | null;
  detailsPlaceholder: string | null;
};

/** A board's settings: its name, address and description, and its words for posting, with a preview of them on the portal. */
export function EditBoardDialog({ projectSlug, board }: { projectSlug: string; board: BoardFields }) {
  const [open, setOpen] = useState(false);
  // What the preview shows, as it's typed.
  const [draft, setDraft] = useState({
    name: board.name,
    description: board.description ?? "",
    postButton: board.postButton ?? "",
    titlePlaceholder: board.titlePlaceholder ?? "",
    detailsPlaceholder: board.detailsPlaceholder ?? "",
  });
  const typed = (field: keyof typeof draft) => ({
    name: field,
    value: draft[field],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...draft, [field]: event.target.value }),
  });
  const [state, action, pending] = useActionState<FormState, FormData>(
    async (prev, formData) => {
      const result = await updateBoard(projectSlug, board.id, prev, formData);
      if (!result.error) {
        setOpen(false);
        toast.success("Board updated");
      }
      return result;
    },
    {},
  );
  const id = (field: string) => `${field}-${board.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl">
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>Edit board</DialogTitle>
            <DialogDescription>If you change the URL, links to the old one keep working.</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-6 md:grid-cols-2">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={id("name")}>Name</FieldLabel>
                <Input id={id("name")} {...typed("name")} required />
              </Field>
              <Field data-invalid={state.error ? true : undefined}>
                <FieldLabel htmlFor={id("slug")}>URL</FieldLabel>
                <Input id={id("slug")} name="slug" defaultValue={board.slug} required />
                <FieldDescription>On your portal at /feedback/&lt;url&gt;.</FieldDescription>
                {state.error && <FieldError>{state.error}</FieldError>}
              </Field>
              <Field>
                <FieldLabel htmlFor={id("description")}>Description</FieldLabel>
                <Textarea id={id("description")} {...typed("description")} rows={2} maxLength={280} placeholder="Optional, shown under the name" />
              </Field>
              <Field>
                <FieldLabel htmlFor={id("postButton")}>Button</FieldLabel>
                <Input
                  id={id("postButton")}
                  {...typed("postButton")}
                  maxLength={BOARD_TEXT_LIMITS.postButton}
                  placeholder={BOARD_TEXT_DEFAULTS.postButton}
                />
                <FieldDescription>Opens the form, e.g. Request a feature or Report a bug.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={id("titlePlaceholder")}>Title placeholder</FieldLabel>
                <Input
                  id={id("titlePlaceholder")}
                  {...typed("titlePlaceholder")}
                  maxLength={BOARD_TEXT_LIMITS.titlePlaceholder}
                  placeholder={BOARD_TEXT_DEFAULTS.titlePlaceholder}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={id("detailsPlaceholder")}>Details placeholder</FieldLabel>
                <Input
                  id={id("detailsPlaceholder")}
                  {...typed("detailsPlaceholder")}
                  maxLength={BOARD_TEXT_LIMITS.detailsPlaceholder}
                  placeholder={BOARD_TEXT_DEFAULTS.detailsPlaceholder}
                />
              </Field>
            </FieldGroup>
            <BoardPreview {...draft} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The board on the portal and its post form, with the words being edited (empty ones are the defaults). */
function BoardPreview(draft: { name: string; description: string; postButton: string; titlePlaceholder: string; detailsPlaceholder: string }) {
  const texts = boardTexts({
    postButton: draft.postButton.trim() || null,
    titlePlaceholder: draft.titlePlaceholder.trim() || null,
    detailsPlaceholder: draft.detailsPlaceholder.trim() || null,
  });
  return (
    <section aria-label="Preview" className="flex flex-col gap-4 rounded-lg bg-muted/60 p-4">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Preview</p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-heading text-xl font-bold tracking-tight break-words">{draft.name || "Board name"}</p>
          {draft.description.trim() && <p className="text-sm break-words text-muted-foreground">{draft.description}</p>}
        </div>
        <span className={buttonVariants({ size: "sm" })}>{texts.postButton}</span>
      </div>
      {/* The form the button opens. */}
      <div className="flex flex-col gap-3 rounded-xl bg-popover p-4 text-popover-foreground shadow-sm ring-1 ring-foreground/10">
        <p className="font-heading text-lg font-bold tracking-tight break-words text-muted-foreground/60">{texts.titlePlaceholder}</p>
        <p className="min-h-12 text-sm break-words text-muted-foreground">{texts.detailsPlaceholder}</p>
        <span className={cn(buttonVariants({ size: "sm" }), "self-end")}>Submit feedback</span>
      </div>
    </section>
  );
}

export function DeleteBoardButton({ projectSlug, boardId, name }: { projectSlug: string; boardId: string; name: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>The board is removed from your portal. It has no posts.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteBoard(projectSlug, boardId);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${name} deleted`);
                }
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
