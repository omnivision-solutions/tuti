"use client";

import { UploadIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { initials } from "@/components/app-sidebar";
import { useImageUpload } from "@/components/branding-settings";
import { useCustomizeForm } from "@/components/customize-shell";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { keepingFields } from "@/lib/forms";
import { setAvatar } from "@/server/media";

/** They only sign in with Google or GitHub (`via`): a note instead of changing the password, with a reset to set one when email goes out. */
type NoPassword = { via: string; reset: boolean };

/** Their photo, and the project uploads go to (the one they had open; none: it can only be removed); without it, no photo row. */
type Photo = { projectSlug?: string; image: string | null; imageId: string | null; uploadsOff?: string };

/**
 * The app's Account → Profile: photo, name, address (`email`, and whether it's verified) and password as rows of one
 * card. The photo and the name are saved by the page's "Save changes"; the password is changed in a dialog.
 */
export function AccountForms({ name, email, photo, noPassword }: { name: string; email: ReactNode; photo?: Photo; noPassword?: NoPassword }) {
  const [changing, setChanging] = useState(false);
  return (
    <>
      <ProfileForm
        name={name}
        email={email}
        photo={photo}
        noPassword={noPassword}
        onChangePassword={() => setChanging(true)}
      />
      {/* Beside the profile's form, not in it: its own form's submit isn't the profile's. */}
      {!noPassword && <ChangePasswordDialog open={changing} onOpenChange={setChanging} />}
    </>
  );
}

/** The app's Account only: a portal's session can't change the account (lib/auth.ts), so the portal's shows the name. */
function ProfileForm({
  name,
  email,
  photo,
  noPassword,
  onChangePassword,
}: {
  name: string;
  email: ReactNode;
  photo?: Photo;
  noPassword?: NoPassword;
  onChangePassword: () => void;
}) {
  const router = useRouter();
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string>();
  // The photo's row as the page was opened: it stays through a save (what the form holds is then what was saved, so
  // nothing typed meanwhile is lost), also once its photo is removed for someone who can't upload another.
  const [row] = useState(photo);
  // The photo this form last saved (as it opened, then each one it saved): a change is against it, not against what a
  // refresh brings, so a photo saved elsewhere isn't put back to this tab's by a name-only save.
  const saved = useRef(row && { image: row.image, imageId: row.imageId });
  const { form } = useCustomizeForm({
    busy: uploading > 0,
    save: async (_, data) => {
      const { error } = await authClient.updateUser({ name: String(data.get("name")).trim() });
      setError(error?.message);
      if (error) {
        return { error: error.message ?? "Not saved" };
      }
      // A new photo, or none: only when it changed (one that came from sign-in has no upload id, and stays unless removed).
      const chosen = String(data.get("photo") ?? "");
      const last = saved.current;
      const changed = last && (last.image ? chosen !== (last.imageId ?? "") || !data.get("photoUrl") : chosen !== "");
      const picked = changed ? await setAvatar(chosen || null).catch(() => ({ error: "Couldn't reach Tuti. Try again." })) : {};
      if (changed && !picked.error) {
        saved.current = { image: String(data.get("photoUrl") ?? "") || null, imageId: chosen || null };
      }
      router.refresh();
      if (picked.error) {
        toast.error(`Name saved; the photo wasn't: ${picked.error}`);
      } else {
        toast.success("Profile updated");
      }
      // A photo that wasn't saved is still a change to save.
      return { error: picked.error };
    },
  });

  return (
    <form
      {...form}
      onSubmit={(event) => {
        // Enter in Name while a photo uploads: not saved yet (Save is off till then too), or the photo would be left out.
        if (uploading > 0) {
          event.preventDefault();
          return;
        }
        form.onSubmit(event);
      }}
    >
      <SettingsCard title="Profile">
        {row && <PhotoRow name={name} photo={row} onBusy={(delta) => setUploading((count) => count + delta)} />}
        <SettingRow label="Name" htmlFor="account-name">
          <div className="flex flex-col gap-1.5 @min-[34rem]/settings:w-72">
            <Input id="account-name" name="name" defaultValue={name} required maxLength={100} aria-invalid={error ? true : undefined} />
            {error && <FieldError>{error}</FieldError>}
          </div>
        </SettingRow>
        <SettingRow label="Email">
          <p className="max-w-[24rem] min-w-0 break-words text-muted-foreground @min-[34rem]/settings:text-right">{email}</p>
        </SettingRow>
        {noPassword ? (
          <SettingRow
            label="Password"
            description={
              <>
                You sign in with {noPassword.via}.
                {noPassword.reset && (
                  <>
                    {" "}
                    To use a password too,{" "}
                    <Link href="/app/auth/forgot-password" className="text-foreground underline underline-offset-4">
                      set one by email
                    </Link>
                    .
                  </>
                )}
              </>
            }
          >
            {null}
          </SettingRow>
        ) : (
          <SettingRow label="Password" inline>
            <Button type="button" variant="outline" size="sm" onClick={onChangePassword}>
              Change password
            </Button>
          </SettingRow>
        )}
      </SettingsCard>
    </form>
  );
}

/**
 * The photo as a row, as SEO's share image is: the photo (their initials without one), "Upload" (the row takes a
 * dropped image too), and once there is one a button that removes it. Why Upload is off (`uploadsOff`) is the row's
 * line and the button's description; what went wrong with a file shows under the row.
 */
function PhotoRow({ name, photo, onBusy }: { name: string; photo: Photo; onBusy: (delta: number) => void }) {
  const id = useId();
  const uploadButton = useRef<HTMLButtonElement>(null);
  const { image, setImage, uploading, error, dragging, drop, inputs, pick } = useImageUpload({
    projectSlug: photo.projectSlug,
    name: "photo",
    id,
    image: photo.image ? { id: photo.imageId ?? "", url: photo.image } : null,
    onBusy,
  });

  return (
    <div {...drop} className={cn("transition-colors", dragging && "bg-soft")}>
      <SettingRow label="Photo" description={photo.uploadsOff} htmlFor={id} inline>
        <Avatar className="size-9">
          {image && <AvatarImage src={image.url} alt="Photo preview" />}
          <AvatarFallback aria-hidden>{initials(name)}</AvatarFallback>
        </Avatar>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Upload photo"
          // Why it's off, when it is, read with the button.
          aria-describedby={photo.uploadsOff ? `${id}-description` : undefined}
          // Off while one uploads (or without a project to upload into), yet focusable (aria-disabled): focus stays here through the upload, "Uploading…" read below.
          disabled={uploading || !photo.projectSlug}
          focusableWhenDisabled
          ref={uploadButton}
          onClick={pick}
        >
          <UploadIcon />
          {/* The icon alone where the row has no room for the word. */}
          <span className={image ? "@max-[20rem]/settings:sr-only" : undefined}>Upload</span>
        </Button>
        {image && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove photo"
            title="Remove"
            // Off while one uploads (its image would come back after), focusable all the same.
            disabled={uploading}
            focusableWhenDisabled
            onClick={() => {
              // Remove goes with the image: focus moves to Upload, not out of the row.
              uploadButton.current?.focus();
              setImage(null);
            }}
          >
            <XIcon />
          </Button>
        )}
        {inputs}
      </SettingRow>
      {uploading && (
        <p role="status" className="px-4 pb-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">
          Uploading…
        </p>
      )}
      {error && <FieldError className="px-4 pb-3.5 @min-[34rem]/settings:px-5">{error}</FieldError>}
    </div>
  );
}

