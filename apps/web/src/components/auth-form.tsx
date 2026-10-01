"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    setPending(true);
    setError(undefined);
    const { error } =
      mode === "sign-up"
        ? await authClient.signUp.email({ email, password, name: String(form.get("name")) })
        : await authClient.signIn.email({ email, password });
    setPending(false);

    if (error) {
      setError(error.message ?? "Something went wrong");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-3">
      <h1 className="text-2xl font-semibold">{mode === "sign-up" ? "Create an account" : "Sign in"}</h1>
      {mode === "sign-up" && <input name="name" placeholder="Name" required className="input" />}
      <input name="email" type="email" placeholder="Email" required className="input" />
      <input
        name="password"
        type="password"
        placeholder="Password"
        minLength={8}
        required
        className="input"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? "…" : mode === "sign-up" ? "Sign up" : "Sign in"}
      </button>
      <p className="text-sm text-zinc-500">
        {mode === "sign-up" ? (
          <>
            Have an account? <Link href="/sign-in" className="underline">Sign in</Link>
          </>
        ) : (
          <>
            New here? <Link href="/sign-up" className="underline">Create an account</Link>
          </>
        )}
      </p>
    </form>
  );
}
