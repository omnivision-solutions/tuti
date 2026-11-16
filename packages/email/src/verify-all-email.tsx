import { Text } from "@react-email/components";

import { Buttons, colors, Eyebrow, Layout, Note, Stats, textStyle, Title } from "./layout";

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
    <Layout
      preview={`${articles(fixed.length)} out of date, with fixes waiting for you.`}
      label="Verify"
      footer={
        <>
          Verify&apos;s fixes never go out by themselves. You get this as an owner of {projectName}.
        </>
      }
    >
      <Eyebrow>Help center · Verify</Eyebrow>
      <Title>
        {checked === total ? articles(total) : `${checked} of ${articles(total)}`} checked, {fixed.length === 1 ? "1 needs a fix" : `${fixed.length} need a fix`}
      </Title>
      <Text style={textStyle}>
        Verify all checked {projectName}&apos;s help center against your repository.{" "}
        {fixed.length === 1 ? "Its fix waits for you." : "Their fixes wait for you."}
      </Text>
      <Stats
        items={[
          { n: checked, label: "checked" },
          ...(checked < total ? [{ n: total - checked, label: "not checked" }] : []),
          { n: fixed.length, label: fixed.length === 1 ? "fix waiting" : "fixes waiting" },
        ]}
      />
      {stopped && <Note kind="warn">{stopped}</Note>}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ margin: "0 0 4px" }}>
        <tbody>
          {fixed.slice(0, SHOWN).map((title, i) => (
            <tr key={i}>
              <td style={{ borderBottom: "1px solid #f5f5f4", padding: "10px 0" }}>
                <Text style={{ fontSize: 15, lineHeight: "22px", color: colors.text, margin: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: colors.onHighlight, backgroundColor: colors.highlight, borderRadius: 999, padding: "2px 9px", marginRight: 10, whiteSpace: "nowrap" }}>
                  Fix waiting
                </span>{" "}
                {title}
                </Text>
              </td>
            </tr>
          ))}
          {fixed.length > SHOWN && (
            <tr>
              <td style={{ padding: "10px 0" }}>
                <Text style={{ fontSize: 14, color: colors.muted, margin: 0 }}>and {fixed.length - SHOWN} more</Text>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <Buttons href={url} label="Review the fixes" />
    </Layout>
  );
}

export const verifyAllEmail = (props: VerifyAllProps) => ({
  subject: `Verify all: ${articles(props.fixed.length)} out of date`,
  fromName: "Tuti Autopilot",
  body: <VerifyAllEmail {...props} />,
});
