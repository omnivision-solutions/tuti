import { Text } from "@react-email/components";
import { CREDIT_FEATURES } from "@tuti/shared";

import { Buttons, Eyebrow, Layout, textStyle, Title } from "./layout";

type CreditsProps = {
  projectName: string;
  /** Out of credits (AI paused), rather than running low. */
  out: boolean;
  /** Credits left, as the app shows them (running low only). */
  left: string;
  /** The project's Settings → Billing. */
  url: string;
};

/** "120 credits left", "1 credit left" (`left` as the app shows it: "0.5" stays plural). */
const creditsLeft = (left: string) => `${left} ${left === "1" ? "credit" : "credits"} left`;

/** To a project's owners and admins: its credits are running low, or out (docs/plan.md, AI usage per project). */
export function CreditsEmail({ projectName, out, left, url }: CreditsProps) {
  return (
    <Layout
      label="Billing"
      preview={out ? `${projectName}'s AI is paused until it has more credits.` : `${projectName} has ${creditsLeft(left)}.`}
      footer={
        <>
          You get this as an owner or admin of {projectName}, once until the project gets more credits.
        </>
      }
    >
      <Eyebrow>{projectName} · Billing</Eyebrow>
      <Title>{out ? "Out of credits" : creditsLeft(left)}</Title>
      <Text style={textStyle}>
        {out ? (
          <>
            <strong>{projectName}</strong> is out of credits, so {CREDIT_FEATURES} are paused until it has
            more. Nothing is lost: merged pull requests wait as Paused for you to resume them.
          </>
        ) : (
          <>
            <strong>{projectName}</strong> has {creditsLeft(left)}. When they run out, {CREDIT_FEATURES} pause until it
            has more.
          </>
        )}
      </Text>
      <Buttons href={url} label="See Billing" />
    </Layout>
  );
}

export const creditsEmail = (props: CreditsProps) => ({
  subject: props.out ? `${props.projectName} is out of credits` : `${props.projectName} is running low on credits`,
  body: <CreditsEmail {...props} />,
});
