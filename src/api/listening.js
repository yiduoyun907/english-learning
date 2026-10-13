import { requireUser } from '../context.js';
import { readJsonBody, sendOk, httpError } from '../http.js';
import { localStamp } from '../time.js';
import { splitSentences, alignWords } from '../dictation.js';

/** 听力模块：听写材料、逐句比对、练习进度 */

const LEVEL_ORDER = `CASE p.level WHEN 'beginner' THEN 1 WHEN 'intermediate' THEN 2 ELSE 3 END`;

export function registerListeningRoutes(router, { db }) {
  // 可选材料，带该用户的练习进度
  router.get('/api/listening/materials', async (req, res, ctx) => {
    const user = requireUser(ctx);

    const rows = db
      .prepare(
        `SELECT p.slug        AS slug,
                p.title       AS title,
                p.title_zh    AS titleZh,
                p.level       AS level,
                p.topic       AS topic,
                p.content     AS content,
                p.source      AS source,
                p.attribution AS attribution,
                p.source_url  AS sourceUrl,
                COUNT(da.id)  AS attemptCount,
                AVG(da.accuracy) AS avgAccuracy
           FROM passages p
           LEFT JOIN dictation_attempts da ON da.passage_id = p.id AND da.user_id = ?
          WHERE p.source NOT LIKE 'cet%reading'
          GROUP BY p.id
          ORDER BY p.source DESC, ${LEVEL_ORDER}, p.id`
      )
      .all(user.id);

    sendOk(res, {
      materials: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        titleZh: row.titleZh,
        level: row.level,
        topic: row.topic,
        source: row.source,
        attribution: row.attribution,
        sourceUrl: row.sourceUrl,
        sentenceCount: splitSentences(row.content).length,
        attemptCount: row.attemptCount,
        avgAccuracy: row.avgAccuracy === null ? null : row.avgAccuracy,
      })),
    });
  });

  // 单篇材料的句子。原文需一并返回——浏览器 TTS 要拿到文本才能朗读，
  // 界面在提交前不会显示它，提交后由后端比对并返回逐词结果。
  router.get('/api/listening/:slug', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const passage = findMaterial(db, ctx.params.slug);

    const sentences = splitSentences(passage.content);

    // 每句取最近一次成绩
    const latest = new Map();
    const attempts = db
      .prepare(
        `SELECT sentence_index AS idx, accuracy
           FROM dictation_attempts
          WHERE user_id = ? AND passage_id = ?
          ORDER BY id DESC`
      )
      .all(user.id, passage.id);
    for (const row of attempts) {
      if (!latest.has(row.idx)) latest.set(row.idx, row.accuracy);
    }

    sendOk(res, {
      material: {
        slug: passage.slug,
        title: passage.title,
        titleZh: passage.title_zh,
        level: passage.level,
      },
      sentences: sentences.map((text, index) => ({
        index,
        text,
        wordCount: text.split(/\s+/).filter(Boolean).length,
        latestAccuracy: latest.has(index) ? latest.get(index) : null,
      })),
    });
  });

  // 提交一次听写，返回逐词比对结果
  router.post('/api/listening/:slug/attempt', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const passage = findMaterial(db, ctx.params.slug);

    const sentences = splitSentences(passage.content);
    const body = await readJsonBody(req);

    const index = Number(body.sentenceIndex);
    const input = typeof body.input === 'string' ? body.input : '';

    if (!Number.isInteger(index) || index < 0 || index >= sentences.length) {
      throw httpError(400, 'INVALID_SENTENCE', '句子序号无效');
    }
    if (input.trim().length === 0) {
      throw httpError(400, 'EMPTY_INPUT', '请先写下听到的内容');
    }

    const answer = sentences[index];
    const result = alignWords(answer, input);

    db.prepare(
      `INSERT INTO dictation_attempts
         (user_id, passage_id, sentence_index, accuracy, input_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(user.id, passage.id, index, result.accuracy, input.slice(0, 1000), localStamp());

    sendOk(res, {
      sentenceIndex: index,
      accuracy: result.accuracy,
      correctCount: result.correctCount,
      expectedCount: result.expectedCount,
      tokens: result.tokens,
      answer,
    });
  });
}

function findMaterial(db, slug) {
  const passage = db.prepare('SELECT * FROM passages WHERE slug = ?').get(slug);
  if (!passage) throw httpError(404, 'MATERIAL_NOT_FOUND', '听力材料不存在');
  return passage;
}
