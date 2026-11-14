import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FEATURES, feature } from "../../features";
import { Ctas, Eyebrow, Final } from "../../landing";
import { CONTENT } from "./content";

/**
 * A feature's page (features.ts, its words and pictures in content.tsx): the home page's look (landing.css) for one part
 * of Tuti. Its hero and product window, what it does as cards of pictures, the features it works with, and the closing
 * call to action.
 */

export const dynamicParams = false;
export const generateStaticParams = () => FEATURES.map(({ slug }) => ({ slug }));

export async function generateMetadata({ params }: PageProps<"/features/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const f = feature(slug);
  return f ? { title: `${f.name} · Tuti`, description: CONTENT[slug].sub } : {};
}

const icon = { "aria-hidden": true, size: 16 } as const;

const seePricing = (
  <Link className="btn btn-s" href="/pricing">
    See pricing
  </Link>
);

export default async function FeaturePage({ params }: PageProps<"/features/[slug]">) {
  const { slug } = await params;
  const f = feature(slug);
  if (!f) notFound();
  const { headline, sub, url, hero, sections, related } = CONTENT[slug];
  return (
    <div data-full className="lp">
      <header className="hero">
        <div className="wrap">
          <Eyebrow icon={<f.icon {...icon} />}>{f.name}</Eyebrow>
          <h1>{headline}</h1>
          <p className="lead">{sub}</p>
          <Ctas secondary={seePricing} />
        </div>
        <div className="frame">
          <div className="win">
            <div className="bar" aria-hidden>
              <div className="dots">
                <i />
                <i />
                <i />
              </div>
              <div className="url">{url}</div>
            </div>
            {hero}
          </div>
        </div>
      </header>
      <section className="bento-s fp">
        <div className="wrap">
          {/* The cards' titles are h3s: a heading over them for screen readers, the pictures saying it on screen. */}
          <h2 className="sr-only">What it does</h2>
          <div className="bento">
            {sections.map(({ title, line, picture, wide, dark }) => (
              <div key={title} className={`cell${wide ? " wide" : ""}${dark ? " c-dark" : ""}`}>
                <h3>{title}</h3>
                <p>{line}</p>
                {picture}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="flush fp-rel">
        <div className="wrap center">
          <h2>Works with the rest of Tuti.</h2>
          <ul className="land">
            {related.map((slug) => {
              const r = feature(slug)!;
              return (
                <li key={slug}>
                  <Link href={`/features/${slug}`} className="chip">
                    <span className="pi">
                      <r.icon aria-hidden size={18} />
                    </span>
                    <b>{r.name}</b>
                    <small>{r.line}</small>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
      <Final title="Try it on your next release." sub="Everything in Tuti, free for 7 days." secondary={seePricing} />
    </div>
  );
}
