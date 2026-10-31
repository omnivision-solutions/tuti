import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type CreditsProps = {
  projectName: string;
  /** Out of credits (AI paused), rather than running low. */
  out: boolean;
  /** Credits left, as the app shows them (running low only). */
  left: string;
  /** The project's Settings → Billing. */
  url: string;
};

/** To a project's owners and admins: its AI credits are running low, or out (docs/plan.md, AI usage per project). */
export function CreditsEmail({ projectName, out, left, url }: CreditsProps) {
  return (
    <Layout preview={out ? `${projectName}'s AI is paused until it has more credits.` : `${projectName} has ${left} AI credits left.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        {out ? (
          <>
            <strong>{projectName}</strong> is out of AI credits, so AI answers, changelog drafts and Autopilot are paused
            until it has more. Nothing is lost: merged pull requests wait as Paused for you to resume them.
          </>
        ) : (
          <>
            <strong>{projectName}</strong> has {left} AI credits left. When they run out, AI answers, changelog drafts and code
            changes pause until it has more.
          </>
        )}
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        See Billing
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You get this as an owner or admin of {projectName}, once until the project gets more credits.
      </Text>
    </Layout>
  );
}

export const creditsEmail = (props: CreditsProps) => ({
  subject: props.out ? `${props.projectName} is out of AI credits` : `${props.projectName} is running low on AI credits`,
  body: <CreditsEmail {...props} />,
});
