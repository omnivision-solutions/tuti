"use client";

import { CircleCheckIcon } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { confirmSupportEmail, saveSupportEmail } from "@/server/assistant";
import type { FormState } from "@/server/form-state";

/**
 * The support email in Settings → Support → Ask a person (see assistant.update): where "Ask a person" sends
 * questions, once the address has confirmed the link we email it. Off while empty.
 */
export function SupportEmailSettings({ projectSlug, active, pending }: { projectSlug: string; active: string | null; pending: string | null }) {
  const [state, action, saving] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveSupportEmail(projectSlug, prev, formData);
    if (!result.error) {
      const address = String(formData.get("supportEmail") ?? "").trim();
      toast.success(address ? "Support email saved" : "Ask a person turned off");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)} className="flex flex-col gap-3 border-t pt-6">
      <Field>
        <FieldLabel htmlFor="support-email">Support email</FieldLabel>
        <FieldDescription>
          Turns on “Ask a person” when the AI can&apos;t help: we email the question, the AI&apos;s answer and a short summary
          to this address, and replies go straight to the person who asked. We send it a link to confirm first. Leave it empty
          to turn it off.
        </FieldDescription>
        <Input id="support-email" name="supportEmail" type="email" defaultValue={pending ?? active ?? ""} maxLength={320} autoComplete="off" />
      </Field>
      {(active || pending) && (
        <p className="text-sm break-words text-muted-foreground">
          {active ? `Questions go to ${active}.` : "Ask a person is off."}
          {pending && ` Waiting for ${pending} to confirm: open the link we emailed it.`}
        </p>
      )}
      {state.error && <FieldError>{state.error}</FieldError>}
      <Button type="submit" variant="outline" disabled={saving} className="self-end">
        {saving ? "Saving…" : pending ? "Send the link again" : "Save support email"}
      </Button>
    </form>
  );
}

/** The page a support email confirmation link opens: confirming takes a click, so mail scanners that open links can't. */
export function ConfirmSupportEmail({ token, address, projectName }: { token: string; address: string; projectName: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof confirmSupportEmail>>>();
  const [pending, startTransition] = useTransition();

  if (result && "address" in result) {
    return (
      <Alert className="mx-auto max-w-sm">
        <CircleCheckIcon />
        <AlertDescription className="break-words">
          Confirmed. Questions from {result.projectName}&apos;s docs that the AI can&apos;t answer now come to {result.address}.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>Confirm the support email</CardTitle>
        <CardDescription className="break-words">
          Send questions from {projectName}&apos;s docs that the AI can&apos;t answer to {address}?
        </CardDescription>
      </CardHeader>
      <CardFooter className="mt-6 flex flex-col gap-3">
        {result && <FieldError>{result.error}</FieldError>}
        <Button className="w-full" disabled={pending} onClick={() => startTransition(async () => setResult(await confirmSupportEmail(token)))}>
          {pending ? "Confirming…" : "Confirm"}
        </Button>
      </CardFooter>
    </Card>
  );
}
