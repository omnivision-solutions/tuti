import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type VerifyAllProps = {
  projectName: string;
  /** How many articles it checked, of how many it set out to. */
  checked: number;
  total: number;
  /** The articles whose fix waits, by title. */
  fixed: string[];
  /** Why it stopped before the end (out of AI credits), or empty. */
  stopped: string;
  /** Autopilot, where the fixes wait. */
  url: string;
};

const articles = (count: number) => (count === 1 ? "1 article" : `${count} articles`);
const SHOWN = 10;

/** To a project's owners, once a Verify all ends with fixes: one email for the run, not one per article (docs/plan.md, V7). */
export function VerifyAllEmail({ projectName, checked, total, fixed, stopped, url }: VerifyAllProps) {
  return (
    <Layout preview={`${articles(fixed.length)} out of date, with fixes waiting for you.`} label="Autopilot">
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Verify all checked {checked === total ? articles(total) : `${checked} of ${articles(total)}`} in {projectName}&apos;s help center against your repository.{" "}
        {fixed.length === 1 ? "1 was out of date: its fix waits for you." : `${fixed.length} were out of date: their fixes wait for you.`}
      </Text>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        {fixed.slice(0, SHOWN).map((title, i) => (
          <span key={i}>
            {title}
            <br />
          </span>
        ))}
        {fixed.length > SHOWN && `and ${fixed.length - SHOWN} more`}
      </Text>
      {stopped && <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>{stopped}</Text>}
      <Button href={url} style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}>
        Review the fixes
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        Verify&apos;s fixes never go out by themselves. You get this as an owner of {projectName}.
      </Text>
    </Layout>
  );
}

export const verifyAllEmail = (props: VerifyAllProps) => ({
  subject: `Verify all: ${articles(props.fixed.length)} out of date`,
  fromName: "Tuti Autopilot",
  body: <VerifyAllEmail {...props} />,
});
