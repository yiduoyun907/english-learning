import { httpError } from './http.js';

/** 取得当前登录用户，未登录则抛 401 */
export function requireUser(ctx) {
  if (!ctx.user) {
    throw httpError(401, 'UNAUTHORIZED', '请先登录');
  }
  return ctx.user;
}

/** 读取当前用户的偏好设置，不存在则按默认值补齐 */
export function getSettings(db, userId) {
  const selectFields = 'daily_new_limit, review_limit, accent, theme, active_book';

  let row = db
    .prepare(`SELECT ${selectFields} FROM settings WHERE user_id = ?`)
    .get(userId);

  if (!row) {
    db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(userId);
    row = db.prepare(`SELECT ${selectFields} FROM settings WHERE user_id = ?`).get(userId);
  }

  return {
    dailyNewLimit: row.daily_new_limit,
    reviewLimit: row.review_limit,
    accent: row.accent,
    theme: row.theme,
    activeBook: row.active_book,
  };
}
