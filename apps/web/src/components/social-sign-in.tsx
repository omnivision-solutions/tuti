"use client";

import { useState } from "react";

import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { FieldSeparator } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";
import { SOCIAL_PROVIDER_NAMES, type SocialProvider } from "@/lib/social-sign-in";

/** Google's "G", in its colours, as its sign-in branding asks. */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// Each in its own colours: Google's G on a light button, GitHub's mark on GitHub's dark grey.
const LOOK: Record<SocialProvider, { icon: React.ReactNode; variant: "outline" | "default"; className?: string }> = {
  google: { icon: <GoogleG className="size-4" />, variant: "outline" },
  github: {
    icon: <GithubMark className="size-4" />,
    variant: "default",
    className: "border-[#24292f] bg-[#24292f] text-white inset-shadow-none hover:bg-[#32383f]",
  },
};

/** "Continue with Google / GitHub" above the email form; a failure comes back to this page with `?error=` and `via`. */
export function SocialSignIn({ providers, next }: { providers: SocialProvider[]; next: string }) {
  const [pending, setPending] = useState<SocialProvider>();
  if (!providers.length) {
    return null;
  }

  async function start(provider: SocialProvider) {
    setPending(provider);
    const back = new URL(window.location.href);
    back.searchParams.delete("error");
    back.searchParams.set("via", provider);
    const { error } = await authClient.signIn.social({ provider, callbackURL: next, errorCallbackURL: `${back.pathname}${back.search}` });
    // On success the browser is on its way to the provider.
    if (error) {
      setPending(undefined);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {providers.map((provider) => (
          <Button
            key={provider}
            type="button"
            size="lg"
            variant={LOOK[provider].variant}
            className={`w-full ${LOOK[provider].className ?? ""}`}
            disabled={!!pending}
            onClick={() => start(provider)}
          >
            {LOOK[provider].icon}
            Continue with {SOCIAL_PROVIDER_NAMES[provider]}
          </Button>
        ))}
      </div>
      <FieldSeparator className="my-4 *:data-[slot=field-separator-content]:bg-card">or</FieldSeparator>
    </>
  );
}
