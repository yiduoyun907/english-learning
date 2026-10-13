import { requireUser, getSettings } from '../context.js';
import { sendOk, httpError } from '../http.js';

/** 词书相关接口：列表与进度 / 词表分页 / 切换当前词书 */
export function registerWordbookRoutes(router, { db }) {
  router.get('/api/wordbooks', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const settings = getSettings(db, user.id);

    const books = db
      .prepare('SELECT code, name, description, word_count FROM wordbooks ORDER BY id')
      .all();

    const learnedRows = db
      .prepare(
        `SELECT wb.code AS code, COUNT(*) AS learned
           FROM user_words uw
           JOIN wordbook_words wbw ON wbw.word_id = uw.word_id
           JOIN wordbooks wb ON wb.id = wbw.wordbook_id
          WHERE uw.user_id = ?
          GROUP BY wb.code`
      )
      .all(user.id);
    const learnedByCode = new Map(learnedRows.map((row) => [row.code, row.learned]));

    sendOk(res, {
      activeBook: settings.activeBook,
      books: books.map((book) => ({
        code: book.code,
        name: book.name,
        description: book.description,
        wordCount: book.word_count,
        learnedCount: learnedByCode.get(book.code) || 0,
      })),
    });
  });

  router.get('/api/wordbooks/:code/words', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const book = db
      .prepare('SELECT id, code, name FROM wordbooks WHERE code = ?')
      .get(ctx.params.code);

    if (!book) throw httpError(404, 'BOOK_NOT_FOUND', '词书不存在');

    const page = Math.max(1, Number(ctx.query.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(ctx.query.get('pageSize')) || 50));

    const rows = db
      .prepare(
        `SELECT w.id AS id, w.headword AS headword, w.phonetic AS phonetic,
                w.translation_zh AS translation, uw.state AS state,
                uw.source AS source
           FROM wordbook_words wbw
           JOIN words w ON w.id = wbw.word_id
           LEFT JOIN user_words uw ON uw.word_id = w.id AND uw.user_id = ?
          WHERE wbw.wordbook_id = ?
          ORDER BY wbw.seq
          LIMIT ? OFFSET ?`
      )
      .all(user.id, book.id, pageSize, (page - 1) * pageSize);

    sendOk(res, {
      book: { code: book.code, name: book.name },
      page,
      pageSize,
      words: rows,
    });
  });

  router.post('/api/wordbooks/:code/select', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const book = db.prepare('SELECT code FROM wordbooks WHERE code = ?').get(ctx.params.code);
    if (!book) throw httpError(404, 'BOOK_NOT_FOUND', '词书不存在');

    db.prepare('UPDATE settings SET active_book = ? WHERE user_id = ?').run(book.code, user.id);
    sendOk(res, { activeBook: book.code });
  });
}
