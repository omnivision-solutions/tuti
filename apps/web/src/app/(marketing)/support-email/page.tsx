import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { ConfirmSupportEmail } from "@/components/support-email";
import { pendingSupportEmail } from "@/server/operations/assistant";

export const metadata: Metadata = { title: "Confirm the support email", robots: { index: false } };

/** tuti.so/support-email?token=… is the link in a support email confirmation (Settings → AI answers). Opening it changes nothing. */
export default async function SupportEmailPage(props: PageProps<"/support-email">) {
  const { token } = await props.searchParams;
  const project = typeof token === "string" ? await pendingSupportEmail(token) : null;
  if (!project?.supportEmailPending) {
    return (
      <EmptyState
        title="This link doesn't work any more"
        description="It was used, or a newer one was sent. Ask the team to send a new one from Settings → AI answers."
      />
    );
  }
  return <ConfirmSupportEmail token={token as string} address={project.supportEmailPending} projectName={project.name} />;
}
