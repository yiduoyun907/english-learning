import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast } from './ui.js';

const DAYS_WINDOW = 30;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  mountNav('/stats.html');

  const stats = await api('/api/stats/overview');

  document.getElementById('streak').textContent = stats.streakDays;
  document.getElementById('learned').textContent = stats.totals.learned;
  document.getElementById('mastered').textContent = stats.totals.mastered;
  document.getElementById('notebook').textContent = stats.totals.notebook;

  const accuracy = stats.today.accuracy === null ? '—' : `${stats.today.accuracy}%`;
  document.getElementById('today-line').textContent =
    `复习 ${stats.today.reviews} 次 · 正确率 ${accuracy} · 新学 ${stats.today.learnedToday} 个 · 待复习 ${stats.today.dueNow} 个`;

  renderChart(stats.daily);
}

function renderChart(daily) {
  const reviewByDay = new Map(daily.map((entry) => [entry.day, entry.reviews]));
  const series = [];

  const today = new Date();
  for (let offset = DAYS_WINDOW - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = dayKey(date);
    series.push({ day: key, reviews: reviewByDay.get(key) || 0 });
  }

  const max = Math.max(1, ...series.map((entry) => entry.reviews));
  const chart = document.getElementById('chart');

  chart.replaceChildren();
  for (const entry of series) {
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = `${Math.max(2, Math.round((entry.reviews / max) * 100))}%`;
    bar.title = `${entry.day}：${entry.reviews} 次`;
    chart.appendChild(bar);
  }

  const totalReviews = series.reduce((sum, entry) => sum + entry.reviews, 0);
  const activeDays = series.filter((entry) => entry.reviews > 0).length;
  document.getElementById('chart-hint').textContent =
    `近 ${DAYS_WINDOW} 天共复习 ${totalReviews} 次，其中 ${activeDays} 天有学习记录`;
}

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

main().catch((error) => toast(error.message));
