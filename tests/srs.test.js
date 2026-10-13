import { test } from 'node:test';
import assert from 'node:assert/strict';

import { schedule, createInitialCard, Rating } from '../src/srs.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** 距离 NOW 多少毫秒到期 */
function dueOffsetMs(card) {
  return new Date(card.due_date).getTime() - NOW.getTime();
}

test('新卡标记「记得」进入学习阶段，10 分钟后到期', () => {
  const next = schedule(createInitialCard(NOW), Rating.GOOD, NOW);

  assert.equal(next.state, 'learning');
  assert.equal(next.reps, 1);
  assert.equal(next.learning_step, 1);
  assert.equal(dueOffsetMs(next), 10 * MINUTE);
});

test('学习阶段再次「记得」毕业，进入正式复习且间隔为 1 天', () => {
  const learning = schedule(createInitialCard(NOW), Rating.GOOD, NOW);
  const graduated = schedule(learning, Rating.GOOD, NOW);

  assert.equal(graduated.state, 'review');
  assert.equal(graduated.interval_days, 1);
  assert.equal(dueOffsetMs(graduated), 1 * DAY);
});

test('新卡标记「简单」直接毕业，间隔为 4 天', () => {
  const next = schedule(createInitialCard(NOW), Rating.EASY, NOW);

  assert.equal(next.state, 'review');
  assert.equal(next.interval_days, 4);
  assert.equal(dueOffsetMs(next), 4 * DAY);
});

test('新卡标记「忘记」停留在学习阶段，1 分钟后重来', () => {
  const next = schedule(createInitialCard(NOW), Rating.AGAIN, NOW);

  assert.equal(next.state, 'learning');
  assert.equal(next.learning_step, 0);
  assert.equal(next.interval_days, 0);
  assert.equal(dueOffsetMs(next), 1 * MINUTE);
});

test('正式复习「记得」按 ease 拉长间隔', () => {
  const card = { state: 'review', ease: 2.5, interval_days: 4, learning_step: 0, reps: 3, lapses: 0 };
  const next = schedule(card, Rating.GOOD, NOW);

  assert.equal(next.state, 'review');
  assert.equal(next.interval_days, 10); // 4 * 2.5
  assert.equal(next.ease, 2.5);
  assert.equal(dueOffsetMs(next), 10 * DAY);
});

test('正式复习「简单」提升 ease 并额外拉长间隔', () => {
  const card = { state: 'review', ease: 2.5, interval_days: 4, learning_step: 0, reps: 3, lapses: 0 };
  const next = schedule(card, Rating.EASY, NOW);

  assert.equal(next.ease, 2.65); // 2.5 + 0.15
  assert.equal(next.interval_days, 13); // 4 * 2.5 * 1.3 = 13
});

test('正式复习「模糊」降低 ease 且间隔只小幅增长', () => {
  const card = { state: 'review', ease: 2.5, interval_days: 10, learning_step: 0, reps: 3, lapses: 0 };
  const next = schedule(card, Rating.HARD, NOW);

  assert.equal(next.ease, 2.35);
  assert.equal(next.interval_days, 12); // 10 * 1.2
});

test('正式复习「忘记」转入重学，lapses 累加且 ease 下降', () => {
  const card = { state: 'review', ease: 2.5, interval_days: 30, learning_step: 0, reps: 5, lapses: 2 };
  const next = schedule(card, Rating.AGAIN, NOW);

  assert.equal(next.state, 'relearning');
  assert.equal(next.lapses, 3);
  assert.equal(next.ease, 2.3);
  assert.equal(next.interval_days, 0);
  assert.equal(dueOffsetMs(next), 10 * MINUTE);
});

test('重学阶段答对回到正式复习，间隔从原间隔折半起步', () => {
  const card = { state: 'relearning', ease: 2.3, interval_days: 30, learning_step: 0, reps: 6, lapses: 3 };
  const next = schedule(card, Rating.GOOD, NOW);

  assert.equal(next.state, 'review');
  assert.equal(next.interval_days, 15); // round(30 * 0.5)
});

test('ease 不会低于下限 1.3', () => {
  let card = { state: 'review', ease: 1.4, interval_days: 5, learning_step: 0, reps: 3, lapses: 0 };
  card = schedule(card, Rating.AGAIN, NOW);
  card = schedule(card, Rating.AGAIN, NOW);
  card = schedule(card, Rating.AGAIN, NOW);

  assert.equal(card.ease, 1.3);
});

test('复习间隔不超过上限 365 天', () => {
  const card = { state: 'review', ease: 3, interval_days: 200, learning_step: 0, reps: 9, lapses: 0 };
  const next = schedule(card, Rating.GOOD, NOW);

  assert.equal(next.interval_days, 365);
});

test('非法评分抛出异常', () => {
  assert.throws(() => schedule(createInitialCard(NOW), 2, NOW), /非法评分/);
});

test('schedule 不修改传入的卡片对象', () => {
  const card = createInitialCard(NOW);
  const snapshot = JSON.stringify(card);
  schedule(card, Rating.GOOD, NOW);

  assert.equal(JSON.stringify(card), snapshot);
});
