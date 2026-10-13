import { requireUser } from '../context.js';
import { readJsonBody, sendOk, httpError } from '../http.js';
import { localStamp } from '../time.js';

/** 阅读模块：短文列表、正文、阅读进度 */

const LEVEL_ORDER = `CASE p.level WHEN 'beginner' THEN 1 WHEN 'intermediate' THEN 2 ELSE 3 END`;

export function registerPassageRoutes(router, { db }) {
  router.get('/api/passages', async (req, res, ctx) => {
    const user = requireUser(ctx);

    const passages = db
      .prepare(
        `SELECT p.slug      AS slug,
                p.title     AS title,
                p.title_zh  AS titleZh,
                p.level     AS level,
                p.topic     AS topic,
                p.word_count AS wordCount,
                p.source    AS source,
                p.genre     AS genre,
                p.attribution AS attribution,
                COALESCE(up.status, 'unread') AS status,
                up.completed_at AS completedAt
           FROM passages p
           LEFT JOIN user_passages up ON up.passage_id = p.id AND up.user_id = ?
          WHERE p.source = 'original'
             OR p.source LIKE 'cet%reading'
             OR p.source = 'gutenberg'
             OR (p.source = 'voa' AND p.genre = 'essay')
          ORDER BY CASE p.source
                     WHEN 'original'  THEN 0
                     WHEN 'gutenberg' THEN 1
                     ELSE 2
                   END,
                   ${LEVEL_ORDER}, p.id`
      )
      .all(user.id);

    sendOk(res, { passages });
  });

  router.get('/api/passages/:slug', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const passage = findPassage(db, ctx.params.slug);

    const progress = db
      .prepare(
        `SELECT status, lookup_count AS lookupCount, completed_at AS completedAt
           FROM user_passages WHERE user_id = ? AND passage_id = ?`
      )
      .get(user.id, passage.id);

    sendOk(res, {
      passage: {
        slug: passage.slug,
        title: passage.title,
        titleZh: passage.title_zh,
        level: passage.level,
        topic: passage.topic,
        content: passage.content,
        wordCount: passage.word_count,
      },
      progress: progress || { status: 'unread', lookupCount: 0, completedAt: null },
    });
  });

  // 标记阅读状态（进行中 / 已完成）
  router.post('/api/passages/:slug/progress', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const passage = findPassage(db, ctx.params.slug);

    const body = await readJsonBody(req);
    const status = body.status === 'completed' ? 'completed' : 'reading';
    const now = localStamp();

    db.prepare(
      `INSERT INTO user_passages (user_id, passage_id, status, lookup_count, last_read_at, completed_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(user_id, passage_id) DO UPDATE SET
         status       = excluded.status,
         last_read_at = excluded.last_read_at,
         completed_at = CASE WHEN excluded.completed_at IS NOT NULL
                             THEN excluded.completed_at
                             ELSE user_passages.completed_at END`
    ).run(user.id, passage.id, status, now, status === 'completed' ? now : null);

    sendOk(res, { slug: passage.slug, status });
  });

  // 记录一次查词，用于统计「这篇文章我查了多少词」
  router.post('/api/passages/:slug/lookup', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const passage = findPassage(db, ctx.params.slug);
    const now = localStamp();

    db.prepare(
      `INSERT INTO user_passages (user_id, passage_id, status, lookup_count, last_read_at)
       VALUES (?, ?, 'reading', 1, ?)
       ON CONFLICT(user_id, passage_id) DO UPDATE SET
         lookup_count = user_passages.lookup_count + 1,
         last_read_at = excluded.last_read_at`
    ).run(user.id, passage.id, now);

    const row = db
      .prepare('SELECT lookup_count AS n FROM user_passages WHERE user_id = ? AND passage_id = ?')
      .get(user.id, passage.id);

    sendOk(res, { lookupCount: row.n });
  });
}

function findPassage(db, slug) {
  const passage = db.prepare('SELECT * FROM passages WHERE slug = ?').get(slug);
  if (!passage) throw httpError(404, 'PASSAGE_NOT_FOUND', '文章不存在');
  return passage;
}
