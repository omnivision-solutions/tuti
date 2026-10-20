"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

/** A form's submit button for server components' forms: disabled while the form's action runs. */
export function SubmitButton(props: Omit<React.ComponentProps<typeof Button>, "type">) {
  const { pending } = useFormStatus();
  return <Button type="submit" {...props} disabled={pending || props.disabled} />;
}
