import { requireUser } from '../context.js';
import { startOfToday, daysAgoStart, localStamp } from '../time.js';
import { sendOk } from '../http.js';

/** 统计数据接口 */
export function registerStatsRoutes(router, { db }) {
  router.get('/api/stats/overview', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const now = new Date();
    const todayStart = startOfToday(now);

    // 「累计已学」只算真正学过的（reps > 0）；
    // 同名表里还混着「仅加进生词本、没学过」的记录（reps = 0），不能计进去
    const totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN reps > 0 THEN 1 ELSE 0 END)            AS learnedTotal,
           SUM(CASE WHEN state = 'review' AND interval_days >= 21 THEN 1 ELSE 0 END) AS masteredTotal,
           SUM(CASE WHEN source = 'notebook' THEN 1 ELSE 0 END) AS notebookTotal
         FROM user_words WHERE user_id = ?`
      )
      .get(user.id);

    const dueNow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_words
          WHERE user_id = ? AND state <> 'new'
            AND (due_date IS NULL OR due_date <= ?)`
      )
      .get(user.id, now.toISOString()).n;

    const today = db
      .prepare(
        `SELECT
           COUNT(*)                                          AS reviews,
           SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END)      AS correct
         FROM review_logs WHERE user_id = ? AND reviewed_at >= ?`
      )
      .get(user.id, todayStart);

    const learnedToday = db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_words
          WHERE user_id = ? AND created_at >= ? AND reps > 0`
      )
      .get(user.id, todayStart).n;

    const daily = db
      .prepare(
        `SELECT date(reviewed_at) AS day,
                COUNT(*) AS reviews,
                SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) AS correct
           FROM review_logs
          WHERE user_id = ? AND reviewed_at >= ?
          GROUP BY day
          ORDER BY day ASC`
      )
      .all(user.id, daysAgoStart(29, now));

    const reviews = today.reviews || 0;
    const correct = today.correct || 0;

    sendOk(res, {
      today: {
        reviews,
        correct,
        accuracy: reviews > 0 ? Math.round((correct / reviews) * 100) : null,
        learnedToday,
        dueNow,
      },
      totals: {
        learned: totals.learnedTotal || 0,
        mastered: totals.masteredTotal || 0,
        notebook: totals.notebookTotal || 0,
      },
      streakDays: computeStreak(db, user.id, now),
      daily: daily.map((row) => ({
        day: row.day,
        reviews: row.reviews,
        correct: row.correct || 0,
      })),
    });
  });
}

/** 连续打卡天数：今天没学则从昨天起算，避免白天未学习时显示为 0 */
function computeStreak(db, userId, now) {
  const rows = db
    .prepare(
      `SELECT DISTINCT date(reviewed_at) AS day
         FROM review_logs WHERE user_id = ? ORDER BY day DESC`
    )
    .all(userId);

  const studiedDays = new Set(rows.map((row) => row.day));
  if (studiedDays.size === 0) return 0;

  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!studiedDays.has(dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  while (studiedDays.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function dayKey(date) {
  return localStamp(date).slice(0, 10);
}
