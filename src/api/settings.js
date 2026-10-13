import { requireUser, getSettings } from '../context.js';
import { readJsonBody, sendOk, httpError } from '../http.js';

const ALLOWED_ACCENTS = new Set(['us', 'uk']);
const ALLOWED_THEMES = new Set(['light', 'dark']);

/** 用户偏好设置接口 */
export function registerSettingsRoutes(router, { db }) {
  router.get('/api/settings', async (req, res, ctx) => {
    const user = requireUser(ctx);
    sendOk(res, getSettings(db, user.id));
  });

  router.put('/api/settings', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJsonBody(req);
    const current = getSettings(db, user.id);

    const dailyNewLimit =
      body.dailyNewLimit === undefined
        ? current.dailyNewLimit
        : clampInt(body.dailyNewLimit, 5, 200, '每日新词上限需为 5-200');

    const reviewLimit =
      body.reviewLimit === undefined
        ? current.reviewLimit
        : clampInt(body.reviewLimit, 10, 500, '复习队列上限需为 10-500');

    const accent = body.accent === undefined ? current.accent : String(body.accent);
    if (!ALLOWED_ACCENTS.has(accent)) {
      throw httpError(400, 'INVALID_ACCENT', '发音口音需为 us 或 uk');
    }

    const theme = body.theme === undefined ? current.theme : String(body.theme);
    if (!ALLOWED_THEMES.has(theme)) {
      throw httpError(400, 'INVALID_THEME', '主题需为 light 或 dark');
    }

    const activeBook = body.activeBook === undefined ? current.activeBook : String(body.activeBook);
    if (activeBook !== null) {
      const book = db.prepare('SELECT code FROM wordbooks WHERE code = ?').get(activeBook);
      if (!book) throw httpError(400, 'INVALID_BOOK', '词书不存在');
    }

    db.prepare(
      `UPDATE settings
          SET daily_new_limit = ?, review_limit = ?, accent = ?, theme = ?, active_book = ?
        WHERE user_id = ?`
    ).run(dailyNewLimit, reviewLimit, accent, theme, activeBook, user.id);

    sendOk(res, getSettings(db, user.id));
  });
}

function clampInt(value, min, max, message) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, 'INVALID_VALUE', message);
  }
  return n;
}
