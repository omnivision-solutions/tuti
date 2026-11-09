"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ImageField } from "@/components/branding-settings";
import { authClient } from "@/lib/auth-client";
import { setAvatar } from "@/server/media";

/** They only sign in with Google or GitHub (`via`): a note instead of changing the password, with a reset to set one when email goes out. */
type NoPassword = { via: string; reset: boolean };

export function AccountForms({ name, photo, noPassword }: { name: string; photo?: Photo; noPassword?: NoPassword }) {
  return (
    <>
      <ProfileForm name={name} photo={photo} />
      <PasswordForm noPassword={noPassword} />
    </>
  );
}

/** Their photo, and the project uploads go to (the one they had open; none: it can only be removed); without it, no photo field. */
type Photo = { projectSlug?: string; image: string | null; imageId: string | null; uploadsOff?: string };

/** The app's Account only: a portal's session can't change the account (lib/auth.ts), so the portal's shows the name. */
function ProfileForm({ name, photo }: { name: string; photo?: Photo }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string>();

  return (
    // One form by itself: the app's narrow column (AppShell).
    <Card data-narrow>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Shown on your posts and comments.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          {...keepingFields((form) =>
            startTransition(async () => {
              const { error } = await authClient.updateUser({ name: String(form.get("name")).trim() });
              setError(error?.message);
              if (error) {
                return;
              }
              // A new photo, or none: only when it changed (one that came from sign-in has no upload id, and stays unless removed).
              const chosen = String(form.get("photo") ?? "");
              const changed = photo && (photo.image ? chosen !== (photo.imageId ?? "") || !form.get("photoUrl") : chosen !== "");
              const picked = changed
                ? await setAvatar(chosen || null).catch(() => ({ error: "Couldn't reach Tuti. Try again." }))
                : {};
              router.refresh();
              if (picked.error) {
                toast.error(`Name saved; the photo wasn't: ${picked.error}`);
              } else {
                toast.success("Profile updated");
              }
            }),
          )}
        >
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="account-name">Name</FieldLabel>
              <Input id="account-name" name="name" defaultValue={name} required maxLength={100} />
              {error && <FieldError>{error}</FieldError>}
            </Field>
            {photo && (
              <ImageField
                // Afresh once a new photo is saved, so it previews the saved one.
                key={photo.image ?? ""}
                projectSlug={photo.projectSlug}
                name="photo"
                label="Photo"
                description={`${photo.uploadsOff ?? "A square image looks best."} Without one, your initials show.`}
                image={photo.image ? { id: photo.imageId ?? "", url: photo.image } : null}
                onBusy={(delta) => setUploading((count) => count + delta)}
              />
            )}
            <Button type="submit" disabled={pending || uploading > 0} focusableWhenDisabled className="self-start">
              Save
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordForm({ noPassword }: { noPassword?: NoPassword }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  if (noPassword) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            You sign in with {noPassword.via}.
            {noPassword.reset && (
              <>
                {" "}
                To use a password too,{" "}
                <Link href="/forgot-password" className="text-foreground underline underline-offset-4">
                  set one by email
                </Link>
                .
              </>
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs you out everywhere else.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action={(form) =>
            startTransition(async () => {
              const { error } = await authClient.changePassword({
                currentPassword: String(form.get("currentPassword")),
                newPassword: String(form.get("newPassword")),
                revokeOtherSessions: true,
              });
              setError(error?.message);
              if (!error) {
                toast.success("Password changed");
              }
            })
          }
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required />
            </Field>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={8} required />
              {error && <FieldError>{error}</FieldError>}
            </Field>
            {/* Outline: the page's one primary is Profile's Save. */}
            <Button type="submit" variant="outline" disabled={pending} className="self-start">
              Change password
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
