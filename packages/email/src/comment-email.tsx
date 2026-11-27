import { Button, Section, Text } from "@react-email/components";

import { Message, peopleLanguage, PostCard, type PostStatus } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, colors, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";

/** How much of each comment the email quotes; the rest is on the post. */
const QUOTED = 1000;
/** How many comments one email shows; the rest are on the post. */
const SHOWN = 5;

type CommentProps = EmailBrand & {
  postTitle: string;
  voteCount: number;
  status: PostStatus;
  /** Its board's name, over its title. */
  board?: string;
  /** Oldest first, each as plain text; `authorId` tells people apart (two can share a name); `team`: the team's (tagged). */
  comments: { authorId: string; authorName: string; team?: boolean; text: string }[];
  postUrl: string;
  unsubscribeUrl: string;
  /** The post's author's (readerEmailLanguage), else English; `teamLanguage`: the project's default, the board's name's. */
  language?: string;
  teamLanguage?: string;
};

type Translate = ReturnType<typeof emailTranslator<"emails">>;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Who commented (each person once), by first name: "Sam commented…", "Sam and Ada…", "Sam and 2 others…". */
function commented(comments: CommentProps["comments"], t: Translate) {
  const names = [...new Map(comments.map((comment) => [comment.authorId, comment.authorName])).values()].map(firstName);
  return names.length === 1
    ? t("commentedOne", { a: names[0]! })
    : names.length === 2
      ? t("commentedTwo", { a: names[0]!, b: names[1]! })
      : t("commentedMany", { a: names[0]!, count: names.length - 1 });
}

/** Someone else's comments on a post, sent to its author (those that came close together in one email). */
export function CommentEmail({ projectName, accent, poweredBy, logo, logoText, postTitle, voteCount, status, board, comments, postUrl, unsubscribeUrl, language, teamLanguage }: CommentProps) {
  const t = emailTranslator(language, "emails");
  const heading = commented(comments, t);
  const hidden = comments.length - SHOWN;
  return (
    <Layout
      preview={heading}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={t.rich("authorFooter", { name: projectName, link: (chunks) => <FooterLink href={unsubscribeUrl}>{chunks}</FooterLink> })}
      language={language}
    >
      <Eyebrow accent={accent}>{t("commentEyebrow", { count: comments.length })}</Eyebrow>
      <Title>{heading}</Title>
      <PostCard title={postTitle} votes={voteCount} board={board} status={status} language={language} teamLanguage={teamLanguage} />
      {comments.slice(0, SHOWN).map((comment, index) => (
        // An image alone: its writer, no empty quote.
        <Message key={index} name={comment.authorName} team={comment.team ? t("teamOf", { name: projectName }) : undefined} accent={accent} lang={peopleLanguage(language, teamLanguage)}>
          {comment.text.length > QUOTED ? `${comment.text.slice(0, QUOTED).trimEnd()}…` : comment.text || undefined}
        </Message>
      ))}
      {hidden > 0 && (
        <Text style={{ fontSize: 15, color: colors.muted, margin: "12px 0 0" }}>
          {t("moreComments", { count: hidden })}
        </Text>
      )}
      <Section style={{ marginTop: 20 }}>
        <Button href={postUrl} style={buttonStyle(accent)}>
          {t("reply")}
        </Button>
      </Section>
    </Layout>
  );
}

export const commentEmail = (props: CommentProps) => ({
  subject: emailTranslator(props.language, "emails")("commentSubject", { count: props.comments.length, title: props.postTitle }),
  body: <CommentEmail {...props} />,
});
