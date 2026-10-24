<script setup>
import { onMounted, ref } from 'vue';

import { showToast } from '../composables/useToast.js';
import { api } from '../lib/api.js';

const DAYS_WINDOW = 30;

const streak = ref(0);
const learned = ref(0);
const mastered = ref(0);
const notebook = ref(0);
const todayLine = ref('加载中…');
const bars = ref([]);
const chartHint = ref('');

onMounted(async () => {
  try {
    const stats = await api('/api/stats/overview');

    streak.value = stats.streakDays;
    learned.value = stats.totals.learned;
    mastered.value = stats.totals.mastered;
    notebook.value = stats.totals.notebook;

    const accuracy = stats.today.accuracy === null ? '—' : `${stats.today.accuracy}%`;
    todayLine.value =
      `复习 ${stats.today.reviews} 次 · 正确率 ${accuracy} · 新学 ${stats.today.learnedToday} 个 · 待复习 ${stats.today.dueNow} 个`;

    renderChart(stats.daily);
  } catch (error) {
    showToast(error.message);
  }
});

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

  bars.value = series.map((entry) => ({
    day: entry.day,
    height: `${Math.max(2, Math.round((entry.reviews / max) * 100))}%`,
    title: `${entry.day}：${entry.reviews} 次`,
  }));

  const totalReviews = series.reduce((sum, entry) => sum + entry.reviews, 0);
  const activeDays = series.filter((entry) => entry.reviews > 0).length;
  chartHint.value = `近 ${DAYS_WINDOW} 天共复习 ${totalReviews} 次，其中 ${activeDays} 天有学习记录`;
}

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
</script>

<template>
  <main class="container">
    <h1>统计</h1>

    <div class="stat-grid" style="margin-top:20px;">
      <div class="stat">
        <div class="stat-value" id="streak">{{ streak }}</div>
        <div class="stat-label">连续打卡（天）</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="learned">{{ learned }}</div>
        <div class="stat-label">累计已学</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="mastered">{{ mastered }}</div>
        <div class="stat-label">已掌握</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="notebook">{{ notebook }}</div>
        <div class="stat-label">生词本</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <h2>今日</h2>
      <p class="muted small" id="today-line" style="margin:0;">{{ todayLine }}</p>
    </div>

    <div class="card" style="margin-top:16px;">
      <h2>近 30 天复习量</h2>
      <div class="chart" id="chart">
        <div
          v-for="bar in bars"
          :key="bar.day"
          class="chart-bar"
          :style="{ height: bar.height }"
          :title="bar.title"
        ></div>
      </div>
      <p class="small muted" id="chart-hint" style="margin-bottom:0;">{{ chartHint }}</p>
    </div>
  </main>
</template>
