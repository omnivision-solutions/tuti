"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function AccountForms({ name }: { name: string }) {
  return (
    <>
      <ProfileForm name={name} />
      <PasswordForm />
    </>
  );
}

function ProfileForm({ name }: { name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
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
              if (!error) {
                toast.success("Profile updated");
                router.refresh();
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
            <Button type="submit" disabled={pending} className="self-start">
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
