"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ImageField } from "@/components/branding-settings";
import { authClient } from "@/lib/auth-client";
import { setAvatar } from "@/server/media";

/** They only sign in with Google or GitHub (`via`): a note instead of changing the password, with a reset to set one when email goes out. */
type NoPassword = { via: string; reset: boolean };

/** `email`: their address (and whether it's verified), the profile's first row. */
export function AccountForms({ name, email, photo, noPassword }: { name: string; email: ReactNode; photo?: Photo; noPassword?: NoPassword }) {
  return (
    <>
      <ProfileForm name={name} email={email} photo={photo} />
      <PasswordForm noPassword={noPassword} />
    </>
  );
}

/** Their photo, and the project uploads go to (the one they had open; none: it can only be removed); without it, no photo field. */
type Photo = { projectSlug?: string; image: string | null; imageId: string | null; uploadsOff?: string };

/** The app's Account only: a portal's session can't change the account (lib/auth.ts), so the portal's shows the name. */
function ProfileForm({ name, email, photo }: { name: string; email: ReactNode; photo?: Photo }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string>();

  return (
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
      className="flex flex-col gap-3"
    >
      <SettingsCard title="Profile" description="Shown on your posts and comments.">
        <SettingRow label="Email" description={<span className="break-words">{email}</span>}>
          {null}
        </SettingRow>
        <SettingRow label="Name" htmlFor="account-name">
          <div className="flex flex-col gap-1.5 sm:w-72">
            <Input id="account-name" name="name" defaultValue={name} required maxLength={100} aria-invalid={error ? true : undefined} />
            {error && <FieldError>{error}</FieldError>}
          </div>
        </SettingRow>
        {photo && (
          <div className="px-4 py-3.5 @min-[34rem]/settings:px-5">
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
          </div>
        )}
      </SettingsCard>
      <Button type="submit" disabled={pending || uploading > 0} focusableWhenDisabled className="self-end">
        Save
      </Button>
    </form>
  );
}

function PasswordForm({ noPassword }: { noPassword?: NoPassword }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  if (noPassword) {
    return (
      <SettingsCard title="Password">
        <p className="px-4 py-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">
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
        </p>
      </SettingsCard>
    );
  }
  return (
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
      className="flex flex-col gap-3"
    >
      <SettingsCard title="Password" description="Changing it signs you out everywhere else.">
        <SettingRow label="Current password" htmlFor="current-password">
          <Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required className="sm:w-72" />
        </SettingRow>
        <SettingRow label="New password" htmlFor="new-password">
          <div className="flex flex-col gap-1.5 sm:w-72">
            <Input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={8} required aria-invalid={error ? true : undefined} />
            {error && <FieldError>{error}</FieldError>}
          </div>
        </SettingRow>
      </SettingsCard>
      {/* Outline: the page's one primary is Profile's Save. */}
      <Button type="submit" variant="outline" disabled={pending} focusableWhenDisabled className="self-end">
        Change password
      </Button>
    </form>
  );
}
