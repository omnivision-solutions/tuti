import { type FormEvent, startTransition } from "react";

/**
 * A form's `action` and `onSubmit`, spread on the form: it runs `action` without React's reset of
 * the form afterwards (which `<form action>` alone does even when the save is refused), so a
 * rejected save keeps what was typed. Forms that should clear after a success do it themselves
 * (a `reset()` or a new `key`).
 *
 * `action` stays on the form for submits before hydration: React renders a guard for a client
 * function, or a working POST for a Server Function, instead of the browser's GET with the fields
 * in the URL. Once hydrated, `onSubmit` prevents the default and React leaves `action` alone.
 */
export const keepingFields = (action: (formData: FormData) => void) => ({
  action,
  onSubmit: (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    startTransition(() => action(formData));
  },
});
