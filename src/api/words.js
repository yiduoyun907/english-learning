import { requireUser } from '../context.js';
import { readJsonBody, sendOk, httpError } from '../http.js';
import { localStamp } from '../time.js';

/** 查词返回给前端的字段 */
const WORD_FIELDS = `id, headword, phonetic, translation_zh AS translation,
                     definition_en AS definition, pos, exchange, collins, tags`;

/** 词典检索与生词本接口 */
export function registerWordRoutes(router, { db }) {
  // 阅读时点击查词：精确匹配 → 词形索引 → 规则还原，三级兜底
  router.get('/api/words/lookup', async (req, res, ctx) => {
    const user = requireUser(ctx);

    const query = normalizeQuery(ctx.query.get('word'));
    if (!query) throw httpError(400, 'INVALID_WORD', '请提供要查询的单词');

    const result = lookupWord(db, query);
    if (!result) return sendOk(res, { query, word: null });

    const state = db
      .prepare('SELECT source FROM user_words WHERE user_id = ? AND word_id = ?')
      .get(user.id, result.word.id);

    sendOk(res, {
      query,
      word: result.word,
      baseForm: result.baseForm,
      inNotebook: state ? state.source === 'notebook' : false,
      learned: Boolean(state),
    });
  });

  // 模糊检索：单词或中文释义，按词频优先排序
  router.get('/api/words/search', async (req, res, ctx) => {
    requireUser(ctx);

    const keyword = (ctx.query.get('q') || '').trim();
    if (!keyword) return sendOk(res, { words: [] });

    const limit = Math.min(50, Math.max(1, Number(ctx.query.get('limit')) || 20));
    const like = `%${keyword}%`;

    const words = db
      .prepare(
        `SELECT id, headword, phonetic, translation_zh AS translation
           FROM words
          WHERE headword LIKE ? OR translation_zh LIKE ?
          ORDER BY CASE WHEN bnc > 0 THEN bnc ELSE 999999 END ASC
          LIMIT ?`
      )
      .all(like, like, limit);

    sendOk(res, { words });
  });

  // 生词本列表
  router.get('/api/notebook', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const page = Math.max(1, Number(ctx.query.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(ctx.query.get('pageSize')) || 50));

    const words = db
      .prepare(
        `SELECT w.id AS id, w.headword AS headword, w.phonetic AS phonetic,
                w.translation_zh AS translation, uw.state AS state,
                uw.due_date AS dueDate, uw.created_at AS addedAt
           FROM user_words uw
           JOIN words w ON w.id = uw.word_id
          WHERE uw.user_id = ? AND uw.source = 'notebook'
          ORDER BY uw.created_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(user.id, pageSize, (page - 1) * pageSize);

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM user_words WHERE user_id = ? AND source = 'notebook'`)
      .get(user.id).n;

    sendOk(res, { words, page, pageSize, total });
  });

  // 加入 / 移出生词本
  router.post('/api/notebook', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJsonBody(req);

    const wordId = Number(body.wordId);
    const action = body.action === 'remove' ? 'remove' : 'add';

    if (!Number.isInteger(wordId) || wordId <= 0) {
      throw httpError(400, 'INVALID_WORD', '无效的单词 ID');
    }

    const word = db.prepare('SELECT id FROM words WHERE id = ?').get(wordId);
    if (!word) throw httpError(404, 'WORD_NOT_FOUND', '单词不存在');

    if (action === 'add') {
      addToNotebook(db, user.id, wordId);
    } else {
      removeFromNotebook(db, user.id, wordId);
    }

    sendOk(res, { wordId, inNotebook: action === 'add' });
  });
}

/** 加入生词本：已有学习记录则只改来源标记，避免丢失复习进度 */
function addToNotebook(db, userId, wordId) {
  const existing = db
    .prepare('SELECT id, source FROM user_words WHERE user_id = ? AND word_id = ?')
    .get(userId, wordId);

  if (existing) {
    if (existing.source !== 'notebook') {
      db.prepare('UPDATE user_words SET source = ? WHERE id = ?').run('notebook', existing.id);
    }
    return;
  }

  const now = new Date();
  db.prepare(
    `INSERT INTO user_words
       (user_id, word_id, source, state, ease, interval_days, learning_step,
        reps, lapses, due_date, last_review_at, created_at)
     VALUES (?, ?, 'notebook', 'new', 2.5, 0, 0, 0, 0, ?, NULL, ?)`
  ).run(userId, wordId, now.toISOString(), localStamp(now));
}

/**
 * 移出生词本。
 *
 * 从未学过（reps = 0）的记录直接删除 —— 若只是把 source 改回 'book'，
 * 这条记录会被后续的复习队列当成「学过的词」，反而比不移除更糟。
 * 学过的话只清掉生词本标记，保留复习进度。
 */
function removeFromNotebook(db, userId, wordId) {
  const record = db
    .prepare('SELECT reps FROM user_words WHERE user_id = ? AND word_id = ?')
    .get(userId, wordId);

  if (!record) return;

  if (record.reps === 0) {
    db.prepare('DELETE FROM user_words WHERE user_id = ? AND word_id = ?').run(userId, wordId);
    return;
  }

  db.prepare(`UPDATE user_words SET source = 'book' WHERE user_id = ? AND word_id = ?`).run(
    userId,
    wordId
  );
}

/** 去掉首尾非字母字符并转小写，使 "Went," 这类输入也能查到 */
function normalizeQuery(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/g, '');
}

/**
 * 三级查词：精确匹配 → 词形索引 → 常见规则还原。
 * 返回 { word, baseForm }：baseForm 仅在「点到的词本身是独立词条，
 * 但同时也是另一个词的变形」时出现（如 singing 既是名词，也是 sing 的现在分词）。
 */
function lookupWord(db, query) {
  const exact = db.prepare(`SELECT ${WORD_FIELDS} FROM words WHERE headword = ?`).get(query);
  const mapped = findBaseForm(db, query);

  if (exact) {
    const baseForm = mapped && mapped.id !== exact.id ? mapped : null;
    return { word: exact, baseForm };
  }
  if (mapped) return { word: mapped, baseForm: null };

  for (const candidate of guessBaseForms(query)) {
    const guessed = db.prepare(`SELECT ${WORD_FIELDS} FROM words WHERE headword = ?`).get(candidate);
    if (guessed) return { word: guessed, baseForm: null };
  }
  return null;
}

/** 按词形索引查找该变形对应的原形词条 */
function findBaseForm(db, query) {
  const row = db.prepare('SELECT word_id FROM word_forms WHERE form = ?').get(query);
  if (!row) return null;
  return db.prepare(`SELECT ${WORD_FIELDS} FROM words WHERE id = ?`).get(row.word_id);
}

/** 针对词库未收录单词的常见变形，猜几个可能的原形 */
function guessBaseForms(word) {
  const guesses = [];
  const add = (value) => {
    if (value.length >= 2 && value !== word && !guesses.includes(value)) guesses.push(value);
  };

  if (word.endsWith('ies')) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) add(word.slice(0, -2));
  if (word.endsWith('s')) add(word.slice(0, -1));
  if (word.endsWith('ing')) {
    add(word.slice(0, -3));
    add(`${word.slice(0, -3)}e`);
  }
  if (word.endsWith('ed')) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  }
  if (word.endsWith('ly')) add(word.slice(0, -2));
  // 双写辅音结尾：running → runn → run
  if (/([bdfglmnprt])\1$/.test(word)) add(word.slice(0, -1));

  return guesses;
}
