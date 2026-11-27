import { Button } from "@react-email/components";
import type { Doc } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";

import { Message, peopleLanguage, PostCard, type PostStatus } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";
import { EmailRichText } from "./rich-text";

/** How much of the reply the email quotes; the rest is on the post. */
const QUOTED = 1000;

/** `doc` and `mediaUrls` (lasting links): the reply's images, shown under the quoted text. */
type ReplyProps = EmailBrand & {
  authorName: string;
  postTitle: string;
  /** The post's votes, board and status, shown in its card. */
  votes?: number;
  board?: string;
  status?: PostStatus;
  text: string;
  doc?: Doc;
  mediaUrls?: MediaUrls | null;
  postUrl: string;
  unsubscribeUrl: string;
  /** The voter's (readerEmailLanguage), else English; `teamLanguage`: the project's default, the board's name's. */
  language?: string;
  teamLanguage?: string;
};

/** The team's reply to a post, sent to the people who voted for it (Email voters). */
export function ReplyEmail({ projectName, authorName, postTitle, votes, board, status, text, doc, mediaUrls, postUrl, unsubscribeUrl, accent, poweredBy, logo, logoText, language, teamLanguage }: ReplyProps) {
  const t = emailTranslator(language, "emails");
  const quoted = text.length > QUOTED ? `${text.slice(0, QUOTED).trimEnd()}…` : text;
  // A comment's images are top-level blocks (its profile has no lists or quotes to hold one).
  const images = doc?.content?.filter((node) => node.type === "image") ?? [];
  return (
    <Layout
      preview={t("replyPreview", { author: authorName, title: postTitle })}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={t.rich("voterFooter", { name: projectName, link: (chunks) => <FooterLink href={unsubscribeUrl}>{chunks}</FooterLink> })}
      language={language}
    >
      <Eyebrow accent={accent}>{t("replyEyebrow")}</Eyebrow>
      <Title>{t("replyTitle", { author: authorName, name: projectName })}</Title>
      <PostCard title={postTitle} votes={votes} board={board} status={status} language={language} teamLanguage={teamLanguage} />
      {/* An image alone: no empty quote above it. */}
      <Message name={authorName} team={t("teamOf", { name: projectName })} accent={accent} lang={peopleLanguage(language, teamLanguage)}>
        {quoted}
      </Message>
      {images.length > 0 && <EmailRichText doc={{ type: "doc", content: images }} mediaUrls={mediaUrls} linkUrl={postUrl} accent={accent} />}
      <Button
        href={postUrl}
        style={buttonStyle(accent)}
      >
        {t("replyOnPost")}
      </Button>
    </Layout>
  );
}

export const replyEmail = (props: ReplyProps) => ({
  subject: emailTranslator(props.language, "emails")("replySubject", { title: props.postTitle }),
  body: <ReplyEmail {...props} />,
});
