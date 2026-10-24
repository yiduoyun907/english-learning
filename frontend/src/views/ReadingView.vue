<script setup>
import { onMounted, ref } from 'vue';

import { showToast } from '../composables/useToast.js';
import { api } from '../lib/api.js';

const LEVEL_LABELS = { beginner: '初级', intermediate: '中级', advanced: '高级' };
const STATUS_TEXT = { completed: '已读完', reading: '读了一部分', unread: '' };

const sections = ref([]);
const loaded = ref(false);

onMounted(async () => {
  try {
    const data = await api('/api/passages');
    render(data.passages);
  } catch (error) {
    showToast(error.message);
  } finally {
    loaded.value = true;
  }
});

function render(passages) {
  const own = passages.filter((item) => item.source === 'original');
  const fiction = passages.filter((item) => item.genre === 'fiction');
  const poems = passages.filter((item) => item.genre === 'poem');
  const essays = passages.filter((item) => item.genre === 'essay');
  const cet = passages.filter((item) => item.source.startsWith('cet'));

  const next = [];
  if (own.length) {
    next.push(buildSection('本站原创短文', '读完可以到「听力」模块做同一篇的听写', own, (item) => item.level, LEVEL_LABELS));
  }
  if (fiction.length) {
    next.push(buildSection('短篇小说', '公版名著 · 点正文里任意单词即可查释义', fiction, (item) => item.level, LEVEL_LABELS));
  }
  if (poems.length) {
    next.push(buildSection('诗歌', '公版诗集 · 篇幅短，适合反复读', poems, (item) => item.level, LEVEL_LABELS));
  }
  if (essays.length) {
    next.push(buildSection('社会与文化', 'VOA 慢速英语 · 非虚构短文', essays, (item) => item.level, LEVEL_LABELS));
  }
  if (cet.length) {
    next.push(
      buildSection(
        '四六级阅读真题',
        '历年真题文章 · 著作权归考试主办方，仅供个人学习使用',
        cet,
        (item) => item.source.replace('cet', '').replace('-reading', '') + '级',
        null
      )
    );
  }

  sections.value = next;
}

function buildSection(title, hint, items, groupKey, labels) {
  const groups = [];

  for (const item of items) {
    const key = groupKey(item);
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, label: (labels && labels[key]) || key, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  return { title, hint, groups };
}

function subheadingStyle(index) {
  return {
    padding: '12px 0 4px',
    borderTop: index > 0 ? '1px solid var(--border)' : 'none',
    marginTop: index > 0 ? '6px' : '0',
  };
}

function subtitle(item) {
  return [item.titleZh, `${item.wordCount} 词`, item.topic].filter(Boolean).join(' · ');
}

function goRead(item) {
  location.href = `/read.html?slug=${encodeURIComponent(item.slug)}`;
}
</script>

<template>
  <main class="container">
    <h1>阅读</h1>
    <p class="muted small">点击正文中任意单词即可查看释义，查过的词可一键加入生词本</p>

    <div id="passage-list" style="margin-top:20px;">
      <div v-if="loaded && sections.length === 0" class="empty">暂无文章</div>

      <template v-for="section in sections" :key="section.title">
        <div class="group-heading">
          <strong>{{ section.title }}</strong>
          <span class="muted small">{{ section.hint }}</span>
        </div>

        <div class="card" style="margin-bottom:20px;">
          <template v-for="(group, index) in section.groups" :key="group.key">
            <div v-if="section.groups.length > 1" class="small muted" :style="subheadingStyle(index)">
              {{ group.label }}
            </div>

            <div
              v-for="item in group.items"
              :key="item.slug"
              class="list-item selectable"
              @click="goRead(item)"
            >
              <div style="flex:1;min-width:0;">
                <div class="row" style="gap:8px;">
                  <strong>{{ item.title }}</strong>
                  <span v-if="STATUS_TEXT[item.status]" class="badge">{{ STATUS_TEXT[item.status] }}</span>
                </div>
                <div class="small muted">{{ subtitle(item) }}</div>
              </div>
              <span class="small muted">阅读</span>
            </div>
          </template>
        </div>
      </template>
    </div>
  </main>
</template>
