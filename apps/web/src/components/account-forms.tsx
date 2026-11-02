"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { usePortalAuthClient } from "@/components/portal-base";
import { ImageField } from "@/components/branding-settings";
import { authClient } from "@/lib/auth-client";
import { setAvatar } from "@/server/media";

export function AccountForms({ name, photo }: { name: string; photo?: Photo }) {
  return (
    <>
      <ProfileForm name={name} photo={photo} />
      <PasswordForm />
    </>
  );
}

/** Their photo, and the project uploads go to (the one they had open); without it, no photo field (the portal's Account). */
type Photo = { projectSlug: string; image: string | null; imageId: string | null };

export function ProfileForm({ name, photo }: { name: string; photo?: Photo }) {
  const authClient = usePortalAuthClient();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string>();

  return (
    <Card>
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
                description="A square image looks best. Without one, your initials show."
                image={photo.image ? { id: photo.imageId ?? "", url: photo.image } : null}
                onBusy={(delta) => setUploading((count) => count + delta)}
              />
            )}
            <Button type="submit" disabled={pending || uploading > 0} className="self-start">
              Save
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

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
            <Button type="submit" disabled={pending} className="self-start">
              Change password
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
