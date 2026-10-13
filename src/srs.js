/**
 * SM-2 变体的间隔重复调度器。
 *
 * 纯函数、无副作用、不依赖数据库，便于单元测试与将来替换为 FSRS。
 * 评分沿用 Anki 的四档语义：0 忘记 / 3 模糊 / 4 记得 / 5 简单。
 */

export const Rating = {
  AGAIN: 0,
  HARD: 3,
  GOOD: 4,
  EASY: 5,
};

/** 合法评分集合，用于入口校验 */
export const VALID_RATINGS = new Set(Object.values(Rating));

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 新词的学习步（分钟）：先 1 分钟后 10 分钟，走完即毕业进入正式复习 */
const LEARNING_STEPS_MINUTES = [1, 10];

const MIN_EASE = 1.3;
const MAX_INTERVAL_DAYS = 365;

/** 新建一张空白卡片的状态 */
export function createInitialCard(now = new Date()) {
  return {
    state: 'new',
    ease: 2.5,
    interval_days: 0,
    learning_step: 0,
    reps: 0,
    lapses: 0,
    due_date: now.toISOString(),
    last_review_at: null,
  };
}

/**
 * 根据一次评分推进卡片状态。
 * @param {object} card 当前卡片（至少含 state/ease/interval_days/learning_step/reps/lapses）
 * @param {number} rating 四档评分之一
 * @param {Date} now 当前时间
 * @returns {object} 新的卡片状态（不修改入参）
 */
export function schedule(card, rating, now = new Date()) {
  if (!VALID_RATINGS.has(rating)) {
    throw new Error(`非法评分：${rating}`);
  }

  const next = {
    ...card,
    reps: card.reps + 1,
    last_review_at: now.toISOString(),
  };

  if (card.state === 'new' || card.state === 'learning') {
    return scheduleLearning(card, next, rating, now);
  }
  if (card.state === 'relearning') {
    return scheduleRelearning(card, next, rating, now);
  }
  return scheduleReview(card, next, rating, now);
}

/** 学习阶段：按学习步推进，走完最后一步或标记「简单」即毕业 */
function scheduleLearning(card, next, rating, now) {
  if (rating === Rating.AGAIN) {
    next.state = 'learning';
    next.learning_step = 0;
    next.interval_days = 0;
    next.due_date = minutesFrom(now, LEARNING_STEPS_MINUTES[0]);
    return next;
  }

  if (rating === Rating.HARD) {
    const step = Math.min(card.learning_step, LEARNING_STEPS_MINUTES.length - 1);
    next.state = 'learning';
    next.due_date = minutesFrom(now, LEARNING_STEPS_MINUTES[step]);
    return next;
  }

  // GOOD：推进到下一步；已在最后一步则毕业
  const isLastStep = card.learning_step >= LEARNING_STEPS_MINUTES.length - 1;
  if (rating === Rating.EASY || isLastStep) {
    next.state = 'review';
    next.learning_step = 0;
    next.interval_days = rating === Rating.EASY ? 4 : 1;
    next.due_date = daysFrom(now, next.interval_days);
    return next;
  }

  next.state = 'learning';
  next.learning_step = card.learning_step + 1;
  next.due_date = minutesFrom(now, LEARNING_STEPS_MINUTES[next.learning_step]);
  return next;
}

/** 重学阶段：答对即回到正式复习，间隔从原有间隔折半重新起步 */
function scheduleRelearning(card, next, rating, now) {
  if (rating === Rating.AGAIN) {
    next.state = 'relearning';
    next.due_date = minutesFrom(now, LEARNING_STEPS_MINUTES[1]);
    return next;
  }

  const recovered = Math.max(1, Math.round((card.interval_days || 1) * 0.5));
  next.state = 'review';
  next.interval_days = rating === Rating.EASY ? recovered * 2 : recovered;
  next.due_date = daysFrom(now, next.interval_days);
  return next;
}

/** 正式复习阶段：按 ease 因子拉长间隔 */
function scheduleReview(card, next, rating, now) {
  if (rating === Rating.AGAIN) {
    next.state = 'relearning';
    next.lapses = card.lapses + 1;
    next.ease = Math.max(MIN_EASE, card.ease - 0.2);
    next.interval_days = 0;
    next.due_date = minutesFrom(now, LEARNING_STEPS_MINUTES[1]);
    return next;
  }

  let interval;
  if (rating === Rating.HARD) {
    next.ease = Math.max(MIN_EASE, card.ease - 0.15);
    interval = card.interval_days * 1.2;
  } else if (rating === Rating.GOOD) {
    interval = card.interval_days * card.ease;
  } else {
    next.ease = card.ease + 0.15;
    interval = card.interval_days * card.ease * 1.3;
  }

  next.interval_days = clampInterval(interval);
  next.due_date = daysFrom(now, next.interval_days);
  return next;
}

function clampInterval(days) {
  // 保留一位小数，避免出现 0 天导致卡片刚复习就到期
  const safe = Math.max(1, days);
  return Math.min(MAX_INTERVAL_DAYS, Math.round(safe * 10) / 10);
}

function minutesFrom(now, minutes) {
  return new Date(now.getTime() + minutes * MINUTE_MS).toISOString();
}

function daysFrom(now, days) {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}
