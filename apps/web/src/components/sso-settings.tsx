"use client";

import { useState, useTransition } from "react";

import { disableSso, rotateSsoSecret } from "@/server/sso-settings";

export function SsoSettings({
  workspaceSlug,
  enabled,
  ssoUrl,
}: {
  workspaceSlug: string;
  enabled: boolean;
  ssoUrl: string;
}) {
  const [pending, startTransition] = useTransition();
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();

  const rotate = () => {
    if (enabled && !confirm("Rotate the secret? Tokens signed with the old secret stop working immediately.")) {
      return;
    }
    startTransition(async () => {
      const result = await rotateSsoSecret(workspaceSlug);
      setError(result.error);
      setSecret(result.secret);
    });
  };

  const disable = () => {
    if (!confirm("Disable single sign-on? Your app's sign-in links stop working immediately.")) {
      return;
    }
    startTransition(async () => {
      const result = await disableSso(workspaceSlug);
      setError(result.error);
      setSecret(undefined);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Status:{" "}
        <span className={enabled ? "font-medium text-green-600" : "font-medium text-zinc-500"}>
          {enabled ? "Enabled" : "Disabled"}
        </span>
      </p>

      {secret && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
          <p className="font-medium">Copy your SSO secret now. It won&apos;t be shown again.</p>
          <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-black">{secret}</code>
          <p className="text-zinc-500">Store it on your server only (e.g. as TUTI_SSO_SECRET). Never send it to the browser.</p>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={rotate} disabled={pending} className="btn-primary">
          {enabled ? "Rotate secret" : "Enable SSO"}
        </button>
        {enabled && (
          <button
            type="button"
            onClick={disable}
            disabled={pending}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
          >
            Disable
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">How to sign users in from your app</p>
        <p className="text-zinc-500">
          On your server, sign a short-lived token for the logged-in user and redirect them to{" "}
          <code>{ssoUrl}</code>. Example with Node and <code>jose</code>:
        </p>
        <pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {`import { SignJWT } from "jose";

const token = await new SignJWT({
  email: user.email,      // optional
  name: user.name,        // optional, shown on posts
  avatar: user.avatarUrl, // optional, https URL
})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(String(user.id)) // your user id; this is how we match users
  .setJti(crypto.randomUUID()) // each token works once
  .setIssuedAt()
  .setExpirationTime("5m")     // 10 minutes max
  .sign(new TextEncoder().encode(process.env.TUTI_SSO_SECRET));

redirect(\`${ssoUrl}?token=\${token}&redirect=/${workspaceSlug}\`);`}
        </pre>
      </div>
    </div>
  );
}