/**
 * Profile's "Change password": the current and the new password in a dialog. It stays open (with what was typed) when
 * the change is refused, can't be closed while the change is on its way, and closes once it's made.
 */
function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [pending, startTransition] = useTransition();
  // What was refused, and the field it's about: the current password when that's not it, else the new one.
  const [error, setError] = useState<{ message?: string; field: "current" | "new" }>();
  const current = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) {
          return;
        }
        setError(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent initialFocus={current} className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Changing it signs you out everywhere else.</DialogDescription>
        </DialogHeader>
        <form
          {...keepingFields((form) =>
            startTransition(async () => {
              const { error } = await authClient.changePassword({
                currentPassword: String(form.get("currentPassword")),
                newPassword: String(form.get("newPassword")),
                revokeOtherSessions: true,
              });
              setError(error ? { message: error.message, field: error.code === "INVALID_PASSWORD" ? "current" : "new" } : undefined);
              if (!error) {
                toast.success("Password changed");
                onOpenChange(false);
              }
            }),
          )}
          className="flex flex-col gap-4"
        >
          <FieldGroup>
            <Field data-invalid={error?.field === "current" ? true : undefined}>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input
                ref={current}
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={error?.field === "current" ? true : undefined}
                aria-describedby={error?.field === "current" ? "change-password-error" : undefined}
              />
              {error?.field === "current" && <FieldError id="change-password-error">{error.message}</FieldError>}
            </Field>
            <Field data-invalid={error?.field === "new" ? true : undefined}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                aria-invalid={error?.field === "new" ? true : undefined}
                aria-describedby={error?.field === "new" ? "change-password-error" : undefined}
              />
              {error?.field === "new" && <FieldError id="change-password-error">{error.message}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} focusableWhenDisabled />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending} focusableWhenDisabled>
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
