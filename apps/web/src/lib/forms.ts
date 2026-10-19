import { type FormEvent, startTransition } from "react";

/**
 * A form's onSubmit that runs `action` without React's reset of the form afterwards (which
 * `<form action>` does even when the save is refused), so a rejected save keeps what was typed.
 * Forms that should clear after a success do it themselves (a `reset()` or a new `key`).
 */
export const keepingFields = (action: (formData: FormData) => void) => (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
  startTransition(() => action(formData));
};
