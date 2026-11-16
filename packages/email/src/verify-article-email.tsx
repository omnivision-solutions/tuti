import { Text } from "@react-email/components";
import type { DiffLine } from "@tuti/content";

import { Buttons, Diff, Eyebrow, Layout, Stats, textStyle, Title } from "./layout";

type VerifyArticleProps = {
  projectName: string;
  articleTitle: string;
  /** What the run found: statements still true, out of date, and those it couldn't tell. */
  counts: { current: number; outdated: number; unclear: number };
  /** What its fix changes, in a sentence (the model's). */
  reason: string;
  /** What its fix changes, line by line, and the lines left out ("N more lines in Tuti"). */
  diff?: DiffLine[];
  diffMore?: number;
  /** The article's review in Autopilot. */
  url: string;
};

const statements = (count: number) => (count === 1 ? "1 statement" : `${count} statements`);

/** To a project's owners: Verify found an article out of date and wrote its fix, which waits for them (docs/plan.md, V5). */
export function VerifyArticleEmail({ projectName, articleTitle, counts, reason, diff, diffMore, url }: VerifyArticleProps) {
  return (
    <Layout
      preview={`${statements(counts.outdated)} in “${articleTitle}” ${counts.outdated === 1 ? "is" : "are"} out of date. The fix waits for you.`}
      label="Verify"
      footer={
        <>
          Verify&apos;s fixes never go out by themselves. You get this as an owner of {projectName}.
        </>
      }
    >
      <Eyebrow>Help center · Verify</Eyebrow>
      <Title>“{articleTitle}” is out of date</Title>
      <Text style={textStyle}>Verify checked it against your repository, statement by statement.</Text>
      <Stats
        items={[
          { n: counts.current, label: "still true" },
          { n: counts.outdated, label: "out of date" },
          { n: counts.unclear, label: "unclear" },
        ]}
      />
      {reason && <Text style={textStyle}>{reason}</Text>}
      {diff && diff.length > 0 && <Diff lines={diff} more={diffMore} />}
      <Buttons href={url} label="Review the fix" />
    </Layout>
  );
}

export const verifyArticleEmail = (props: VerifyArticleProps) => ({
  subject: `Verify: “${props.articleTitle}” is out of date`,
  fromName: "Tuti Autopilot",
  body: <VerifyArticleEmail {...props} />,
});
