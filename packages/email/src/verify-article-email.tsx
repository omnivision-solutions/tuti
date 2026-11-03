import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type VerifyArticleProps = {
  projectName: string;
  articleTitle: string;
  /** What the run found: statements still true, out of date, and those it couldn't tell. */
  counts: { current: number; outdated: number; unclear: number };
  /** What its fix changes, in a sentence (the model's). */
  reason: string;
  /** The article's review in Autopilot. */
  url: string;
};

const statements = (count: number) => (count === 1 ? "1 statement" : `${count} statements`);

/** To a project's owners: Verify found an article out of date and wrote its fix, which waits for them (docs/plan.md, V5). */
export function VerifyArticleEmail({ projectName, articleTitle, counts, reason, url }: VerifyArticleProps) {
  return (
    <Layout preview={`${statements(counts.outdated)} in “${articleTitle}” ${counts.outdated === 1 ? "is" : "are"} out of date. The fix waits for you.`} label="Autopilot">
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Verify checked <strong>{articleTitle}</strong> against your repository: {statements(counts.current)} still true,{" "}
        {counts.outdated} out of date{counts.unclear > 0 ? `, ${counts.unclear} it couldn't tell` : ""}.
      </Text>
      {reason && <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>{reason}</Text>}
      <Button href={url} style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}>
        Review the fix
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        Verify&apos;s fixes never go out by themselves. You get this as an owner of {projectName}.
      </Text>
    </Layout>
  );
}

export const verifyArticleEmail = (props: VerifyArticleProps) => ({
  subject: `Verify: “${props.articleTitle}” is out of date`,
  fromName: "Tuti Autopilot",
  body: <VerifyArticleEmail {...props} />,
});
