import pg from "pg";

/** `published` published docs articles in the project, and a draft, "One too many" (journeys have no faster way to). */
export async function seedArticles(slug: string, published: number) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO article (id, "projectId", slug, title, "publishedAt", "updatedAt")
       SELECT gen_random_uuid()::text, project.id, 'seeded-' || n, 'Seeded ' || n, now(), now() FROM project, generate_series(1, $2) AS n WHERE project.slug = $1
       UNION ALL SELECT gen_random_uuid()::text, project.id, 'one-too-many', 'One too many', NULL, now() FROM project WHERE project.slug = $1`,
      [slug, published],
    );
  } finally {
    await client.end();
  }
}

/** `views` of the project's article `article` 40 days ago (UTC): in the 30 days before Reporting's default range. */
export async function seedViewsLastMonth(slug: string, article: string, views: number) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO article_view_day ("articleId", day, views)
       SELECT article.id, (now() AT TIME ZONE 'UTC')::date - 40, $3 FROM article JOIN project ON project.id = article."projectId"
       WHERE project.slug = $1 AND article.slug = $2`,
      [slug, article, views],
    );
  } finally {
    await client.end();
  }
}
