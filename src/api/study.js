import { requireUser, getSettings } from '../context.js';
import { startOfToday, localStamp } from '../time.js';
import { readJsonBody, sendOk, httpError } from '../http.js';
import { schedule, VALID_RATINGS, createInitialCard } from '../srs.js';

/**
 * 卡片对外暴露的字段，复习队列与新词队列共用同一形状。
 *
 * translation 取精简释义（每个词性只留前两个含义），卡片上才不会一次糊上
 * 二十来个义项；词表里还没生成精简版时回落到完整释义。
 * 查词弹窗、生词本仍用完整释义 —— 那两处是「查词典」，要看得全。
 */
const CARD_FIELDS = `
  w.id             AS wordId,
  w.headword       AS headword,
  w.phonetic       AS phonetic,
  COALESCE(NULLIF(w.translation_brief, ''), w.translation_zh) AS translation,
  w.icon           AS icon,
  w.definition_en  AS definition,
  w.pos            AS pos,
  w.exchange       AS exchange,
  w.tags           AS tags,
  w.collins        AS collins,
  uw.state         AS state,
  uw.due_date      AS dueDate,
  uw.ease          AS ease,
  uw.interval_days AS intervalDays,
  uw.reps          AS reps,
  uw.lapses        AS lapses,
  uw.source        AS source
`;

/** 学习相关接口：取今日队列 / 提交评分 */
export function registerStudyRoutes(router, { db }) {
  router.get('/api/study/queue', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const settings = getSettings(db, user.id);

    const limit = clamp(Number(ctx.query.get('limit')) || 20, 1, 100);
    const now = new Date();

    // 只算真正学过的（reps > 0）：仅加进生词本、没学过的词不该占掉今天的新词额度
    const learnedToday = db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_words
          WHERE user_id = ? AND created_at >= ? AND reps > 0`
      )
      .get(user.id, startOfToday(now)).n;

    const newQuota = Math.max(0, settings.dailyNewLimit - learnedToday);

    // 学习池只放新词。
    //
    // 复习一律走复习页的校验式（中写英 / 英选中），两边不再重叠 ——
    // 早先这里还塞了「SRS 到期词」，与复习页的时间驱动池子各取各的，
    // 结果是同一个词在两处被考，而 SRS 的四档自评与校验式作答互不知情。
    const newCards =
      newQuota > 0 && settings.activeBook
        ? selectNewWords(db, user.id, settings.activeBook, Math.min(newQuota, limit))
        : [];

    sendOk(res, {
      cards: newCards.map((card) => ({ ...card, state: 'new', kind: 'new' })),
      counts: {
        fresh: newCards.length,
        learnedToday,
        dailyNewLimit: settings.dailyNewLimit,
        activeBook: settings.activeBook,
      },
    });
  });

  router.post('/api/study/review', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJsonBody(req);

    const wordId = Number(body.wordId);
    const rating = Number(body.rating);
    const elapsedMs = Math.max(0, Number(body.elapsedMs) || 0);

    if (!Number.isInteger(wordId) || wordId <= 0) {
      throw httpError(400, 'INVALID_WORD', '无效的单词 ID');
    }
    if (!VALID_RATINGS.has(rating)) {
      throw httpError(400, 'INVALID_RATING', '无效的评分');
    }

    const word = db.prepare('SELECT id FROM words WHERE id = ?').get(wordId);
    if (!word) throw httpError(404, 'WORD_NOT_FOUND', '单词不存在');

    const now = new Date();
    const existing = db
      .prepare('SELECT * FROM user_words WHERE user_id = ? AND word_id = ?')
      .get(user.id, wordId);

    const currentCard = existing
      ? {
          state: existing.state,
          ease: existing.ease,
          interval_days: existing.interval_days,
          learning_step: existing.learning_step,
          reps: existing.reps,
          lapses: existing.lapses,
          due_date: existing.due_date,
          last_review_at: existing.last_review_at,
        }
      : createInitialCard(now);

    const next = schedule(currentCard, rating, now);

    if (existing) {
      db.prepare(
        `UPDATE user_words
            SET state = ?, ease = ?, interval_days = ?, learning_step = ?,
                reps = ?, lapses = ?, due_date = ?, last_review_at = ?
          WHERE id = ?`
      ).run(
        next.state,
        next.ease,
        next.interval_days,
        next.learning_step,
        next.reps,
        next.lapses,
        next.due_date,
        next.last_review_at,
        existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO user_words
           (user_id, word_id, source, state, ease, interval_days, learning_step,
            reps, lapses, due_date, last_review_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.id,
        wordId,
        'book',
        next.state,
        next.ease,
        next.interval_days,
        next.learning_step,
        next.reps,
        next.lapses,
        next.due_date,
        next.last_review_at,
        localStamp(now)
      );
    }

    db.prepare(
      'INSERT INTO review_logs (user_id, word_id, rating, elapsed_ms, reviewed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(user.id, wordId, rating, elapsedMs, localStamp(now));

    sendOk(res, {
      state: next.state,
      intervalDays: next.interval_days,
      dueDate: next.due_date,
      reps: next.reps,
      lapses: next.lapses,
    });
  });
}

/**
 * 从当前词书中取尚未学过的词，按词频顺序（seq 已按 BNC 重排）。
 *
 * 判「学过」用 reps > 0：仅加进生词本、从没学过的词仍算新词，
 * 否则它们会被永久挡在学习队列之外 —— 学习不给、复习也不考（reps = 0）。
 */
function selectNewWords(db, userId, bookCode, limit) {
  const book = db.prepare('SELECT id FROM wordbooks WHERE code = ?').get(bookCode);
  if (!book) return [];

  return db
    .prepare(
      `SELECT ${CARD_FIELDS}
         FROM wordbook_words wbw
         JOIN words w ON w.id = wbw.word_id
         LEFT JOIN user_words uw ON uw.word_id = w.id AND uw.user_id = ? AND uw.reps > 0
        WHERE wbw.wordbook_id = ? AND uw.id IS NULL
        ORDER BY wbw.seq
        LIMIT ?`
    )
    .all(userId, book.id, limit);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
