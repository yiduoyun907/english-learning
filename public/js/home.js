import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast } from './ui.js';
import { mountTutorOrb } from './tutor-orb.js';

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  mountNav('/index.html');

  document.getElementById('greeting').textContent = `你好，${session.user.username}`;

  const [stats, books, reviewStatus] = await Promise.all([
    api('/api/stats/overview'),
    api('/api/wordbooks'),
    // 复习入口在首页常驻，状态拿不到时不拖垮其余内容
    api('/api/quiz/review/status').catch(() => null),
  ]);

  const activeBook = books.books.find((book) => book.code === books.activeBook);
  const bookLine = document.getElementById('active-book');

  if (activeBook) {
    bookLine.textContent = `${activeBook.name} · 已学 ${activeBook.learnedCount} / ${activeBook.wordCount}`;
  } else {
    bookLine.innerHTML = '尚未选择词书，<a href="/books.html">前往选择</a>';
  }

  document.getElementById('due').textContent = reviewStatus ? reviewStatus.poolSize : '—';
  document.getElementById('learned-today').textContent = stats.today.learnedToday;
  document.getElementById('streak').textContent = stats.streakDays;

  // 每日学习量收进首页，改完即存
  const limitInput = document.getElementById('daily-limit');
  limitInput.value = session.settings.dailyNewLimit;
  limitInput.addEventListener('change', () => saveDailyLimit(limitInput, session, stats, activeBook));

  const hint = document.getElementById('plan-hint');
  updatePlanHint(hint, activeBook, stats.today.learnedToday, session.settings.dailyNewLimit);

  renderReviewEntry(reviewStatus);

  // 助教悬浮球：独立于上面的数据加载，取不到统计数据也不影响它出现
  mountTutorOrb();
}

/** 学习计划的提示文案，改了每日学习量后要重算 */
function updatePlanHint(hint, activeBook, learnedToday, limit) {
  if (!activeBook) {
    hint.textContent = '先选择一本词书，才能开始学习新词';
    return;
  }
  if (learnedToday >= limit) {
    hint.textContent = '今天的量已经学完，明天再来';
    return;
  }
  hint.textContent = `今日已学 ${learnedToday} / ${limit} 个，还可学 ${Math.max(0, limit - learnedToday)} 个`;
}

/** 每日学习量改完即保存；失败则回退到原值 */
async function saveDailyLimit(input, session, stats, activeBook) {
  try {
    const settings = await api('/api/settings', {
      method: 'PUT',
      body: { dailyNewLimit: Number(input.value) },
    });
    session.settings.dailyNewLimit = settings.dailyNewLimit;
    input.value = settings.dailyNewLimit;
    updatePlanHint(document.getElementById('plan-hint'), activeBook, stats.today.learnedToday, settings.dailyNewLimit);
    toast('已更新每日学习量');
  } catch (error) {
    input.value = session.settings.dailyNewLimit;
    toast(error.message);
  }
}

/**
 * 首页的复习入口。复习必须先完成今日校验（后端也会拦），
 * 所以没解锁时按钮直接指向校验页，而不是让用户点进去撞 403。
 */
function renderReviewEntry(status) {
  const hint = document.getElementById('review-hint');
  const action = document.getElementById('review-action');

  if (!status) {
    hint.textContent = '暂时无法获取复习状态';
    action.remove();
    return;
  }

  if (!status.unlocked) {
    hint.textContent = '完成今天的校验后解锁';
    action.href = '/quiz.html';
    action.textContent = '去做今日校验';
    action.classList.add('btn-primary');
    return;
  }

  if (status.poolSize === 0) {
    hint.textContent = '暂无可复习的旧词';
    action.remove();
    return;
  }

  hint.textContent = `共 ${status.poolSize} 个词可复习`;
  action.textContent = '开始复习';
  action.classList.add('btn-primary');
}

main().catch((error) => toast(error.message));
